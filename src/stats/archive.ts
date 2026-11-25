import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ChampionSummary } from '../lcu/api.js';
import type {
  AnalyzedGame,
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
  afkParticipantIds,
  badLevelLabel,
  badLevelOfScore,
  gameFlagTags,
  gameFlags,
  isRemakeMeta,
  MILD_BAD_GAME_SCORE,
  worseBadLevel,
} from './flags.js';
import { queueName } from './constants.js';
import { capAfkScores, isAfkLikeRelative, type AfkRelativeStats } from './rating.js';
import { championProficiency } from './proficiency.js';
import { getDb, getSavedMatchTimeline, readMeta, saveTimelineAfkStats, withTransaction, writeMeta } from './store.js';
import {
  buildChampionRadar,
  buildTypeRadar,
  summarizeChampionItems,
  summarizeTimeStats,
  type ChampionRadarEntry,
  type TypeRadarEntry,
  type TypeRadarSample,
  type TimeStatsSummary,
} from './time-stats.js';

/** 长期保存的单场战绩（按玩家维度查询） */
export interface ArchivedMatch {
  gameId: number;
  queueId: number;
  queueName: string;
  /** 结算接口保存的 gameMode（CLASSIC / ARAM / CHERRY 等） */
  gameMode?: string;
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
  /** 本局在该场有评分玩家中的排名；同分并列 */
  rank?: number;
  /** 参与排名的玩家数 */
  rankTotal?: number;
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

/** 重开/逃跑/坑/MVP 标签每次读取时重新推断，避免旧数据里的误判一直保留 */
function stripComputedTags(tags: string[]): string[] {
  return tags.filter(
    (tag) =>
      tag !== '重开' &&
      tag !== 'MVP' &&
      tag !== 'SVP' &&
      !/^(?:自己|队友|对手|敌方)(?:小坑|很坑|坑|巨坑|逃跑)$/.test(tag),
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
  /** 时间线里连续无成长的最长秒数，旧数据为 null */
  idle_streak_seconds: number | null;
  /** 时间线里累计无成长的秒数，旧数据为 null */
  idle_alive_seconds: number | null;
  /** 时间线里连续原地不动的最长秒数，旧数据为 null */
  stationary_streak_seconds: number | null;
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
    idleStreakSeconds:
      participant.idle_streak_seconds === null
        ? undefined
        : participant.idle_streak_seconds,
    idleAliveSeconds:
      participant.idle_alive_seconds === null
        ? undefined
        : participant.idle_alive_seconds,
    stationaryStreakSeconds:
      participant.stationary_streak_seconds === null
        ? undefined
        : participant.stationary_streak_seconds,
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
    !remake && self
      ? badLevelOfScore(self.score === null ? undefined : Number(self.score))
      : undefined;
  if (selfAfk) {
    if (!tags.includes('自己逃跑')) tags.push('自己逃跑');
  }
  if (selfBad) {
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

  if (!remake) {
    const level = worstLevel('teammate');
    if (level) tags.push(`队友${badLevelLabel(level)}`);
  }
  if (!remake) {
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
    `SELECT game_id, puuid, team_id, win, kills, deaths, assists, cs, gold, damage, damage_taken, heal, vision, position, score, idle_streak_seconds, idle_alive_seconds, stationary_streak_seconds
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
      idle_streak_seconds:
        row.idle_streak_seconds === null || row.idle_streak_seconds === undefined
          ? null
          : Number(row.idle_streak_seconds),
      idle_alive_seconds:
        row.idle_alive_seconds === null || row.idle_alive_seconds === undefined
          ? null
          : Number(row.idle_alive_seconds),
      stationary_streak_seconds:
        row.stationary_streak_seconds === null ||
        row.stationary_streak_seconds === undefined
          ? null
          : Number(row.stationary_streak_seconds),
    });
    result.set(gameId, list);
  }
  return result;
}

/** 一场对局里某个玩家的评分排名，只统计有评分的玩家；同分并列 */
function participantRank(
  participants: ArchivedParticipant[],
  puuid: string,
): { rank: number; total: number } | undefined {
  const scored = participants.filter(
    (participant) => participant.score !== null && Number.isFinite(Number(participant.score)),
  );
  const self = scored.find((participant) => participant.puuid === puuid);
  if (!self || self.score === null || scored.length < 2) return undefined;
  const selfScore = Number(self.score);
  const better = scored.filter((participant) => Number(participant.score) > selfScore).length;
  return { rank: better + 1, total: scored.length };
}

/** 批量读取某个玩家这些对局里的评分排名，用于战绩列表 */
export async function getPlayerMatchRanks(
  puuid: string,
  gameIds: number[],
): Promise<Map<number, { rank: number; total: number }>> {
  const result = new Map<number, { rank: number; total: number }>();
  const ids = [...new Set(gameIds.filter((id) => id > 0))];
  const db = await getDb();
  if (!db || !puuid || !ids.length) return result;
  try {
    const participantsByGame = await loadParticipantsByGame(db, ids);
    for (const [gameId, participants] of participantsByGame) {
      const rank = participantRank(participants, puuid);
      if (rank) result.set(gameId, rank);
    }
  } catch {
    /* 排名读取失败不影响战绩列表 */
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
        const rawScores = computeMatchScores(game, championMap);
        const afkIds = afkParticipantIds(game, championMap, rawScores);
        const scoreMap = capAfkScores(rawScores, afkIds);
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
            stat(stats, 'item0'),
            stat(stats, 'item1'),
            stat(stats, 'item2'),
            stat(stats, 'item3'),
            stat(stats, 'item4'),
            stat(stats, 'item5'),
            stat(stats, 'item6'),
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
                cs, gold, damage, damage_taken, heal, vision,
                item0, item1, item2, item3, item4, item5, item6,
                is_bot, score, tags)
             VALUES ?`,
            [rows],
          );
        }

        archived.push(gameId);
      }
      return archived;
    });
    if (done) {
      for (const gameId of done) known.add(gameId);
      // 如果时间线先于存档写入，补一次“无成长存活时长”，避免参与者行被重建后丢失
      await Promise.all(
        done.map(async (gameId) => {
          const timeline = await getSavedMatchTimeline(gameId);
          if (timeline) await saveTimelineAfkStats(timeline);
        }),
      );
    }
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
  ranked: 'm.queue_id IN (420, 440)',
  bot:
    'm.queue_id IN (800, 801, 810, 820, 830, 831, 832, 840, 841, 842, ' +
    '850, 851, 852, 860, 861, 862, 865, 870, 880, 890, 891, 893, 894)',
  swift: 'm.queue_id = 480',
  practice: "(m.queue_id = 3140 OR m.game_mode = 'PRACTICETOOL')",
  sr:
    "(m.queue_id NOT IN (450, 720, 1700, 1710, 420, 440, 400, 430) " +
    "AND COALESCE(p.`position`, '') NOT IN ('ARAM', 'ARENA'))",
};

/** 英雄评分排名按大模式拆分：召唤师峡谷 / 极地大乱斗 / 斗魂竞技场 */
function championModeFilterSql(
  mode: GameModeKey,
  matchAlias = 'm',
  playerAlias = 'p',
): string {
  if (mode === 'ARAM') {
    return `(${matchAlias}.queue_id IN (450, 720) OR ${playerAlias}.\`position\` = 'ARAM')`;
  }
  if (mode === 'ARENA') {
    return `(${matchAlias}.queue_id IN (1700, 1710) OR ${playerAlias}.\`position\` = 'ARENA' OR ${matchAlias}.game_mode = 'CHERRY')`;
  }
  return (
    `(${matchAlias}.game_mode IN ('CLASSIC', 'SWIFTPLAY') ` +
    `OR ${matchAlias}.queue_id IN (400, 420, 430, 440, 890))`
  );
}

const CHAMPION_MODE_FILTERS: Record<GameModeKey, string> = {
  ARAM: championModeFilterSql('ARAM'),
  ARENA: championModeFilterSql('ARENA'),
  SR: championModeFilterSql('SR'),
};

/** 每个英雄只保留最近 N 次出场；range 为空或 0 时不限制 */
function championAppearanceWindow(range: number | undefined): {
  rankColumn: string;
  filter: string;
  params: number[];
} {
  if (!range || range <= 0) return { rankColumn: '', filter: '', params: [] };
  return {
    rankColumn: `ROW_NUMBER() OVER (
              PARTITION BY CASE WHEN p.champion_id >= 60000 THEN p.champion_id - 60000 ELSE p.champion_id END
              ORDER BY MAX(m.game_creation) DESC, p.game_id DESC
            ) AS appearance_rank`,
    filter: 'WHERE r.appearance_rank <= ?',
    params: [Math.trunc(range)],
  };
}

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

/**
 * 某个玩家按一天内时段统计的胜率和坑率（来自长期存档）。
 * 只读取每场的时间、胜负、标签、位置、英雄和双方评分，避免把上千场的
 * 全部参与者反复拉进内存；坑线按当前阈值重新判断，不依赖旧 tags。
 */
export async function getPlayerTimeStats(
  puuid: string,
  mode?: GameModeKey,
): Promise<TimeStatsSummary> {
  const db = await getDb();
  if (!db || !puuid) return summarizeTimeStats([]);
  const conditions = [
    'p.puuid = ?',
    'm.duration_seconds > 300',
    "COALESCE(m.game_mode, '') <> 'PRACTICETOOL'",
  ];
  // SELECT 里有两个坑线参数，之后才是 WHERE 里的 puuid
  const params: Array<string | number> = [
    MILD_BAD_GAME_SCORE,
    MILD_BAD_GAME_SCORE,
    puuid,
  ];
  const modeFilter = mode ? CHAMPION_MODE_FILTERS[mode] : undefined;
  if (modeFilter) conditions.push(modeFilter);
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT m.game_creation, p.win, p.tags, p.position, p.champion_id, p.score,
              MAX(CASE WHEN p.score IS NOT NULL AND p.score < ? THEN 1 ELSE 0 END) AS self_bad_score,
              MAX(CASE
                    WHEN q.puuid IS NOT NULL
                     AND q.puuid <> p.puuid
                     AND q.score IS NOT NULL
                     AND q.score < ?
                    THEN 1 ELSE 0
                  END) AS teammate_bad_score
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       LEFT JOIN match_participants q
         ON q.game_id = p.game_id AND q.team_id = p.team_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY m.game_creation, p.game_id, p.win, p.tags, p.position, p.champion_id, p.score`,
      params,
    );
    return summarizeTimeStats(
      rows.map((row) => ({
        gameCreation: Number(row.game_creation),
        win: Number(row.win) === 1,
        tags: parseTagList(row.tags as string | null),
        position:
          row.position === null || row.position === undefined
            ? undefined
            : String(row.position),
        championId: Number(row.champion_id) || 0,
        score:
          row.score === null || row.score === undefined
            ? undefined
            : Number(row.score),
        selfBad: Number(row.self_bad_score) === 1,
        teammateBad: Number(row.teammate_bad_score) === 1,
      })),
    );
  } catch {
    return summarizeTimeStats([]);
  }
}

/** 六角星对比缓存：全服平均值变化很慢，5 分钟内复用，避免每次点开都扫全表 */
const TYPE_RADAR_CACHE_TTL_MS = 5 * 60_000;
const typeRadarCache = new Map<string, { at: number; types: TypeRadarEntry[] }>();

/**
 * 按英雄官方主分类汇总“我”和“所有玩家”的六项数据。
 * 每个英雄先在 SQL 里算出平均值，再按场次加权合并到类型，避免单个英雄样本过大。
 */
export async function getPlayerTypeRadar(
  puuid: string,
  mode?: GameModeKey,
): Promise<TypeRadarEntry[]> {
  const db = await getDb();
  if (!db || !puuid) return [];
  const cacheKey = `${puuid}:${mode ?? 'ALL'}`;
  const cached = typeRadarCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TYPE_RADAR_CACHE_TTL_MS) {
    return cached.types;
  }

  const conditions = [
    'p.puuid IS NOT NULL',
    'p.champion_id IS NOT NULL',
    'm.duration_seconds > 300',
    "COALESCE(m.game_mode, '') <> 'PRACTICETOOL'",
  ];
  const modeFilter = mode ? CHAMPION_MODE_FILTERS[mode] : undefined;
  if (modeFilter) conditions.push(modeFilter);

  // self_games 一次 + 六项 self 平均值各一次，共 7 个 puuid 参数
  const params: Array<string | number> = new Array(7).fill(puuid);
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT ${NORMALIZED_CHAMPION_ID} AS champion_id,
              COUNT(*) AS all_games,
              SUM(p.puuid = ?) AS self_games,
              AVG((p.kills + p.assists) / GREATEST(1, tk.team_kills) * 100) AS all_kp,
              AVG(CASE WHEN p.puuid = ?
                       THEN (p.kills + p.assists) / GREATEST(1, tk.team_kills) * 100
                  END) AS self_kp,
              AVG(p.gold / (m.duration_seconds / 60)) AS all_gpm,
              AVG(CASE WHEN p.puuid = ?
                       THEN p.gold / (m.duration_seconds / 60)
                  END) AS self_gpm,
              AVG((p.kills + p.assists) / GREATEST(1, p.deaths)) AS all_kda,
              AVG(CASE WHEN p.puuid = ?
                       THEN (p.kills + p.assists) / GREATEST(1, p.deaths)
                  END) AS self_kda,
              AVG(p.damage_taken / (m.duration_seconds / 60)) AS all_dtpm,
              AVG(CASE WHEN p.puuid = ?
                       THEN p.damage_taken / (m.duration_seconds / 60)
                  END) AS self_dtpm,
              AVG(p.damage / (m.duration_seconds / 60)) AS all_dpm,
              AVG(CASE WHEN p.puuid = ?
                       THEN p.damage / (m.duration_seconds / 60)
                  END) AS self_dpm,
              AVG(p.heal / (m.duration_seconds / 60)) AS all_hpm,
              AVG(CASE WHEN p.puuid = ?
                       THEN p.heal / (m.duration_seconds / 60)
                  END) AS self_hpm
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       JOIN (
         SELECT game_id, team_id, SUM(kills) AS team_kills
         FROM match_participants
         GROUP BY game_id, team_id
       ) tk ON tk.game_id = p.game_id AND tk.team_id = p.team_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY ${NORMALIZED_CHAMPION_ID}`,
      params,
    );
    const samples: TypeRadarSample[] = rows.map((row) => ({
      championId: Number(row.champion_id) || 0,
      allGames: Number(row.all_games) || 0,
      selfGames: Number(row.self_games) || 0,
      all: {
        kp: Number(row.all_kp) || 0,
        gpm: Number(row.all_gpm) || 0,
        kda: Number(row.all_kda) || 0,
        dtpm: Number(row.all_dtpm) || 0,
        dpm: Number(row.all_dpm) || 0,
        hpm: Number(row.all_hpm) || 0,
      },
      self: {
        kp: Number(row.self_kp) || 0,
        gpm: Number(row.self_gpm) || 0,
        kda: Number(row.self_kda) || 0,
        dtpm: Number(row.self_dtpm) || 0,
        dpm: Number(row.self_dpm) || 0,
        hpm: Number(row.self_hpm) || 0,
      },
    }));
    const types = buildTypeRadar(samples);
    typeRadarCache.set(cacheKey, { at: Date.now(), types });
    return types;
  } catch {
    return [];
  }
}

/** 单个英雄的六角星缓存，key 带上英雄 ID 和筛选条件 */
const championRadarCache = new Map<string, { at: number; radar: ChampionRadarEntry | null }>();

export interface ChampionRadarOptions {
  /** 只统计评分 >= 该值的对局；0 表示不限制 */
  minScore?: number;
  /** 我的样本最多取最近多少场；0 表示全部 */
  selfLimit?: number;
  /** 所有玩家的样本最多取最近多少场；0 表示全部 */
  allLimit?: number;
}

/**
 * 某个英雄上“我”和“所有玩家”的六项指标 + 胜率/平均分/平均排名对比。
 * 分数过滤和最近 N 场会同时作用于双方，保证比较口径一致。
 */
export async function getPlayerChampionRadar(
  puuid: string,
  championId: number,
  mode?: GameModeKey,
  options: ChampionRadarOptions = {},
): Promise<ChampionRadarEntry | null> {
  const db = await getDb();
  const id = Number(championId) || 0;
  if (!db || !puuid || !id) return null;
  const minScore = Math.max(
    0,
    Math.min(100, Math.trunc(Number(options.minScore) || 0)),
  );
  const selfLimit = Math.max(
    0,
    Math.min(5000, Math.trunc(Number(options.selfLimit) || 0)),
  );
  const allLimit = Math.max(
    0,
    Math.min(5000, Math.trunc(Number(options.allLimit) || 0)),
  );
  const cacheKey = `${puuid}:${mode ?? 'ALL'}:champion:${id}:min:${minScore}:self:${selfLimit}:all:${allLimit}`;
  const cached = championRadarCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TYPE_RADAR_CACHE_TTL_MS) {
    return cached.radar;
  }

  const baseConditions = [
    'p.score IS NOT NULL',
    'p.champion_id IN (?, ?)',
    'm.duration_seconds > 300',
    "COALESCE(m.game_mode, '') <> 'PRACTICETOOL'",
    'p.puuid IS NOT NULL',
  ];
  const modeFilter = mode ? CHAMPION_MODE_FILTERS[mode] : undefined;
  if (modeFilter) baseConditions.push(modeFilter);
  if (minScore > 0) baseConditions.push('p.score >= ?');

  const buildQuery = (selfOnly: boolean, limit: number) => {
    const conditions = [...baseConditions];
    const params: Array<string | number> = [id, id + 60000];
    if (minScore > 0) params.push(minScore);
    if (selfOnly) {
      conditions.push('p.puuid = ?');
      params.push(puuid);
    }
    const limitSql = limit > 0 ? 'LIMIT ?' : '';
    if (limit > 0) params.push(limit);
    return {
      sql: `SELECT COUNT(*) AS games,
                   COALESCE(SUM(x.win = 1), 0) AS wins,
                   AVG(x.score) AS avg_score,
                   AVG(x.game_rank) AS avg_rank,
                   AVG(x.kp) AS kp,
                   AVG(x.gpm) AS gpm,
                   AVG(x.kda) AS kda,
                   AVG(x.dtpm) AS dtpm,
                   AVG(x.dpm) AS dpm,
                   AVG(x.hpm) AS hpm
            FROM (
              SELECT p.game_id, p.win, p.score,
                     (p.kills + p.assists) / GREATEST(1, tk.team_kills) * 100 AS kp,
                     p.gold / (m.duration_seconds / 60) AS gpm,
                     (p.kills + p.assists) / GREATEST(1, p.deaths) AS kda,
                     p.damage_taken / (m.duration_seconds / 60) AS dtpm,
                     p.damage / (m.duration_seconds / 60) AS dpm,
                     p.heal / (m.duration_seconds / 60) AS hpm,
                     1 + (SELECT COUNT(*)
                          FROM match_participants q
                          WHERE q.game_id = p.game_id
                            AND q.score IS NOT NULL
                            AND q.score > p.score) AS game_rank
              FROM match_participants p
              JOIN matches m ON m.game_id = p.game_id
              JOIN (
                SELECT game_id, team_id, SUM(kills) AS team_kills
                FROM match_participants
                GROUP BY game_id, team_id
              ) tk ON tk.game_id = p.game_id AND tk.team_id = p.team_id
              WHERE ${conditions.join(' AND ')}
              ORDER BY m.game_creation DESC, p.game_id DESC, p.participant_id DESC
              ${limitSql}
            ) x`,
      params,
    };
  };

  const buildItemQuery = (selfOnly: boolean, limit: number) => {
    const conditions = [...baseConditions];
    const params: Array<string | number> = [id, id + 60000];
    if (minScore > 0) params.push(minScore);
    if (selfOnly) {
      conditions.push('p.puuid = ?');
      params.push(puuid);
    }
    const limitSql = limit > 0 ? 'LIMIT ?' : '';
    if (limit > 0) params.push(limit);
    return {
      sql: `SELECT p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6
            FROM match_participants p
            JOIN matches m ON m.game_id = p.game_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY m.game_creation DESC, p.game_id DESC, p.participant_id DESC
            ${limitSql}`,
      params,
    };
  };

  try {
    const selfQuery = buildQuery(true, selfLimit);
    const allQuery = buildQuery(false, allLimit);
    const selfItemQuery = buildItemQuery(true, selfLimit);
    const allItemQuery = buildItemQuery(false, allLimit);
    const [[selfRows], [allRows], [selfItemRows], [allItemRows]] = await Promise.all([
      db.query<RowDataPacket[]>(selfQuery.sql, selfQuery.params),
      db.query<RowDataPacket[]>(allQuery.sql, allQuery.params),
      db.query<RowDataPacket[]>(selfItemQuery.sql, selfItemQuery.params),
      db.query<RowDataPacket[]>(allItemQuery.sql, allItemQuery.params),
    ]);
    const selfRow = selfRows[0];
    const allRow = allRows[0];
    const selfGames = Number(selfRow?.games) || 0;
    const allGames = Number(allRow?.games) || 0;
    if (!allGames) {
      championRadarCache.set(cacheKey, { at: Date.now(), radar: null });
      return null;
    }
    const sample: TypeRadarSample = {
      championId: id,
      allGames,
      selfGames,
      all: {
        kp: Number(allRow?.kp) || 0,
        gpm: Number(allRow?.gpm) || 0,
        kda: Number(allRow?.kda) || 0,
        dtpm: Number(allRow?.dtpm) || 0,
        dpm: Number(allRow?.dpm) || 0,
        hpm: Number(allRow?.hpm) || 0,
      },
      self: {
        kp: Number(selfRow?.kp) || 0,
        gpm: Number(selfRow?.gpm) || 0,
        kda: Number(selfRow?.kda) || 0,
        dtpm: Number(selfRow?.dtpm) || 0,
        dpm: Number(selfRow?.dpm) || 0,
        hpm: Number(selfRow?.hpm) || 0,
      },
    };
    const radar = buildChampionRadar(sample, id, {
      self: {
        games: selfGames,
        winRate: selfGames ? (Number(selfRow?.wins) || 0) / selfGames : 0,
        avgScore: Number(selfRow?.avg_score) || 0,
        avgRank: Number(selfRow?.avg_rank) || 0,
      },
      all: {
        games: allGames,
        winRate: (Number(allRow?.wins) || 0) / allGames,
        avgScore: Number(allRow?.avg_score) || 0,
        avgRank: Number(allRow?.avg_rank) || 0,
      },
    });
    const toItemIds = (rows: RowDataPacket[]) =>
      rows.map((row) =>
        Array.from({ length: 7 }, (_, slot) => Number(row[`item${slot}`]) || 0),
      );
    radar.items = summarizeChampionItems(
      toItemIds(selfItemRows),
      toItemIds(allItemRows),
    );
    championRadarCache.set(cacheKey, { at: Date.now(), radar });
    return radar;
  } catch {
    return null;
  }
}

export interface ChampionOverallRecord {
  championId: number;
  championName: string;
  games: number;
  wins: number;
  winRate: number;
  avgScore: number;
  avgRank: number;
  /** 该英雄的全体场次 / 当前模式全体场次 */
  pickRate: number;
}

const CHAMPION_OVERALL_CACHE_TTL_MS = 5 * 60_000;
const championOverallPartCache = new Map<
  string,
  { at: number; record: ChampionOverallRecord | null }
>();
const championOverallTotalCache = new Map<string, { at: number; total: number }>();

/** 指定英雄集合的全体数据；只查当前榜单里的英雄，避免默认视图扫全表 */
export async function getChampionOverallScores(
  championIds: number[],
  mode?: GameModeKey,
  range?: number,
): Promise<Map<number, ChampionOverallRecord>> {
  const result = new Map<number, ChampionOverallRecord>();
  const ids = [
    ...new Set(championIds.filter((id) => Number.isFinite(id) && id > 0)),
  ];
  const db = await getDb();
  if (!db || !ids.length) return result;

  const now = Date.now();
  const missing: number[] = [];
  for (const id of ids) {
    const key = `${mode ?? 'ALL'}:${range ?? 0}:${id}`;
    const cached = championOverallPartCache.get(key);
    if (cached && now - cached.at < CHAMPION_OVERALL_CACHE_TTL_MS) {
      if (cached.record) result.set(id, cached.record);
    } else {
      missing.push(id);
    }
  }
  if (!missing.length) return result;

  const placeholders = missing.flatMap(() => ['?', '?']).join(',');
  const window = championAppearanceWindow(range);
  const params: Array<string | number> = [
    ...missing,
    ...missing.map((id) => id + 60000),
    ...window.params,
  ];
  const conditions = [
    `p.champion_id IN (${placeholders})`,
    'p.score IS NOT NULL',
    'm.duration_seconds > 300',
    "COALESCE(m.game_mode, '') <> 'PRACTICETOOL'",
    'p.puuid IS NOT NULL',
  ];
  const modeFilter = mode ? CHAMPION_MODE_FILTERS[mode] : undefined;
  if (modeFilter) conditions.push(modeFilter);

  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT CASE WHEN r.champion_id >= 60000 THEN r.champion_id - 60000 ELSE r.champion_id END AS champion_id,
              MAX(r.champion_name) AS champion_name,
              COUNT(*) AS games,
              COALESCE(SUM(r.win = 1), 0) AS wins,
              AVG(r.score) AS avg_score,
              AVG(r.game_rank) AS avg_rank
       FROM (
         SELECT p.game_id, p.champion_id, p.champion_name, p.score, p.win,
                1 + COUNT(q.game_id) AS game_rank${
                  window.rankColumn ? `,\n                ${window.rankColumn}` : ''
                }
         FROM match_participants p
         JOIN matches m ON m.game_id = p.game_id
         LEFT JOIN match_participants q
           ON q.game_id = p.game_id AND q.score IS NOT NULL AND q.score > p.score
         WHERE ${conditions.join(' AND ')}
         GROUP BY p.game_id, p.champion_id, p.champion_name, p.score, p.win
       ) r
       ${window.filter}
       GROUP BY CASE WHEN r.champion_id >= 60000 THEN r.champion_id - 60000 ELSE r.champion_id END`,
      params,
    );
    const found = new Set<number>();
    for (const row of rows) {
      const championId = Number(row.champion_id);
      if (!championId) continue;
      const games = Number(row.games) || 0;
      const wins = Number(row.wins) || 0;
      const record: ChampionOverallRecord = {
        championId,
        championName: String(row.champion_name ?? ''),
        games,
        wins,
        winRate: games > 0 ? wins / games : 0,
        avgScore: Number(row.avg_score) || 0,
        avgRank: Number(row.avg_rank) || 0,
        pickRate: 0,
      };
      result.set(championId, record);
      championOverallPartCache.set(`${mode ?? 'ALL'}:${range ?? 0}:${championId}`, {
        at: now,
        record,
      });
      found.add(championId);
    }
    for (const id of missing) {
      if (!found.has(id)) {
        championOverallPartCache.set(`${mode ?? 'ALL'}:${range ?? 0}:${id}`, {
          at: now,
          record: null,
        });
      }
    }
  } catch {
    /* 查询失败时按无整体数据降级，不影响个人榜单 */
  }
  return result;
}

/** 当前模式下所有玩家的总出场数，用作登场率分母；range > 0 时每个英雄只算最近 N 次出场 */
export async function getChampionOverallTotal(
  mode?: GameModeKey,
  range?: number,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const capped = Boolean(range && range > 0);
  const key = `${mode ?? 'ALL'}:${range ?? 0}`;
  const cached = championOverallTotalCache.get(key);
  if (cached && Date.now() - cached.at < CHAMPION_OVERALL_CACHE_TTL_MS) {
    return cached.total;
  }
  const conditions = [
    'p.score IS NOT NULL',
    'm.duration_seconds > 300',
    "COALESCE(m.game_mode, '') <> 'PRACTICETOOL'",
    'p.puuid IS NOT NULL',
  ];
  const modeFilter = mode ? CHAMPION_MODE_FILTERS[mode] : undefined;
  if (modeFilter) conditions.push(modeFilter);
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      capped
        ? `SELECT COALESCE(SUM(LEAST(c.games, ?)), 0) AS total
           FROM (
             SELECT COUNT(*) AS games
             FROM match_participants p
             JOIN matches m ON m.game_id = p.game_id
             WHERE ${conditions.join(' AND ')}
             GROUP BY CASE WHEN p.champion_id >= 60000 THEN p.champion_id - 60000 ELSE p.champion_id END
           ) c`
        : `SELECT COUNT(*) AS total
           FROM match_participants p
           JOIN matches m ON m.game_id = p.game_id
           WHERE ${conditions.join(' AND ')}`,
      capped ? [Math.trunc(range as number)] : [],
    );
    const total = Number(rows[0]?.total) || 0;
    championOverallTotalCache.set(key, { at: Date.now(), total });
    return total;
  } catch {
    return 0;
  }
}


const championOverallAllCache = new Map<
  string,
  { at: number; totalGames: number; champions: ChampionOverallRecord[] }
>();

/**
 * 指定模式下“所有玩家”在每个英雄上的场次、胜率、平均分、平均排名和登场率。
 * 结果按模式缓存 5 分钟，切换“我的英雄 / 所有英雄”时不再重复扫全表。
 */
export async function getAllChampionOverallScores(
  mode?: GameModeKey,
  range?: number,
): Promise<{ totalGames: number; champions: ChampionOverallRecord[] }> {
  const db = await getDb();
  if (!db) return { totalGames: 0, champions: [] };
  const cacheKey = `${mode ?? 'ALL'}:${range ?? 0}`;
  const cached = championOverallAllCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CHAMPION_OVERALL_CACHE_TTL_MS) {
    return { totalGames: cached.totalGames, champions: cached.champions };
  }

  const conditions = [
    'p.score IS NOT NULL',
    'm.duration_seconds > 300',
    "COALESCE(m.game_mode, '') <> 'PRACTICETOOL'",
    'p.puuid IS NOT NULL',
  ];
  const modeFilter = mode ? CHAMPION_MODE_FILTERS[mode] : undefined;
  if (modeFilter) conditions.push(modeFilter);
  const window = championAppearanceWindow(range);
  const params: Array<string | number> = [...window.params];

  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT CASE WHEN r.champion_id >= 60000 THEN r.champion_id - 60000 ELSE r.champion_id END AS champion_id,
              MAX(r.champion_name) AS champion_name,
              COUNT(*) AS games,
              COALESCE(SUM(r.win = 1), 0) AS wins,
              AVG(r.score) AS avg_score,
              AVG(r.game_rank) AS avg_rank
       FROM (
         SELECT p.game_id, p.champion_id, p.champion_name, p.score, p.win,
                1 + COUNT(q.game_id) AS game_rank${
                  window.rankColumn ? `,\n                ${window.rankColumn}` : ''
                }
         FROM match_participants p
         JOIN matches m ON m.game_id = p.game_id
         LEFT JOIN match_participants q
           ON q.game_id = p.game_id AND q.score IS NOT NULL AND q.score > p.score
         WHERE ${conditions.join(' AND ')}
         GROUP BY p.game_id, p.champion_id, p.champion_name, p.score, p.win
       ) r
       ${window.filter}
       GROUP BY CASE WHEN r.champion_id >= 60000 THEN r.champion_id - 60000 ELSE r.champion_id END`,
      params,
    );
    const totalGames = rows.reduce((sum, row) => sum + (Number(row.games) || 0), 0);
    const champions = rows
      .map((row) => {
        const championId = Number(row.champion_id);
        if (!championId) return null;
        const games = Number(row.games) || 0;
        const wins = Number(row.wins) || 0;
        return {
          championId,
          championName: String(row.champion_name ?? ''),
          games,
          wins,
          winRate: games > 0 ? wins / games : 0,
          avgScore: Number(row.avg_score) || 0,
          avgRank: Number(row.avg_rank) || 0,
          pickRate: totalGames > 0 ? games / totalGames : 0,
        } satisfies ChampionOverallRecord;
      })
      .filter((record): record is ChampionOverallRecord => record !== null)
      .sort((a, b) => b.games - a.games || b.avgScore - a.avgScore);
    championOverallAllCache.set(cacheKey, {
      at: Date.now(),
      totalGames,
      champions,
    });
    return { totalGames, champions };
  } catch {
    return { totalGames: 0, champions: [] };
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
  /** 平均单场排名（把双方 10 人放在一起算） */
  avgRank: number;
  /** 综合熟练度 0-100（场次经验 + 表现分 × 样本置信度） */
  proficiency: number;
  /** 所有玩家的同英雄数据，用于对比 */
  overall?: {
    games: number;
    winRate: number;
    avgScore: number;
    avgRank: number;
    /** 该英雄的全体场次 / 当前模式全体场次 */
    pickRate: number;
  };
}

/**
 * 某个玩家各英雄的平均单场评分（来自长期存档）。
 * 重开/训练模式不计入，只统计有评分的场次，按平均分从高到低排序。
 * 特殊模式的英雄 ID（如 60067）会归一化到基础英雄 ID（67）。
 * range > 0 时每个英雄只取最近 N 次出场。
 */
export async function getPlayerChampionScores(
  puuid: string,
  minGames = 1,
  mode?: GameModeKey,
  range?: number,
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
  const modeFilter = mode ? CHAMPION_MODE_FILTERS[mode] : undefined;
  if (modeFilter) conditions.push(modeFilter);
  const window = championAppearanceWindow(range);
  const params: Array<string | number> = [puuid, ...window.params];
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT CASE WHEN r.champion_id >= 60000 THEN r.champion_id - 60000 ELSE r.champion_id END AS champion_id,
              MAX(r.champion_name) AS champion_name,
              COUNT(*) AS games,
              COALESCE(SUM(r.win = 1), 0) AS wins,
              AVG(r.score) AS avg_score,
              MAX(r.score) AS best_score,
              MIN(r.score) AS worst_score,
              AVG(r.game_rank) AS avg_rank
       FROM (
         SELECT p.game_id, p.champion_id, p.champion_name, p.score, p.win,
                1 + COUNT(q.game_id) AS game_rank${
                  window.rankColumn ? `,\n                ${window.rankColumn}` : ''
                }
         FROM match_participants p
         JOIN matches m ON m.game_id = p.game_id
         LEFT JOIN match_participants q
           ON q.game_id = p.game_id AND q.score IS NOT NULL AND q.score > p.score
         WHERE ${conditions.join(' AND ')}
         GROUP BY p.game_id, p.champion_id, p.champion_name, p.score, p.win
       ) r
       ${window.filter}
       GROUP BY CASE WHEN r.champion_id >= 60000 THEN r.champion_id - 60000 ELSE r.champion_id END
       HAVING games >= ?
       ORDER BY avg_score DESC, games DESC`,
      [...params, threshold],
    );
    return rows.map((row) => {
      const games = Number(row.games) || 0;
      const wins = Number(row.wins) || 0;
      const winRate = games > 0 ? wins / games : 0;
      const avgScore = Number(row.avg_score) || 0;
      const bestScore = Number(row.best_score) || 0;
      return {
        championId: Number(row.champion_id),
        championName: String(row.champion_name ?? ''),
        games,
        wins,
        winRate,
        avgScore,
        bestScore,
        worstScore: Number(row.worst_score) || 0,
        avgRank: Number(row.avg_rank) || 0,
        proficiency: championProficiency({ games, winRate, avgScore, bestScore }),
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

/** 某个英雄在指定模式下的整体 / 个人战绩 */
export interface ChampionModeRecord {
  championId: number;
  games: number;
  wins: number;
  winRate: number;
  avgScore: number;
}

/**
 * 批量统计这些英雄在指定模式下的胜率。
 * 传 puuid 时只统计这名玩家；不传时统计本地存档里的所有玩家。
 */
export async function getChampionModeRecords(
  championIds: number[],
  mode: GameModeKey,
  puuid?: string,
): Promise<Map<number, ChampionModeRecord>> {
  const result = new Map<number, ChampionModeRecord>();
  const ids = [...new Set(championIds.filter((id) => Number.isFinite(id) && id > 0))];
  const db = await getDb();
  if (!db || !ids.length) return result;

  const placeholders = ids.flatMap(() => ['?', '?']).join(',');
  const params: Array<string | number> = [];
  const conditions = [`p.champion_id IN (${placeholders})`];
  // 特殊模式的英雄 ID 会存成 60000 + 基础 ID
  params.push(...ids, ...ids.map((id) => id + 60000));
  conditions.push('p.score IS NOT NULL');
  conditions.push('m.duration_seconds > 300');
  conditions.push("COALESCE(m.game_mode, '') <> 'PRACTICETOOL'");
  conditions.push('p.puuid IS NOT NULL');
  if (puuid) {
    conditions.push('p.puuid = ?');
    params.push(puuid);
  }
  conditions.push(CHAMPION_MODE_FILTERS[mode]);

  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT ${NORMALIZED_CHAMPION_ID} AS champion_id,
              COUNT(*) AS games,
              COALESCE(SUM(p.win = 1), 0) AS wins,
              AVG(p.score) AS avg_score
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY ${NORMALIZED_CHAMPION_ID}`,
      params,
    );
    for (const row of rows) {
      const championId = Number(row.champion_id);
      if (!championId) continue;
      const games = Number(row.games) || 0;
      const wins = Number(row.wins) || 0;
      result.set(championId, {
        championId,
        games,
        wins,
        winRate: games > 0 ? wins / games : 0,
        avgScore: Number(row.avg_score) || 0,
      });
    }
  } catch {
    /* 查询失败时按无数据处理 */
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
      `SELECT m.game_id, m.queue_id, m.game_mode, m.game_creation, m.duration_seconds,
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
      const participants = participantsByGame.get(gameId) ?? [];
      const tags = archivedGameTags(
        puuid,
        Number(row.team_id),
        Number(row.duration_seconds),
        row.tags as string | null,
        participants,
      );
      const rank = participantRank(participants, puuid);
      return {
        gameId,
        queueId: Number(row.queue_id),
        queueName: queueName(Number(row.queue_id)),
        gameMode: row.game_mode ? String(row.game_mode) : undefined,
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
        rank: rank?.rank,
        rankTotal: rank?.total,
        tags,
      };
    });
    return { games, nextCursor };
  } catch {
    return { games: [] };
  }
}

/** 存档里的位置字段统一成 AnalyzedGame 使用的 Lane */
function archiveLane(position: unknown): Lane {
  switch (String(position ?? '').toUpperCase()) {
    case 'TOP':
      return 'TOP';
    case 'JUNGLE':
      return 'JUNGLE';
    case 'MIDDLE':
    case 'MID':
      return 'MID';
    case 'BOTTOM':
    case 'ADC':
      return 'ADC';
    case 'UTILITY':
    case 'SUPPORT':
      return 'SUPPORT';
    case 'ARAM':
      return 'ARAM';
    case 'ARENA':
      return 'ARENA';
    default:
      return 'UNKNOWN';
  }
}

/**
 * 从长期存档补出最近战绩，供实时接口失败或样本不足时回退。
 * 用窗口函数一次算出队伍总伤害/总承伤/总击杀，避免额外查询。
 */
export async function getPlayerRecentAnalyzedGames(
  puuid: string,
  limit: number,
  filter: PlayerMatchFilter = {},
): Promise<AnalyzedGame[]> {
  const db = await getDb();
  if (!db || !puuid) return [];
  const { conditions, params } = playerMatchFilterSql(puuid, filter);
  conditions.push('p.score IS NOT NULL');
  conditions.push('m.duration_seconds > 300');
  conditions.push("COALESCE(m.game_mode, '') <> 'PRACTICETOOL'");
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 10));
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
       LIMIT ?`,
      [...params, safeLimit],
    );
    if (!rows.length) return [];

    // 只针对这几场查队伍汇总，避免窗口函数把整张表都算一遍
    const gameIds = [...new Set(rows.map((row) => Number(row.game_id)))];
    const placeholders = gameIds.map(() => '?').join(',');
    const [teamRows] = await db.query<RowDataPacket[]>(
      `SELECT game_id, team_id,
              SUM(damage) AS team_damage,
              SUM(damage_taken) AS team_damage_taken,
              SUM(kills) AS team_kills
       FROM match_participants
       WHERE game_id IN (${placeholders})
       GROUP BY game_id, team_id`,
      gameIds,
    );
    const teamTotals = new Map<
      string,
      { damage: number; damageTaken: number; kills: number }
    >();
    for (const row of teamRows) {
      teamTotals.set(`${Number(row.game_id)}:${Number(row.team_id)}`, {
        damage: Number(row.team_damage) || 0,
        damageTaken: Number(row.team_damage_taken) || 0,
        kills: Number(row.team_kills) || 0,
      });
    }

    return rows.flatMap((row): AnalyzedGame[] => {
      const score = Number(row.score);
      if (!Number.isFinite(score)) return [];
      // 分均数据用精确时长，展示用的 durationMin 取整，避免前端出现 17.3333 分钟
      const rawDurationMin = (Number(row.duration_seconds) || 0) / 60;
      const durationMin = Math.round(rawDurationMin);
      const kills = Number(row.kills) || 0;
      const deaths = Number(row.deaths) || 0;
      const assists = Number(row.assists) || 0;
      const cs = Number(row.cs) || 0;
      const gold = Number(row.gold) || 0;
      const damage = Number(row.damage) || 0;
      const damageTaken = Number(row.damage_taken) || 0;
      const heal = Number(row.heal) || 0;
      const vision = Number(row.vision) || 0;
      const team =
        teamTotals.get(`${Number(row.game_id)}:${Number(row.team_id)}`) ?? {
          damage: 0,
          damageTaken: 0,
          kills: 0,
        };
      const championId = Number(row.champion_id) || 0;
      return [
        {
          gameId: Number(row.game_id),
          queueId: Number(row.queue_id),
          queueName: queueName(Number(row.queue_id)),
          gameCreation: Number(row.game_creation),
          durationMin,
          championId: championId >= 60000 ? championId - 60000 : championId,
          championName: String(row.champion_name ?? ''),
          win: Number(row.win) === 1,
          kills,
          deaths,
          assists,
          kda: (kills + assists) / Math.max(1, deaths),
          cs,
          csPerMin: rawDurationMin > 0 ? cs / rawDurationMin : 0,
          gold,
          damage,
          heal,
          damageShare: team.damage > 0 ? damage / team.damage : 0,
          damagePerMin: rawDurationMin > 0 ? damage / rawDurationMin : 0,
          tankShare: team.damageTaken > 0 ? damageTaken / team.damageTaken : 0,
          killParticipation: team.kills > 0 ? (kills + assists) / team.kills : 0,
          visionScore: vision,
          visionPerMin: rawDurationMin > 0 ? vision / rawDurationMin : 0,
          position: archiveLane(row.position),
          score,
          tags: parseTagList(row.tags as string | null),
        },
      ];
    });
  } catch {
    return [];
  }
}

export async function saveSelfPuuid(puuid: string): Promise<void> {
  if (!puuid) return;
  await writeMeta('selfPuuid', puuid);
}

export async function getSavedSelfPuuid(): Promise<string | undefined> {
  return readMeta('selfPuuid');
}
