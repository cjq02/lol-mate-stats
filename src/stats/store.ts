import '../env.js';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Windows 的“文档”目录（可能被重定向到 E 盘） */
function resolveDocumentsDir(): string {
  if (process.platform === 'win32') {
    try {
      const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
      const output = execFileSync(
        reg,
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
          '/v',
          'Personal',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      const line = output
        .split(/\r?\n/)
        .find((item) => /Personal\s+REG_(?:EXPAND_)?SZ/i.test(item));
      const match = line?.match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i);
      if (match?.[1]) {
        return match[1].replace(/%([^%]+)%/g, (_, key: string) => process.env[key] ?? '');
      }
    } catch {
      /* 读不到注册表时退回 ~/Documents */
    }
  }
  return join(homedir(), 'Documents');
}

const DOCUMENTS_DIR = resolveDocumentsDir();
const LEGACY_DB_PATH = join(homedir(), '.lol-mate-stats', 'cache.db');
const EXPLICIT_DB_PATH = process.env.LOL_MATE_DB?.trim() || process.env.LOL_MATE_CACHE?.trim();

/** 数据库默认放在“文档/lol-mate-stats/cache.db”，可用环境变量覆盖 */
export const DB_PATH = EXPLICIT_DB_PATH || join(DOCUMENTS_DIR, 'lol-mate-stats', 'cache.db');

let db: DatabaseSync | undefined;
let failed = false;

/** 首次升级时把 C 盘旧缓存迁移到文档目录，成功后清理旧文件 */
function migrateLegacyDatabase(): void {
  if (EXPLICIT_DB_PATH || DB_PATH === LEGACY_DB_PATH) return;
  if (existsSync(DB_PATH) || !existsSync(LEGACY_DB_PATH)) return;

  let migrated = false;
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    const legacy = new DatabaseSync(LEGACY_DB_PATH, { readOnly: true });
    try {
      legacy.exec(`VACUUM INTO '${DB_PATH.replace(/'/g, "''")}'`);
    } finally {
      legacy.close();
    }
    migrated = existsSync(DB_PATH) && statSync(DB_PATH).size > 0;
  } catch {
    try {
      mkdirSync(dirname(DB_PATH), { recursive: true });
      copyFileSync(LEGACY_DB_PATH, DB_PATH);
      migrated = existsSync(DB_PATH) && statSync(DB_PATH).size > 0;
    } catch {
      /* 迁移失败时使用空库 */
    }
  }

  if (!migrated) return;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${LEGACY_DB_PATH}${suffix}`);
    } catch {
      /* 旧文件可能不存在或占用中 */
    }
  }
  try {
    unlinkSync(join(homedir(), '.lol-mate-stats', 'cache.json'));
  } catch {
    /* 旧的 JSON 缓存可能不存在 */
  }
  try {
    rmdirSync(dirname(LEGACY_DB_PATH));
  } catch {
    /* 目录非空时保留 */
  }
}

/** 打开（或复用）本地 SQLite；失败后本次进程不再重试 */
export function getDb(): DatabaseSync | undefined {
  if (db) return db;
  if (failed) return undefined;
  migrateLegacyDatabase();
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
