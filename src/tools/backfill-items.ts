import '../env.js';
import process from 'node:process';
import type { RowDataPacket } from 'mysql2/promise';

import { discoverConnection } from '../lcu/discover.js';
import { LcuApi } from '../lcu/api.js';
import { closeDb, getDb } from '../stats/store.js';
import { dim, fail, logTag, mapLimit, ok, warn } from '../util.js';

/**
 * 回填对局参与者的最终装备。
 *
 * 用法：
 *   npm run db:backfill-items
 *   npm run db:backfill-items -- --limit 500
 *   npm run db:backfill-items -- --game 9098181134
 *   npm run db:backfill-items -- --dry-run
 *
 * 默认只补最近 2000 场“有对局存档、但还没有装备数据”的对局；
 * 装备只来自客户端战绩缓存，太旧的对局可能已经拉不到。
 */

function numberArg(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : undefined;
}

function printHelp(): void {
  console.log(`
回填对局参与者的最终装备（item0-item6）

用法：
  npm run db:backfill-items [参数]

参数：
  --limit <n>        最多回填多少场，默认 2000，范围 1-5000
  --concurrency <n>  并发数，默认 2，范围 1-5
  --game <id>        只回填指定对局
  --dry-run          只列出待回填对局，不访问客户端
  --help             显示帮助

说明：
  · 需要客户端已登录，且对局仍在客户端的战绩缓存里
  · 太旧、客户端已经拉不到的对局会跳过
  · 回填后六角星侧栏才能显示整装数量/百分比
`);
}

function itemValues(stats: Record<string, unknown> | undefined): number[] {
  return Array.from({ length: 7 }, (_, slot) => {
    const value = stats?.[`item${slot}`];
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
  });
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const db = await getDb();
  if (!db) {
    console.error(fail('没有配置 MySQL，无法回填装备'));
    return;
  }

  const limit = Math.max(1, Math.min(5000, Math.trunc(numberArg('--limit') ?? 2000)));
  const concurrency = Math.max(
    1,
    Math.min(5, Math.trunc(numberArg('--concurrency') ?? 2)),
  );
  const gameIdArg = numberArg('--game');
  const dryRun = process.argv.includes('--dry-run');

  let gameIds: number[] = [];
  try {
    if (gameIdArg && gameIdArg > 0) {
      gameIds = [Math.trunc(gameIdArg)];
    } else {
      const [rows] = await db.query<RowDataPacket[]>(
        `SELECT m.game_id
         FROM matches m
         JOIN match_participants p ON p.game_id = m.game_id
         WHERE GREATEST(p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6) = 0
         GROUP BY m.game_id
         ORDER BY m.game_creation DESC
         LIMIT ?`,
        [limit],
      );
      gameIds = rows.map((row) => Number(row.game_id)).filter((id) => id > 0);
    }
  } catch (error) {
    console.error(
      fail(`读取待回填对局失败：${error instanceof Error ? error.message : String(error)}`),
    );
    return;
  }

  if (!gameIds.length) {
    console.log(ok('没有需要回填装备的对局'));
    return;
  }

  logTag('items', `待回填 ${gameIds.length} 场，并发 ${concurrency}`);
  if (dryRun) {
    console.log(dim(gameIds.slice(0, 20).join(', ')));
    if (gameIds.length > 20) console.log(dim(`... 其余 ${gameIds.length - 20} 场`));
    return;
  }

  let connection;
  try {
    connection = await discoverConnection();
  } catch (error) {
    console.error(
      fail(`无法连接客户端：${error instanceof Error ? error.message : String(error)}`),
    );
    return;
  }
  const api = new LcuApi(connection);

  let done = 0;
  let updatedGames = 0;
  let updatedRows = 0;
  let failed = 0;
  const started = Date.now();

  await mapLimit(gameIds, concurrency, async (gameId) => {
    try {
      const game = await api.getGame(gameId);
      const participants = game.participants ?? [];
      let rows = 0;
      for (const participant of participants) {
        const participantId = Math.trunc(Number(participant.participantId) || 0);
        if (!participantId) continue;
        const items = itemValues(participant.stats as Record<string, unknown> | undefined);
        if (!items.some((id) => id > 0)) continue;
        await db.query(
          `UPDATE match_participants
           SET item0 = ?, item1 = ?, item2 = ?, item3 = ?,
               item4 = ?, item5 = ?, item6 = ?
           WHERE game_id = ? AND participant_id = ?`,
          [...items, gameId, participantId],
        );
        rows += 1;
      }
      if (rows > 0) updatedGames += 1;
      updatedRows += rows;
    } catch {
      failed += 1;
    } finally {
      done += 1;
      if (done % 50 === 0) {
        const seconds = Math.round((Date.now() - started) / 1000);
        logTag(
          'items',
          `进度 ${done}/${gameIds.length} · 更新 ${updatedGames} 场 / ${updatedRows} 行 · 失败 ${failed} · 用时 ${seconds}s`,
        );
      }
    }
  });

  if (updatedGames) {
    console.log(ok(`装备回填完成：${updatedGames} 场，${updatedRows} 行`));
  } else {
    console.log(warn('没有成功回填任何对局，可能这些对局已经不在客户端战绩缓存里'));
  }
  if (failed) console.log(warn(`有 ${failed} 场读取失败，可以稍后重试`));
  await closeDb();
}

await main();
