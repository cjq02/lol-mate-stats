import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ChampionSummary } from '../lcu/api.js';
import type {
  ArchiveCursor,
  BadLevel,
  ChampionUsage,
  GameModeKey,
  Lane,
  RawGame,
  RawIdentityPlayer,
  RawParticipant,
  RawStats,
} from '../types.js';
import { toNumber } from '../util.js';
import { analyzeParticipant, computeMatchScores, detectLane, matchBestTags } from './analyze.js';
import {
  badLevelLabel,
  badLevelOfScore,
  gameFlagTags,
  gameFlags,
  isRemakeMeta,
  worseBadLevel,
} from './flags.js';
import { queueName } from './constants.js';
import { isAfkLikeRelative, type AfkRelativeStats } from './rating.js';
import { getDb, readMeta, withTransaction, writeMeta } from './store.js';

/** 长期保存的单场战绩（按玩家维度查询） */
export interface ArchivedMatch {
  gameId: number;
  queueId: number;
  queueName: string;
  gameCreation: number;
  gameDuration: number;
  championId: number;
  championName?: string;
  position?: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  damage: number;
  damageTaken: number;
  heal: number;
  vision: number;
  score?: number;
  tags: string[];
}

/** 历史对局查询过滤条件 */
export interface PlayerMatchFilter {
  championId?: number;
  mode?: GameModeKey;
  /** 统计组：aram / arena / solo / flex / normal / sr */
  group?: string;
  /** 游标分页：只取这批对局之前的数据，优先于 offset */
  before?: ArchiveCursor;
}

/** 特殊模式会把英雄 ID 加上 60000（如 60067 → 67），统计和图标都用基础 ID */
const NORMALIZED_CHAMPION_ID =
  'CASE WHEN p.champion_id >= 60000 THEN p.champion_id - 60000 ELSE p.champion_id END';

let archivedIds: Set<number> | undefined;

async function loadArchivedIds(db: Pool): Promise<Set<number>> {
  if (archivedIds) return archivedIds;
  const [rows] = await db.query<RowDataPacket[]>('SELECT game_id FROM matches');
  archivedIds = new Set(rows.map((row) => Number(row.game_id)));
  return archivedIds;
}

function stat(stats: RawStats, key: string): number {
  return toNumber(stats[key]);
}

function playerName(player?: RawIdentityPlayer): string {
  if (!player) return '';
  const gameName = typeof player.gameName === 'string' ? player.gameName : '';
  const tagLine = typeof player.tagLine === 'string' ? player.tagLine : '';
  if (gameName) return tagLine ? `${gameName}#${tagLine}` : gameName;
  return typeof player.summonerName === 'string' ? player.summonerName : '';
}

function isBotPlayer(puuid: string, name: string, summonerId: number): boolean {
  if (!puuid && !summonerId) return true;
  if (/(^|\s)bot$/i.test(name)) return true;
  return /^0{32}$/.test(puuid.replace(/-/g, ''));
}

function parseTagList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((tag) => typeof tag === 'string');
  } catch {
    /* 忽略损坏的 tags */
  }
  return [];
}

/** 逃跑/坑/MVP 标签每次读取时重新推断，避免旧数据里的误判一直保留 */
function stripComputedTags(tags: string[]): string[] {
  return tags.filter(
    (tag) =>
      tag !== 'MVP' &&
      tag !== 'SVP' &&
      !/^(?:自己|队友|对手|敌方)(?:小坑|坑|巨坑|逃跑)$/.test(tag),
  );
}

interface ArchivedParticipant {
  puuid: string | null;
  team_id: number;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  damage: number;
  damage_taken: number;
  heal: number;
  vision: number;
  position: string | null;
  score: number | null;
}

/** 从存档数据重新推断一场对局的坑/逃跑标签（以 puuid 的视角） */
function archivedGameTags(
  puuid: string,
  teamId: number,
  durationSeconds: number,
  storedTags: string | null,
  gameParticipants: ArchivedParticipant[],
): string[] {
  const tags = stripComputedTags(parseTagList(storedTags));
  const remake = isRemakeMeta(durationSeconds);
  if (remake && !tags.includes('重开')) tags.unshift('重开');

  // MVP/SVP 按每队评分最高者重新推断（胜方 MVP、负方 SVP）
  if (!remake) {
    const bestByTeam = new Map<number, ArchivedParticipant>();
    for (const participant of gameParticipants) {
      const score = participant.score === null ? NaN : Number(participant.score);
      if (!Number.isFinite(score)) continue;
      const current = bestByTeam.get(participant.team_id);
      if (!current || score > Number(current.score)) {
        bestByTeam.set(participant.team_id, participant);
      }
    }
    const selfBest = [...bestByTeam.values()].find(
      (participant) => participant.puuid === puuid,
    );
    if (selfBest) tags.unshift(selfBest.win ? 'MVP' : 'SVP');
  }

  const durationMin = durationSeconds / 60;
  const relativeStats: AfkRelativeStats[] = gameParticipants.map((participant) => ({
    durationMin,
    gold: participant.gold,
    damage: participant.damage,
    cs: participant.cs,
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    visionScore: participant.vision,
    position: (participant.position as Lane | null) ?? undefined,
    damageTaken: participant.damage_taken,
    heal: participant.heal,
  }));
  const statsByTeam = new Map<number, AfkRelativeStats[]>();
  gameParticipants.forEach((participant, index) => {
    const stats = relativeStats[index];
    if (!stats) return;
    const list = statsByTeam.get(participant.team_id) ?? [];
    list.push(stats);
    statsByTeam.set(participant.team_id, list);
  });

  let teammateAfk = false;
  let opponentAfk = false;
  for (let index = 0; index < gameParticipants.length; index += 1) {
    const participant = gameParticipants[index];
    const stats = relativeStats[index];
    if (!participant?.puuid || participant.puuid === puuid || !stats) continue;
    const peers = statsByTeam.get(participant.team_id) ?? [];
    if (!isAfkLikeRelative(stats, peers)) continue;
    if (participant.team_id === teamId) teammateAfk = true;
    else opponentAfk = true;
  }

  const selfIndex = gameParticipants.findIndex((participant) => participant.puuid === puuid);
  const self = selfIndex >= 0 ? gameParticipants[selfIndex] : undefined;
  const selfStats = selfIndex >= 0 ? relativeStats[selfIndex] : undefined;
  const selfAfk = Boolean(
    self && selfStats && isAfkLikeRelative(selfStats, statsByTeam.get(self.team_id) ?? []),
  );
  const selfBad =
    !remake && !selfAfk && self
      ? badLevelOfScore(self.score === null ? undefined : Number(self.score))
      : undefined;
  if (selfAfk) {
    if (!tags.includes('自己逃跑')) tags.push('自己逃跑');
  } else if (selfBad) {
    tags.push(`自己${badLevelLabel(selfBad)}`);
  }

  if (teammateAfk && !tags.includes('队友逃跑')) tags.push('队友逃跑');
  if (opponentAfk && !tags.includes('对手逃跑')) tags.push('对手逃跑');

  const worstLevel = (side: 'teammate' | 'opponent'): BadLevel | undefined => {
    let level: BadLevel | undefined;
    for (const participant of gameParticipants) {
      if (!participant.puuid || participant.puuid === puuid) continue;
      const isTeammate = participant.team_id === teamId;
      if (side === 'teammate' ? !isTeammate : isTeammate) continue;
      level = worseBadLevel(
        level,
        badLevelOfScore(
          participant.score === null ? undefined : Number(participant.score),
        ),
      );
    }
    return level;
  };

  if (!remake && !teammateAfk) {
    const level = worstLevel('teammate');
    if (level) tags.push(`队友${badLevelLabel(level)}`);
  }
  if (!remake && !opponentAfk) {
    const level = worstLevel('opponent');
    if (level) tags.push(`敌方${badLevelLabel(level)}`);
  }
  return tags;
}

async function loadParticipantsByGame(
  db: Pool,
  gameIds: number[],
): Promise<Map<number, ArchivedParticipant[]>> {
  const result = new Map<number, ArchivedParticipant[]>();
  if (!gameIds.length) return result;
  const placeholders = gameIds.map(() => '?').join(',');
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT game_id, puuid, team_id, win, kills, deaths, assists, cs, gold, damage, damage_taken, heal, vision, position, score
     FROM match_participants
     WHERE game_id IN (${placeholders})`,
    gameIds,
  );
  for (const row of rows) {
    const gameId = Number(row.game_id);
    const list = result.get(gameId) ?? [];
    list.push({
      puuid: (row.puuid as string | null) ?? null,
      team_id: Number(row.team_id),
      win: Number(row.win) === 1,
      kills: Number(row.kills),
      deaths: Number(row.deaths),
      assists: Number(row.assists),
      cs: Number(row.cs),
      gold: Number(row.gold),
      damage: Number(row.damage),
      damage_taken: Number(row.damage_taken),
      heal: Number(row.heal),
      vision: Number(row.vision),
      position: (row.position as string | null) ?? null,
      score: row.score === null ? null : Number(row.score),
    });
    result.set(gameId, list);
  }
  return result;
}

/**
 * 把完整对局写入 MySQL。重复对局会覆盖参与者数据，不会产生重复行。
 * 只保存结构化字段，不保存原始 LCU JSON，避免数据库膨胀。
 */
export async function archiveGames(
  games: RawGame[],
  championMap: Map<number, ChampionSummary>,
): Promise<void> {
  if (!games.length) return;
  const db = await getDb();
  if (!db) return;

  const known = await loadArchivedIds(db);
  const fresh = games.filter((game) => {
    const gameId = toNumber(game.gameId);
    return (
      gameId > 0 &&
      !known.has(gameId) &&
      (game.participants?.length ?? 0) >= 2
    );
  });
  if (!fresh.length) return;

  const now = Date.now();

  try {
    const done = await withTransaction(async (connection) => {
      const archived: number[] = [];
      for (const game of fresh) {
        const gameId = toNumber(game.gameId);
        const queueId = toNumber(game.queueId);
        const rawDuration = toNumber(game.gameDuration);
        const durationSeconds =
          rawDuration > 100_000 ? Math.round(rawDuration / 1000) : rawDuration;
        const identities = game.participantIdentities ?? [];

        await connection.query(
          `INSERT INTO matches
             (game_id, queue_id, game_mode, game_creation, duration_seconds, archived_at)
           VALUES (?, ?, ?, ?, ?, ?) AS new
           ON DUPLICATE KEY UPDATE
             queue_id = new.queue_id,
             game_mode = new.game_mode,
             game_creation = new.game_creation,
             duration_seconds = new.duration_seconds,
             archived_at = new.archived_at`,
          [
            gameId,
            queueId,
            typeof game.gameMode === 'string' ? game.gameMode : null,
            toNumber(game.gameCreation),
            durationSeconds,
            now,
          ],
        );
        await connection.query('DELETE FROM match_participants WHERE game_id = ?', [gameId]);

        const rows: unknown[][] = [];
        const participants = game.participants ?? [];
        const scoreMap = computeMatchScores(game, championMap);
        const bestTags = matchBestTags(game, scoreMap);
        participants.forEach((participant: RawParticipant, index: number) => {
          const participantId = toNumber(participant.participantId) || index + 1;
          const identity = identities.find(
            (item) => toNumber(item.participantId) === participantId,
          );
          const player = identity?.player;
          const puuid = typeof player?.puuid === 'string' ? player.puuid : '';
          const name = playerName(player);
          const summonerId = toNumber(player?.summonerId);
          const bot = isBotPlayer(puuid, name, summonerId);
          const analyzed = bot
            ? null
            : analyzeParticipant(game, participant, championMap, scoreMap);
          const stats = participant.stats ?? {};
          const championId = toNumber(participant.championId);
          const teamId = toNumber(participant.teamId);
          const flags = gameFlags(game, participantId, championMap, scoreMap);
          const bestTag = bestTags.get(participantId);
          const tags = [
            ...new Set([
              ...(bestTag ? [bestTag] : []),
              ...gameFlagTags(flags),
              ...(analyzed?.tags ?? (bot ? ['人机'] : [])).filter(
                (tag) => tag !== 'MVP' && tag !== 'SVP',
              ),
            ]),
          ].slice(0, 7);

          rows.push([
            gameId,
            participantId,
            bot || !puuid ? null : puuid,
            summonerId || null,
            name || null,
            teamId,
            championId,
            championMap.get(championId)?.name ?? analyzed?.championName ?? null,
            analyzed?.position ?? detectLane(game, participant),
            stats.win === true || stats.win === 1 ? 1 : 0,
            stat(stats, 'kills'),
            stat(stats, 'deaths'),
            stat(stats, 'assists'),
            stat(stats, 'totalMinionsKilled') + stat(stats, 'neutralMinionsKilled') ||
              stat(stats, 'minionsKilled'),
            stat(stats, 'goldEarned'),
            stat(stats, 'totalDamageDealtToChampions'),
            stat(stats, 'totalDamageTaken'),
            stat(stats, 'totalHeal'),
            stat(stats, 'visionScore'),
            bot ? 1 : 0,
            analyzed?.score ?? null,
            JSON.stringify(tags),
          ]);
        });

        if (rows.length) {
          await connection.query(
            `INSERT INTO match_participants
               (game_id, participant_id, puuid, summoner_id, display_name, team_id,
                champion_id, champion_name, \`position\`, win, kills, deaths, assists,
                cs, gold, damage, damage_taken, heal, vision, is_bot, score, tags)
             VALUES ?`,
            [rows],
          );
        }

        archived.push(gameId);
      }
      return archived;
    });
    if (done) for (const gameId of done) known.add(gameId);
  } catch {
    /* 写入失败时保留内存中的 known 不变，下次采集会重试 */
  }
}

export async function isGameArchived(gameId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  return (await loadArchivedIds(db)).has(gameId);
}

/** 批量读取某个玩家在这些对局里的评分 */
export async function getPlayerScores(
  puuid: string,
  gameIds: number[],
): Promise<Map<number, number>> {
  const scores = new Map<number, number>();
  const ids = [...new Set(gameIds.filter((id) => id > 0))];
  const db = await getDb();
  if (!db || !puuid || !ids.length) return scores;

  try {
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT game_id, score FROM match_participants
       WHERE puuid = ? AND score IS NOT NULL AND game_id IN (${placeholders})`,
      [puuid, ...ids],
    );
    for (const row of rows) scores.set(Number(row.game_id), Number(row.score));
  } catch {
    /* 查询失败时按无评分处理 */
  }
  return scores;
}

/** 批量读取某个玩家这些对局里的标签（重新推断坑/逃跑程度） */
export async function getPlayerMatchTags(
  puuid: string,
  gameIds: number[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  const ids = [...new Set(gameIds.filter((id) => id > 0))];
  const db = await getDb();
  if (!db || !puuid || !ids.length) return result;

  try {
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT p.game_id, p.team_id, p.tags, m.duration_seconds
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       WHERE p.puuid = ? AND p.game_id IN (${placeholders})`,
      [puuid, ...ids],
    );
    const participantsByGame = await loadParticipantsByGame(db, ids);
    for (const row of rows) {
      const gameId = Number(row.game_id);
      result.set(
        gameId,
        archivedGameTags(
          puuid,
          Number(row.team_id),
          Number(row.duration_seconds),
          row.tags as string | null,
          participantsByGame.get(gameId) ?? [],
        ),
      );
    }
  } catch {
    /* 查询失败时按无标签处理 */
  }
  return result;
}

export async function countPlayerMatches(
  puuid: string,
  filter: PlayerMatchFilter = {},
): Promise<number> {
  const db = await getDb();
  if (!db || !puuid) return 0;
  const { conditions, params } = playerMatchFilterSql(puuid, filter);
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

export interface PlayerWinRecord {
  games: number;
  wins: number;
  losses: number;
  winRate: number;
}

/** 统计组 → 存档里的队列/位置过滤条件（与 currentQueueGroup 保持一致） */const QUEUE_GROUP_FILTERS: Record<string, string> = {
  aram: "(m.queue_id IN (450, 720) OR p.`position` = 'ARAM')",
  arena: "(m.queue_id IN (1700, 1710) OR p.`position` = 'ARENA')",
  solo: 'm.queue_id = 420',
  flex: 'm.queue_id = 440',
  normal: 'm.queue_id IN (400, 430)',
  sr:
    "(m.queue_id NOT IN (450, 720, 1700, 1710, 420, 440, 400, 430) " +
    "AND COALESCE(p.`position`, '') NOT IN ('ARAM', 'ARENA'))",
};

/** 英雄评分排名按大模式拆分：召唤师峡谷 / 极地大乱斗 / 斗魂竞技场 */
const CHAMPION_MODE_FILTERS: Record<GameModeKey, string> = {
  ARAM: "(m.queue_id IN (450, 720) OR p.`position` = 'ARAM')",
  ARENA:
    "(m.queue_id IN (1700, 1710) OR p.`position` = 'ARENA' OR m.game_mode = 'CHERRY')",
  SR:
    "(m.game_mode IN ('CLASSIC', 'SWIFTPLAY') " +
    "OR m.queue_id IN (400, 420, 430, 440, 890))",
};

/** 组装按玩家 / 英雄 / 模式过滤历史对局的 SQL 条件和参数 */
function playerMatchFilterSql(puuid: string, filter: PlayerMatchFilter = {}) {
  const conditions = ['p.puuid = ?'];
  const params: Array<string | number> = [puuid];
  if (filter.championId) {
    // 特殊模式会存 60000 + 英雄 ID，用 IN 代替 CASE 表达式，才能命中
    // (puuid, champion_id) 复合索引
    conditions.push('p.champion_id IN (?, ?)');
    params.push(filter.championId, filter.championId + 60000);
    // 与英雄平均分排名保持一致：排除训练模式和 5 分钟内的重开局
    conditions.push('m.duration_seconds > 300');
    conditions.push("COALESCE(m.game_mode, '') <> 'PRACTICETOOL'");
  }
  const modeFilter = filter.mode ? CHAMPION_MODE_FILTERS[filter.mode] : undefined;
  if (modeFilter) conditions.push(modeFilter);
  const groupFilter = filter.group ? QUEUE_GROUP_FILTERS[filter.group] : undefined;
  if (groupFilter) conditions.push(groupFilter);
  return { conditions, params };
}

/**
 * 某个玩家在指定统计组 / 指定英雄的总胜负（来自长期存档）。
 * 重开对局不计入，和近期评分的统计口径一致。
 */
export async function getPlayerWinRecord(
  puuid: string,
  group?: string,
  championId?: number,
): Promise<PlayerWinRecord> {
  const db = await getDb();
  if (!db || !puuid) return { games: 0, wins: 0, losses: 0, winRate: 0 };
  const filter = group ? QUEUE_GROUP_FILTERS[group] : undefined;
  if (group && !filter) return { games: 0, wins: 0, losses: 0, winRate: 0 };
  const conditions = ['p.puuid = ?', 'm.duration_seconds > 300'];
  const params: Array<string | number> = [puuid];
  if (filter) conditions.push(filter);
  if (championId) {
    // 与战绩列表保持一致：IN 写法可命中 (puuid, champion_id) 索引
    conditions.push('p.champion_id IN (?, ?)');
    params.push(championId, championId + 60000);
    // 英雄维度同样排除训练模式，和英雄排名/英雄战绩列表保持一致
    conditions.push("COALESCE(m.game_mode, '') <> 'PRACTICETOOL'");
  }
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS games, COALESCE(SUM(p.win = 1), 0) AS wins
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       WHERE ${conditions.join(' AND ')}`,
      params,
    );
    const games = Number(rows[0]?.games ?? 0);
    const wins = Number(rows[0]?.wins ?? 0);
    const losses = Math.max(0, games - wins);
    return {
      games,
      wins,
      losses,
      winRate: games > 0 ? wins / games : 0,
    };
  } catch {
    return { games: 0, wins: 0, losses: 0, winRate: 0 };
  }
}

export interface ChampionScoreSummary {
  championId: number;
  championName: string;
  games: number;
  wins: number;
  winRate: number;
  avgScore: number;
  bestScore: number;
  worstScore: number;
}

/**
 * 某个玩家各英雄的平均单场评分（来自长期存档）。
 * 重开/训练模式不计入，只统计有评分的场次，按平均分从高到低排序。
 * 特殊模式的英雄 ID（如 60067）会归一化到基础英雄 ID（67）。
 */
export async function getPlayerChampionScores(
  puuid: string,
  minGames = 1,
  mode?: GameModeKey,
): Promise<ChampionScoreSummary[]> {
  const db = await getDb();
  if (!db || !puuid) return [];
  const threshold = Math.max(1, Math.trunc(minGames));
  const conditions = [
    'p.puuid = ?',
    'p.score IS NOT NULL',
    'm.duration_seconds > 300',
    "COALESCE(m.game_mode, '') <> 'PRACTICETOOL'",
  ];
  const params: Array<string | number> = [puuid];
  const modeFilter = mode ? CHAMPION_MODE_FILTERS[mode] : undefined;
  if (modeFilter) conditions.push(modeFilter);
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT CASE WHEN p.champion_id >= 60000 THEN p.champion_id - 60000 ELSE p.champion_id END AS champion_id,
              MAX(p.champion_name) AS champion_name,
              COUNT(*) AS games,
              COALESCE(SUM(p.win = 1), 0) AS wins,
              AVG(p.score) AS avg_score,
              MAX(p.score) AS best_score,
              MIN(p.score) AS worst_score
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY CASE WHEN p.champion_id >= 60000 THEN p.champion_id - 60000 ELSE p.champion_id END
       HAVING games >= ?
       ORDER BY avg_score DESC, games DESC`,
      [...params, threshold],
    );
    return rows.map((row) => {
      const games = Number(row.games) || 0;
      const wins = Number(row.wins) || 0;
      return {
        championId: Number(row.champion_id),
        championName: String(row.champion_name ?? ''),
        games,
        wins,
        winRate: games > 0 ? wins / games : 0,
        avgScore: Number(row.avg_score) || 0,
        bestScore: Number(row.best_score) || 0,
        worstScore: Number(row.worst_score) || 0,
      };
    });
  } catch {
    return [];
  }
}

/** 某个玩家的历史评分分布（用于个人基线） */
export interface PlayerHistorySample {
  puuid: string;
  games: number;
  avgScore: number;
  stdDev: number;
}

/** 批量读取多个玩家的历史评分分布，一次查询代替 N 次 */
export async function getPlayerBaselines(
  puuids: string[],
): Promise<Map<string, PlayerHistorySample>> {
  const result = new Map<string, PlayerHistorySample>();
  const ids = [...new Set(puuids.filter(Boolean))];
  const db = await getDb();
  if (!db || !ids.length) return result;

  try {
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT p.puuid,
              COUNT(*) AS games,
              AVG(p.score) AS avg_score,
              STDDEV_POP(p.score) AS std_dev
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       WHERE p.puuid IN (${placeholders})
         AND p.score IS NOT NULL
         AND m.duration_seconds > 300
       GROUP BY p.puuid`,
      ids,
    );
    for (const row of rows) {
      const puuid = String(row.puuid ?? '');
      if (!puuid) continue;
      result.set(puuid, {
        puuid,
        games: Number(row.games) || 0,
        avgScore: Number(row.avg_score) || 0,
        stdDev: Number(row.std_dev) || 0,
      });
    }
  } catch {
    /* 查询失败时按无基线处理 */
  }
  return result;
}

/**
 * 批量读取“某个玩家在指定英雄上的历史表现”。
 * 入参是玩家 + 英雄组合，一次查询用 OR 分组，避免 10 名玩家各查一次。
 */
export async function getPlayerChampionUsages(
  entries: Array<{ puuid: string; championId: number }>,
): Promise<Map<string, ChampionUsage>> {
  const result = new Map<string, ChampionUsage>();
  const unique = new Map<string, { puuid: string; championId: number }>();
  for (const entry of entries) {
    if (!entry.puuid || !entry.championId) continue;
    unique.set(`${entry.puuid}:${entry.championId}`, entry);
  }
  const list = [...unique.values()];
  const db = await getDb();
  if (!db || !list.length) return result;

  try {
    const groups: string[] = [];
    const params: Array<string | number> = [];
    for (const entry of list) {
      groups.push('(p.puuid = ? AND p.champion_id IN (?, ?))');
      params.push(entry.puuid, entry.championId, entry.championId + 60000);
    }
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT p.puuid,
              ${NORMALIZED_CHAMPION_ID} AS champion_id,
              MAX(p.champion_name) AS champion_name,
              COUNT(*) AS games,
              COALESCE(SUM(p.win = 1), 0) AS wins,
              AVG(p.score) AS avg_score,
              MAX(p.score) AS best_score
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       WHERE (${groups.join(' OR ')})
         AND p.score IS NOT NULL
         AND m.duration_seconds > 300
         AND COALESCE(m.game_mode, '') <> 'PRACTICETOOL'
       GROUP BY p.puuid, ${NORMALIZED_CHAMPION_ID}`,
      params,
    );
    for (const row of rows) {
      const puuid = String(row.puuid ?? '');
      const championId = Number(row.champion_id);
      if (!puuid || !championId) continue;
      const games = Number(row.games) || 0;
      const wins = Number(row.wins) || 0;
      result.set(`${puuid}:${championId}`, {
        championId,
        games,
        wins,
        winRate: games > 0 ? wins / games : 0,
        avgScore: Number(row.avg_score) || 0,
        bestScore: Number(row.best_score) || 0,
      });
    }
  } catch {
    /* 查询失败时按无英雄数据处理 */
  }
  return result;
}

export async function getPlayerMatches(
  puuid: string,
  limit: number,
  offset: number,
  filter: PlayerMatchFilter = {},
): Promise<{ games: ArchivedMatch[]; nextCursor?: ArchiveCursor }> {
  const db = await getDb();
  if (!db || !puuid) return { games: [] };
  const { conditions, params } = playerMatchFilterSql(puuid, filter);
  let effectiveOffset = offset;
  if (filter.before) {
    // 用上一页最后一局做游标：同秒开局时再用 gameId 兜底排序
    conditions.push(
      '(m.game_creation < ? OR (m.game_creation = ? AND m.game_id < ?))',
    );
    params.push(filter.before.gameCreation, filter.before.gameCreation, filter.before.gameId);
    effectiveOffset = 0;
  }
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT m.game_id, m.queue_id, m.game_creation, m.duration_seconds,
              p.team_id, p.champion_id, p.champion_name, p.position, p.win,
              p.kills, p.deaths, p.assists, p.cs, p.gold, p.damage,
              p.damage_taken, p.heal, p.vision, p.score, p.tags
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.game_creation DESC, m.game_id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, effectiveOffset],
    );

    const gameIds = [...new Set(rows.map((row) => Number(row.game_id)))];
    const participantsByGame = await loadParticipantsByGame(db, gameIds);
    const lastRow = rows[rows.length - 1];
    const nextCursor =
      rows.length >= limit && lastRow
        ? {
            gameCreation: Number(lastRow.game_creation),
            gameId: Number(lastRow.game_id),
          }
        : undefined;

    const games = rows.map((row) => {
      const gameId = Number(row.game_id);
      const tags = archivedGameTags(
        puuid,
        Number(row.team_id),
        Number(row.duration_seconds),
        row.tags as string | null,
        participantsByGame.get(gameId) ?? [],
      );
      return {
        gameId,
        queueId: Number(row.queue_id),
        queueName: queueName(Number(row.queue_id)),
        gameCreation: Number(row.game_creation),
        gameDuration: Number(row.duration_seconds),
        championId:
          Number(row.champion_id) >= 60000
            ? Number(row.champion_id) - 60000
            : Number(row.champion_id),
        championName: row.champion_name ?? undefined,
        position: row.position ?? undefined,
        win: Number(row.win) === 1,
        kills: Number(row.kills),
        deaths: Number(row.deaths),
        assists: Number(row.assists),
        cs: Number(row.cs),
        gold: Number(row.gold),
        damage: Number(row.damage),
        damageTaken: Number(row.damage_taken),
        heal: Number(row.heal),
        vision: Number(row.vision),
        score: row.score === null ? undefined : Number(row.score),
        tags,
      };
    });
    return { games, nextCursor };
  } catch {
    return { games: [] };
  }
}

export async function saveSelfPuuid(puuid: string): Promise<void> {
  if (!puuid) return;
  await writeMeta('selfPuuid', puuid);
}

export async function getSavedSelfPuuid(): Promise<string | undefined> {
  return readMeta('selfPuuid');
}
