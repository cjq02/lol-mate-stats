import type { ChampionSummary } from '../lcu/api.js';
import type { RawGame, RawIdentityPlayer, RawParticipant, RawStats } from '../types.js';
import { toNumber } from '../util.js';
import { analyzeParticipant, detectLane } from './analyze.js';
import { queueName } from './constants.js';
import { getDb, readMeta, writeMeta } from './store.js';

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
  vision: number;
  score?: number;
  tags: string[];
}

let archivedIds: Set<number> | undefined;

function loadArchivedIds(db: NonNullable<ReturnType<typeof getDb>>): Set<number> {
  if (archivedIds) return archivedIds;
  const rows = db.prepare('SELECT game_id FROM matches').all() as unknown as Array<{
    game_id: number;
  }>;
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

/**
 * 把完整对局写入 SQLite。重复对局会覆盖参与者数据，不会产生重复行。
 * 只保存结构化字段，不保存原始 LCU JSON，避免数据库膨胀。
 */
export function archiveGames(games: RawGame[], championMap: Map<number, ChampionSummary>): void {
  if (!games.length) return;
  const db = getDb();
  if (!db) return;

  const known = loadArchivedIds(db);
  const fresh = games.filter((game) => {
    const gameId = toNumber(game.gameId);
    return (
      gameId > 0 &&
      !known.has(gameId) &&
      (game.participants?.length ?? 0) >= 2
    );
  });
  if (!fresh.length) return;

  const insertMatch = db.prepare(
    `INSERT OR REPLACE INTO matches
     (game_id, queue_id, game_mode, game_creation, duration_seconds, archived_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deleteParticipants = db.prepare('DELETE FROM match_participants WHERE game_id = ?');
  const insertParticipant = db.prepare(
    `INSERT OR REPLACE INTO match_participants
     (game_id, participant_id, puuid, summoner_id, display_name, team_id, champion_id,
      champion_name, position, win, kills, deaths, assists, cs, gold, damage, damage_taken,
      vision, is_bot, score, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const now = Date.now();
  const done: number[] = [];

  try {
    db.exec('BEGIN IMMEDIATE');
    for (const game of fresh) {
      const gameId = toNumber(game.gameId);
      const queueId = toNumber(game.queueId);
      const rawDuration = toNumber(game.gameDuration);
      const durationSeconds =
        rawDuration > 100_000 ? Math.round(rawDuration / 1000) : rawDuration;
      const identities = game.participantIdentities ?? [];

      insertMatch.run(
        gameId,
        queueId,
        typeof game.gameMode === 'string' ? game.gameMode : null,
        toNumber(game.gameCreation),
        durationSeconds,
        now,
      );
      deleteParticipants.run(gameId);

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

        insertParticipant.run(
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
          stat(stats, 'visionScore'),
          bot ? 1 : 0,
          analyzed?.score ?? null,
          JSON.stringify(analyzed?.tags ?? (bot ? ['人机'] : [])),
        );
      });

      done.push(gameId);
    }
    db.exec('COMMIT');
    for (const gameId of done) known.add(gameId);
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时忽略 */
    }
  }
}

export function isGameArchived(gameId: number): boolean {
  const db = getDb();
  if (!db) return false;
  return loadArchivedIds(db).has(gameId);
}

export function countPlayerMatches(puuid: string): number {
  const db = getDb();
  if (!db || !puuid) return 0;
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM match_participants WHERE puuid = ?')
      .get(puuid) as unknown as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

export function getPlayerMatches(
  puuid: string,
  limit: number,
  offset: number,
): ArchivedMatch[] {
  const db = getDb();
  if (!db || !puuid) return [];
  try {
    const rows = db
      .prepare(
        `SELECT m.game_id, m.queue_id, m.game_creation, m.duration_seconds,
                p.champion_id, p.champion_name, p.position, p.win,
                p.kills, p.deaths, p.assists, p.cs, p.gold, p.damage,
                p.damage_taken, p.vision, p.score, p.tags
         FROM match_participants p
         JOIN matches m ON m.game_id = p.game_id
         WHERE p.puuid = ?
         ORDER BY m.game_creation DESC
         LIMIT ? OFFSET ?`,
      )
      .all(puuid, limit, offset) as unknown as Array<{
      game_id: number;
      queue_id: number;
      game_creation: number;
      duration_seconds: number;
      champion_id: number;
      champion_name: string | null;
      position: string | null;
      win: number;
      kills: number;
      deaths: number;
      assists: number;
      cs: number;
      gold: number;
      damage: number;
      damage_taken: number;
      vision: number;
      score: number | null;
      tags: string | null;
    }>;

    return rows.map((row) => {
      let tags: string[] = [];
      if (row.tags) {
        try {
          const parsed = JSON.parse(row.tags) as unknown;
          if (Array.isArray(parsed)) tags = parsed.filter((tag) => typeof tag === 'string');
        } catch {
          /* 忽略损坏的 tags */
        }
      }
      return {
        gameId: Number(row.game_id),
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
        vision: Number(row.vision),
        score: row.score === null ? undefined : Number(row.score),
        tags,
      };
    });
  } catch {
    return [];
  }
}

export function saveSelfPuuid(puuid: string): void {
  if (!puuid) return;
  writeMeta('selfPuuid', puuid);
}

export function getSavedSelfPuuid(): string | undefined {
  return readMeta('selfPuuid');
}
