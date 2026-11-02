import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ChampionSummary } from '../lcu/api.js';
import type {
  BadLevel,
  Lane,
  RawGame,
  RawIdentityPlayer,
  RawParticipant,
  RawStats,
} from '../types.js';
import { toNumber } from '../util.js';
import { analyzeParticipant, detectLane } from './analyze.js';
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

/** 逃跑/坑标签每次读取时重新推断，避免旧数据里的误判一直保留 */
function stripComputedTags(tags: string[]): string[] {
  return tags.filter(
    (tag) => !/^(?:自己|队友|对手|敌方)(?:小坑|坑|巨坑|逃跑)$/.test(tag),
  );
}

interface ArchivedParticipant {
  puuid: string | null;
  team_id: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  damage: number;
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
    `SELECT game_id, puuid, team_id, kills, deaths, assists, cs, gold, damage, vision, position, score
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
      kills: Number(row.kills),
      deaths: Number(row.deaths),
      assists: Number(row.assists),
      cs: Number(row.cs),
      gold: Number(row.gold),
      damage: Number(row.damage),
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
            : analyzeParticipant(game, participant, championMap);
          const stats = participant.stats ?? {};
          const championId = toNumber(participant.championId);
          const teamId = toNumber(participant.teamId);
          const flags = gameFlags(game, participantId, championMap);
          const tags = [
            ...new Set([
              ...gameFlagTags(flags),
              ...(analyzed?.tags ?? (bot ? ['人机'] : [])),
            ]),
          ].slice(0, 6);

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

export async function countPlayerMatches(puuid: string): Promise<number> {
  const db = await getDb();
  if (!db || !puuid) return 0;
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM match_participants WHERE puuid = ?',
      [puuid],
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

export async function getPlayerMatches(
  puuid: string,
  limit: number,
  offset: number,
): Promise<ArchivedMatch[]> {
  const db = await getDb();
  if (!db || !puuid) return [];
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT m.game_id, m.queue_id, m.game_creation, m.duration_seconds,
              p.team_id, p.champion_id, p.champion_name, p.position, p.win,
              p.kills, p.deaths, p.assists, p.cs, p.gold, p.damage,
              p.damage_taken, p.heal, p.vision, p.score, p.tags
       FROM match_participants p
       JOIN matches m ON m.game_id = p.game_id
       WHERE p.puuid = ?
       ORDER BY m.game_creation DESC
       LIMIT ? OFFSET ?`,
      [puuid, limit, offset],
    );

    const gameIds = [...new Set(rows.map((row) => Number(row.game_id)))];
    const participantsByGame = await loadParticipantsByGame(db, gameIds);

    return rows.map((row) => {
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
        championId: Number(row.champion_id),
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
