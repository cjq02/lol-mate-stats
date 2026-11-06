import '../env.js';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type { MatchDetail } from '../types.js';
import { logTag } from '../util.js';

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

/** 本地数据目录：装备图标、导入用的旧 SQLite 等仍然放在本机 */
export const DATA_DIR =
  process.env.LOL_MATE_DATA_DIR?.trim() || join(resolveDocumentsDir(), 'lol-mate-stats');

const HOST = process.env.LOL_MATE_MYSQL_HOST?.trim();
const PORT = Number(process.env.LOL_MATE_MYSQL_PORT ?? 3306) || 3306;
const USER = process.env.LOL_MATE_MYSQL_USER?.trim();
const PASSWORD = process.env.LOL_MATE_MYSQL_PASSWORD ?? '';
const DATABASE = process.env.LOL_MATE_MYSQL_DATABASE?.trim() || 'lol_mate_stats';
const CONNECT_TIMEOUT = Number(process.env.LOL_MATE_MYSQL_CONNECT_TIMEOUT ?? 8000) || 8000;
const USE_SSL = /^(1|true|yes|on)$/i.test(process.env.LOL_MATE_MYSQL_SSL ?? '');

/** 是否配置了远程 MySQL；没配置时所有数据库功能自动降级为不可用 */
export const DB_CONFIGURED = Boolean(HOST && USER);
/** 写进日志的连接描述（不含密码） */
export const DB_DESCRIPTION = DB_CONFIGURED
  ? `${USER}@${HOST}:${PORT}/${DATABASE}`
  : '未配置远程 MySQL';

/** 数据库暂时不可用时，隔多久再重试，避免每个请求都卡在连接超时上 */
const RETRY_AFTER_MS = 30_000;

let pool: Pool | undefined;
let connecting: Promise<Pool | undefined> | undefined;
let retryAt = 0;

/**
 * 打开（或复用）远程 MySQL 连接池。
 * 连接失败时返回 undefined，调用方按“无数据库”降级处理。
 */
export async function getDb(): Promise<Pool | undefined> {
  if (pool) return pool;
  if (!DB_CONFIGURED) return undefined;
  if (connecting) return connecting;
  if (Date.now() < retryAt) return undefined;

  connecting = connect().finally(() => {
    connecting = undefined;
  });
  return connecting;
}

async function connect(): Promise<Pool | undefined> {
  let created: Pool | undefined;
  try {
    created = mysql.createPool({
      host: HOST,
      port: PORT,
      user: USER,
      password: PASSWORD,
      database: DATABASE,
      charset: 'utf8mb4',
      timezone: 'Z',
      waitForConnections: true,
      connectionLimit: Number(process.env.LOL_MATE_MYSQL_POOL ?? 8) || 8,
      queueLimit: 20,
      connectTimeout: CONNECT_TIMEOUT,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      supportBigNumbers: true,
      bigNumberStrings: false,
      ...(USE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    const connection = await created.getConnection();
    try {
      await connection.query('SELECT 1');
    } finally {
      connection.release();
    }
    await ensureSchema(created);
    pool = created;
    retryAt = 0;
    return pool;
  } catch {
    retryAt = Date.now() + RETRY_AFTER_MS;
    if (created) await created.end().catch(() => undefined);
    return undefined;
  }
}

/** 表结构版本：每次新增迁移递增，旧库启动时按顺序补齐 */
const SCHEMA_VERSION = 4;

interface SchemaMigration {
  version: number;
  describe: string;
  up: (db: Pool) => Promise<void>;
}

async function hasColumn(db: Pool, table: string, column: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

async function hasIndex(db: Pool, table: string, index: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
      LIMIT 1`,
    [table, index],
  );
  return rows.length > 0;
}

async function addIndexIfMissing(
  db: Pool,
  table: string,
  index: string,
  columns: string,
): Promise<void> {
  if (await hasIndex(db, table, index)) return;
  await db.query(`ALTER TABLE ${table} ADD INDEX ${index} (${columns})`);
}

/**
 * 版本化迁移：旧库没有 schemaVersion 时从 0 开始，
 * 每一步都写成幂等的（先查 information_schema），失败则停在当前版本，下次启动重试。
 */
const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    describe: '对局参与者增加治疗量',
    up: async (db) => {
      if (!(await hasColumn(db, 'match_participants', 'heal'))) {
        await db.query('ALTER TABLE match_participants ADD COLUMN heal INT NOT NULL DEFAULT 0');
      }
    },
  },
  {
    version: 2,
    describe: '实时 AI 分析关联对局',
    up: async (db) => {
      if (!(await hasColumn(db, 'ai_live_analyses', 'game_id'))) {
        await db.query('ALTER TABLE ai_live_analyses ADD COLUMN game_id BIGINT NULL');
      }
      await addIndexIfMissing(
        db,
        'ai_live_analyses',
        'idx_ai_live_analyses_game',
        'game_id',
      );
    },
  },
  {
    version: 3,
    describe: '历史战绩查询索引',
    up: async (db) => {
      // 英雄战绩按 puuid + champion_id 过滤，复合索引避免回表扫全部对局
      await addIndexIfMissing(
        db,
        'match_participants',
        'idx_mp_puuid_champion',
        'puuid, champion_id',
      );
      // 游标分页按 game_creation + game_id 倒序翻页
      await addIndexIfMissing(
        db,
        'matches',
        'idx_matches_creation_id',
        'game_creation, game_id',
      );
    },
  },
  {
    version: 4,
    describe: '按英雄统计整体胜率的索引',
    up: async (db) => {
      // 大乱斗可选英雄会一次查多个英雄的全局胜率，需要从 champion_id 侧过滤
      await addIndexIfMissing(
        db,
        'match_participants',
        'idx_mp_champion_game',
        'champion_id, game_id',
      );
    },
  },
];

async function runSchemaMigrations(db: Pool): Promise<void> {
  let current = 0;
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT v FROM meta WHERE k = 'schemaVersion'",
    );
    current = Number(rows[0]?.v ?? 0) || 0;
  } catch {
    // meta 表刚建好时读取失败不影响后续迁移
  }

  for (const migration of SCHEMA_MIGRATIONS) {
    if (migration.version <= current) continue;
    try {
      await migration.up(db);
      await db.query(
        `INSERT INTO meta (k, v) VALUES ('schemaVersion', ?) AS new
         ON DUPLICATE KEY UPDATE v = new.v`,
        [String(migration.version)],
      );
      current = migration.version;
      logTag('db', `数据库结构已升级到 v${migration.version}（${migration.describe}）`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTag('db', `数据库迁移 v${migration.version} 失败，本次跳过：${message}`);
      break;
    }
  }

  if (current > 0 && current < SCHEMA_VERSION) {
    logTag('db', `数据库结构版本 v${current}，目标 v${SCHEMA_VERSION}`);
  }
}

/** 首次启动时建表；已有表不会被修改 */
async function ensureSchema(db: Pool): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS meta (
       k VARCHAR(191) NOT NULL,
       v LONGTEXT NOT NULL,
       PRIMARY KEY (k)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS reports (
       cache_key VARCHAR(191) NOT NULL,
       at BIGINT NOT NULL,
       payload LONGTEXT NOT NULL,
       PRIMARY KEY (cache_key),
       KEY idx_reports_at (at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS summoners (
       summoner_id BIGINT NOT NULL,
       at BIGINT NOT NULL,
       payload LONGTEXT NOT NULL,
       PRIMARY KEY (summoner_id),
       KEY idx_summoners_at (at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS summoners_by_name (
       name VARCHAR(191) NOT NULL,
       at BIGINT NOT NULL,
       payload LONGTEXT NOT NULL,
       PRIMARY KEY (name),
       KEY idx_summoners_by_name_at (at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ranks (
       puuid VARCHAR(100) NOT NULL,
       at BIGINT NOT NULL,
       payload LONGTEXT NOT NULL,
       PRIMARY KEY (puuid),
       KEY idx_ranks_at (at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS champion_map (
       id INT NOT NULL,
       at BIGINT NOT NULL,
       payload LONGTEXT NOT NULL,
       PRIMARY KEY (id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS matches (
       game_id BIGINT UNSIGNED NOT NULL,
       queue_id INT NOT NULL,
       game_mode VARCHAR(64) NULL,
       game_creation BIGINT NOT NULL,
       duration_seconds INT NOT NULL,
       archived_at BIGINT NOT NULL,
       PRIMARY KEY (game_id),
       KEY idx_matches_creation (game_creation)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS match_participants (
       game_id BIGINT UNSIGNED NOT NULL,
       participant_id INT NOT NULL,
       puuid VARCHAR(100) NULL,
       summoner_id BIGINT NULL,
       display_name VARCHAR(191) NULL,
       team_id INT NOT NULL,
       champion_id INT NOT NULL,
       champion_name VARCHAR(191) NULL,
       \`position\` VARCHAR(32) NULL,
       win TINYINT NOT NULL,
       kills INT NOT NULL,
       deaths INT NOT NULL,
       assists INT NOT NULL,
       cs INT NOT NULL,
       gold INT NOT NULL,
       damage INT NOT NULL,
       damage_taken INT NOT NULL,
       heal INT NOT NULL DEFAULT 0,
       vision INT NOT NULL,
       is_bot TINYINT NOT NULL DEFAULT 0,
       score DOUBLE NULL,
       tags VARCHAR(255) NULL,
       PRIMARY KEY (game_id, participant_id),
       KEY idx_mp_puuid (puuid)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ai_analyses (
       game_id BIGINT UNSIGNED NOT NULL,
       model VARCHAR(191) NOT NULL,
       content LONGTEXT NOT NULL,
       created_at BIGINT NOT NULL,
       PRIMARY KEY (game_id),
       KEY idx_ai_analyses_created (created_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ai_live_analyses (
       session_key VARCHAR(191) NOT NULL,
       model VARCHAR(191) NOT NULL,
       content LONGTEXT NOT NULL,
       created_at BIGINT NOT NULL,
       game_id BIGINT NULL,
       PRIMARY KEY (session_key),
       KEY idx_ai_live_analyses_created (created_at),
       KEY idx_ai_live_analyses_game (game_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS match_details (
       game_id BIGINT UNSIGNED NOT NULL,
       at BIGINT NOT NULL,
       payload LONGTEXT NOT NULL,
       PRIMARY KEY (game_id),
       KEY idx_match_details_at (at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const statement of statements) await db.query(statement);

  await runSchemaMigrations(db);
}

/** 启动时显式初始化数据库；返回是否可用 */
export async function initDb(): Promise<boolean> {
  return Boolean(await getDb());
}

/** 在同一个连接上执行事务；数据库不可用时返回 undefined */
export async function withTransaction<T>(
  fn: (connection: PoolConnection) => Promise<T>,
): Promise<T | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      /* 回滚失败时忽略 */
    }
    throw error;
  } finally {
    connection.release();
  }
}

/** 关闭连接池（退出前调用） */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current) await current.end().catch(() => undefined);
}

export async function readMeta(key: string): Promise<string | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  try {
    const [rows] = await db.query<RowDataPacket[]>('SELECT v FROM meta WHERE k = ?', [key]);
    return (rows[0]?.v as string | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function writeMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO meta (k, v) VALUES (?, ?) AS new
       ON DUPLICATE KEY UPDATE v = new.v`,
      [key, value],
    );
  } catch {
    /* meta 写入失败不影响主流程 */
  }
}

export interface SavedAiAnalysis {
  gameId: number;
  model: string;
  content: string;
  createdAt: number;
}

/** 读取某场对局已保存的 AI 分析 */
export async function getAiAnalysis(gameId: number): Promise<SavedAiAnalysis | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT game_id, model, content, created_at FROM ai_analyses WHERE game_id = ?',
      [gameId],
    );
    const row = rows[0];
    if (!row?.content) return undefined;
    return {
      gameId: Number(row.game_id ?? gameId),
      model: String(row.model ?? ''),
      content: String(row.content),
      createdAt: Number(row.created_at ?? 0),
    };
  } catch {
    return undefined;
  }
}

/** 保存（或覆盖）某场对局的 AI 分析 */
export async function saveAiAnalysis(
  gameId: number,
  model: string,
  content: string,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    await db.query<ResultSetHeader>(
      `INSERT INTO ai_analyses (game_id, model, content, created_at)
       VALUES (?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE
         model = new.model,
         content = new.content,
         created_at = new.created_at`,
      [gameId, model, content, Date.now()],
    );
    return true;
  } catch {
    return false;
  }
}

/** 删除某场对局的 AI 分析（重新生成时可选用） */
export async function deleteAiAnalysis(gameId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.query('DELETE FROM ai_analyses WHERE game_id = ?', [gameId]);
  } catch {
    /* 删除失败不影响主流程 */
  }
}

export interface SavedLiveAiAnalysis {
  sessionKey: string;
  model: string;
  content: string;
  createdAt: number;
  /** 关联到赛后对局后才有值 */
  gameId?: number;
}

function mapLiveAiRow(
  row: RowDataPacket | undefined,
  fallbackSessionKey = '',
): SavedLiveAiAnalysis | undefined {
  if (!row?.content) return undefined;
  return {
    sessionKey: String(row.session_key ?? fallbackSessionKey),
    model: String(row.model ?? ''),
    content: String(row.content),
    createdAt: Number(row.created_at ?? 0),
    gameId:
      row.game_id === null || row.game_id === undefined
        ? undefined
        : Number(row.game_id),
  };
}

/** 读取当前对局实时 AI 分析 */
export async function getLiveAiAnalysis(
  sessionKey: string,
): Promise<SavedLiveAiAnalysis | undefined> {
  const db = await getDb();
  if (!db || !sessionKey) return undefined;
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT session_key, model, content, created_at, game_id
       FROM ai_live_analyses WHERE session_key = ?`,
      [sessionKey],
    );
    return mapLiveAiRow(rows[0], sessionKey);
  } catch {
    return undefined;
  }
}

/** 读取某场对局在比赛进行中生成的 AI 分析 */
export async function getLiveAiAnalysisByGame(
  gameId: number,
): Promise<SavedLiveAiAnalysis | undefined> {
  const db = await getDb();
  if (!db || !gameId) return undefined;
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT session_key, model, content, created_at, game_id
       FROM ai_live_analyses
       WHERE game_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [gameId],
    );
    return mapLiveAiRow(rows[0]);
  } catch {
    return undefined;
  }
}

/**
 * 把进行中生成的 AI 分析关联到具体对局。
 * 实时接口拿不到 gameId，赛后用对局开始时间和时长找当时保存的记录。
 */
export async function linkLiveAnalysisToGameByTime(
  gameId: number,
  gameCreation: number,
  durationSeconds: number,
): Promise<boolean> {
  const db = await getDb();
  if (!db || !gameId || !gameCreation) return false;
  const end = gameCreation + Math.max(0, durationSeconds) * 1000 + 5 * 60_000;
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT session_key FROM ai_live_analyses
       WHERE (game_id IS NULL OR game_id = ?)
         AND created_at >= ? AND created_at <= ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [gameId, gameCreation, end],
    );
    const sessionKey = rows[0]?.session_key;
    if (!sessionKey) return false;
    await db.query('UPDATE ai_live_analyses SET game_id = ? WHERE session_key = ?', [
      gameId,
      sessionKey,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** 从已归档的对局里补做关联（打开赛后 AI 分析时兜底） */
export async function linkLiveAnalysisToGameByArchive(gameId: number): Promise<boolean> {
  const db = await getDb();
  if (!db || !gameId) return false;
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT game_creation, duration_seconds FROM matches WHERE game_id = ?',
      [gameId],
    );
    const row = rows[0];
    if (!row) return false;
    return linkLiveAnalysisToGameByTime(
      gameId,
      Number(row.game_creation),
      Number(row.duration_seconds),
    );
  } catch {
    return false;
  }
}

/** 保存（或覆盖）当前对局实时 AI 分析 */
export async function saveLiveAiAnalysis(
  sessionKey: string,
  model: string,
  content: string,
): Promise<boolean> {
  const db = await getDb();
  if (!db || !sessionKey) return false;
  try {
    await db.query<ResultSetHeader>(
      `INSERT INTO ai_live_analyses (session_key, model, content, created_at)
       VALUES (?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE
         model = new.model,
         content = new.content,
         created_at = new.created_at`,
      [sessionKey, model, content, Date.now()],
    );
    return true;
  } catch {
    return false;
  }
}

/** 对局详情缓存版本：卡片/标签口径变化时递增，旧缓存自动失效 */
const MATCH_DETAIL_CACHE_VERSION = 3;

/** 读取已持久保存的完整对局详情（10 人本局数据 + 近期战绩） */
export async function getSavedMatchDetail(
  gameId: number,
): Promise<MatchDetail | undefined> {
  const db = await getDb();
  if (!db || !gameId) return undefined;
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT payload FROM match_details WHERE game_id = ?',
      [gameId],
    );
    const row = rows[0];
    if (!row) return undefined;
    const parsed = JSON.parse(String(row.payload ?? '')) as {
      version?: number;
      detail?: MatchDetail;
    };
    if (parsed?.version !== MATCH_DETAIL_CACHE_VERSION || !parsed.detail) {
      return undefined;
    }
    return parsed.detail;
  } catch {
    return undefined;
  }
}

/** 保存完整对局详情，供服务重启后直接复用 */
export async function saveMatchDetail(detail: MatchDetail): Promise<void> {
  const db = await getDb();
  if (!db || !detail?.gameId) return;
  try {
    await db.query<ResultSetHeader>(
      `INSERT INTO match_details (game_id, at, payload)
       VALUES (?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE at = new.at, payload = new.payload`,
      [
        detail.gameId,
        Date.now(),
        JSON.stringify({ version: MATCH_DETAIL_CACHE_VERSION, detail }),
      ],
    );
  } catch {
    /* 缓存写入失败不影响本次返回 */
  }
}
