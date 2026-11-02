import '../env.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ResultSetHeader } from 'mysql2/promise';
import {
  closeDb,
  DATA_DIR,
  DB_CONFIGURED,
  DB_DESCRIPTION,
  getDb,
  initDb,
} from '../stats/store.js';

/**
 * 把本地 SQLite 的 cache.db 导入远程 MySQL。
 *
 * 用法：
 *   npm run db:migrate                 # 使用默认路径（文档/lol-mate-stats/cache.db）
 *   npm run db:migrate -- <path>       # 指定其它 cache.db
 *
 * 可以重复执行：相同主键会覆盖，不会产生重复数据。
 */

interface TableSpec {
  name: string;
  columns: string[];
  primaryKey: string[];
}

const TABLES: TableSpec[] = [
  { name: 'meta', columns: ['k', 'v'], primaryKey: ['k'] },
  { name: 'reports', columns: ['cache_key', 'at', 'payload'], primaryKey: ['cache_key'] },
  { name: 'summoners', columns: ['summoner_id', 'at', 'payload'], primaryKey: ['summoner_id'] },
  {
    name: 'summoners_by_name',
    columns: ['name', 'at', 'payload'],
    primaryKey: ['name'],
  },
  { name: 'ranks', columns: ['puuid', 'at', 'payload'], primaryKey: ['puuid'] },
  { name: 'champion_map', columns: ['id', 'at', 'payload'], primaryKey: ['id'] },
  {
    name: 'matches',
    columns: [
      'game_id',
      'queue_id',
      'game_mode',
      'game_creation',
      'duration_seconds',
      'archived_at',
    ],
    primaryKey: ['game_id'],
  },
  {
    name: 'match_participants',
    columns: [
      'game_id',
      'participant_id',
      'puuid',
      'summoner_id',
      'display_name',
      'team_id',
      'champion_id',
      'champion_name',
      'position',
      'win',
      'kills',
      'deaths',
      'assists',
      'cs',
      'gold',
      'damage',
      'damage_taken',
      'heal',
      'vision',
      'is_bot',
      'score',
      'tags',
    ],
    primaryKey: ['game_id', 'participant_id'],
  },
  {
    name: 'ai_analyses',
    columns: ['game_id', 'model', 'content', 'created_at'],
    primaryKey: ['game_id'],
  },
  {
    name: 'ai_live_analyses',
    columns: ['session_key', 'model', 'content', 'created_at'],
    primaryKey: ['session_key'],
  },
];

const CHUNK_SIZE = 500;

function quote(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

/** SQLite 整数在 JS 里是 number；这里只做必要的类型归一化 */
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  return value;
}

async function main(): Promise<void> {
  if (!DB_CONFIGURED) {
    console.error('未配置远程 MySQL：请先在 .env 里设置 LOL_MATE_MYSQL_HOST / USER / PASSWORD / DATABASE');
    process.exitCode = 1;
    return;
  }

  const sqlitePath = process.argv[2]?.trim() || join(DATA_DIR, 'cache.db');
  if (!existsSync(sqlitePath)) {
    console.error(`找不到 SQLite 数据库：${sqlitePath}`);
    console.error('可以先用参数指定路径：npm run db:migrate -- <path/to/cache.db>');
    process.exitCode = 1;
    return;
  }

  console.log(`源数据库：${sqlitePath}`);
  console.log(`目标数据库：${DB_DESCRIPTION}`);

  if (!(await initDb())) {
    console.error('远程 MySQL 连接失败，请检查 .env 和网络');
    process.exitCode = 1;
    return;
  }

  // 先 VACUUM 到临时文件，避免直接读取正在写入的数据库
  const tempDir = mkdtempSync(join(tmpdir(), 'lol-mate-migrate-'));
  const snapshotPath = join(tempDir, 'cache.db');
  let source: DatabaseSync;
  try {
    const original = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      original.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
    } finally {
      original.close();
    }
    source = new DatabaseSync(snapshotPath, { readOnly: true });
  } catch (error) {
    console.warn(`生成快照失败，改为直接读取：${String(error)}`);
    source = new DatabaseSync(sqlitePath, { readOnly: true });
  }

  const pool = await getDb();
  if (!pool) {
    source.close();
    rmSync(tempDir, { recursive: true, force: true });
    console.error('远程 MySQL 连接失败');
    process.exitCode = 1;
    return;
  }

  try {
    for (const table of TABLES) {
      const sourceColumns = source
        .prepare(`PRAGMA table_info(${quote(table.name)})`)
        .all() as unknown as Array<{ name: string }>;
      const available = new Set(sourceColumns.map((column) => column.name));
      const columns = table.columns.filter((column) => available.has(column));
      if (!columns.length) {
        console.log(`${table.name}: 源库没有该表，跳过`);
        continue;
      }

      const rows = source
        .prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(table.name)}`)
        .all() as unknown as Array<Record<string, unknown>>;

      if (!rows.length) {
        console.log(`${table.name}: 0 行`);
        continue;
      }

      const updateColumns = columns.filter((column) => !table.primaryKey.includes(column));
      const updateClause = updateColumns.length
        ? `ON DUPLICATE KEY UPDATE ${updateColumns
            .map((column) => `${quote(column)} = VALUES(${quote(column)})`)
            .join(', ')}`
        : '';
      const sql = `INSERT INTO ${quote(table.name)} (${columns
        .map(quote)
        .join(', ')}) VALUES ? ${updateClause}`;

      for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
        const chunk = rows.slice(offset, offset + CHUNK_SIZE);
        const values = chunk.map((row) => columns.map((column) => normalize(row[column])));
        await pool.query<ResultSetHeader>(sql, [values]);
      }
      console.log(`${table.name}: ${rows.length} 行`);
    }

    console.log('迁移完成。');
  } finally {
    source.close();
    rmSync(tempDir, { recursive: true, force: true });
    await closeDb();
  }
}

void main().catch(async (error) => {
  console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`);
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
