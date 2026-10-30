import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 数据库路径：优先 LOL_MATE_DB，兼容旧的 LOL_MATE_CACHE 环境变量 */
export const DB_PATH =
  process.env.LOL_MATE_DB?.trim() ||
  process.env.LOL_MATE_CACHE?.trim() ||
  join(homedir(), '.lol-mate-stats', 'cache.db');

let db: DatabaseSync | undefined;
let failed = false;

/** 打开（或复用）本地 SQLite；失败后本次进程不再重试 */
export function getDb(): DatabaseSync | undefined {
  if (db) return db;
  if (failed) return undefined;
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    const connection = new DatabaseSync(DB_PATH);
    connection.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS reports (
        cache_key TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reports_at ON reports(at);

      CREATE TABLE IF NOT EXISTS summoners (
        summoner_id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summoners_at ON summoners(at);

      CREATE TABLE IF NOT EXISTS summoners_by_name (
        name TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summoners_by_name_at ON summoners_by_name(at);

      CREATE TABLE IF NOT EXISTS ranks (
        puuid TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ranks_at ON ranks(at);

      CREATE TABLE IF NOT EXISTS champion_map (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS matches (
        game_id INTEGER PRIMARY KEY,
        queue_id INTEGER NOT NULL,
        game_mode TEXT,
        game_creation INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL,
        archived_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_matches_creation ON matches(game_creation);

      CREATE TABLE IF NOT EXISTS match_participants (
        game_id INTEGER NOT NULL,
        participant_id INTEGER NOT NULL,
        puuid TEXT,
        summoner_id INTEGER,
        display_name TEXT,
        team_id INTEGER NOT NULL,
        champion_id INTEGER NOT NULL,
        champion_name TEXT,
        position TEXT,
        win INTEGER NOT NULL,
        kills INTEGER NOT NULL,
        deaths INTEGER NOT NULL,
        assists INTEGER NOT NULL,
        cs INTEGER NOT NULL,
        gold INTEGER NOT NULL,
        damage INTEGER NOT NULL,
        damage_taken INTEGER NOT NULL,
        vision INTEGER NOT NULL,
        is_bot INTEGER NOT NULL DEFAULT 0,
        score INTEGER,
        tags TEXT,
        PRIMARY KEY (game_id, participant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mp_puuid ON match_participants(puuid);
      CREATE INDEX IF NOT EXISTS idx_mp_game ON match_participants(game_id);
    `);
    db = connection;
    return db;
  } catch {
    failed = true;
    return undefined;
  }
}

export function readMeta(key: string): string | undefined {
  const connection = getDb();
  if (!connection) return undefined;
  try {
    const row = connection
      .prepare('SELECT v FROM meta WHERE k = ?')
      .get(key) as unknown as { v?: string } | undefined;
    return row?.v;
  } catch {
    return undefined;
  }
}

export function writeMeta(key: string, value: string): void {
  const connection = getDb();
  if (!connection) return;
  try {
    connection
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, value);
  } catch {
    /* meta 写入失败不影响主流程 */
  }
}
