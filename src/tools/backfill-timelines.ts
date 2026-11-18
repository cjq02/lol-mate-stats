import '../env.js';
import { closeDb } from '../stats/store.js';
import {
  backfillTimelines,
  findTimelineBackfillCandidates,
} from '../stats/timeline-backfill.js';
import { fail } from '../util.js';

/**
 * 回填对局时间线。
 *
 * 用法：
 *   npm run db:backfill-timelines
 *   npm run db:backfill-timelines -- --limit 200
 *   npm run db:backfill-timelines -- --game 9082565891 --force
 *   npm run db:backfill-timelines -- --since 2026-11-01
 *   npm run db:backfill-timelines -- --dry-run
 *
 * 默认只补最近 100 场“有对局存档、但没有时间线”的对局；
 * 面板启动后也会在后台自动补最近 100 场，这个命令用于手动多补一些。
 */

function numberArg(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : undefined;
}

function dateArg(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00+08:00`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function printHelp(): void {
  console.log(`
回填对局时间线（每条命的存活、KDA、补刀、金币和挂机时长）

用法：
  npm run db:backfill-timelines [参数]

参数：
  --limit <n>        最多回填多少场，默认 100，范围 1-5000
  --concurrency <n>  并发数，默认 2，范围 1-8
  --game <id>        只回填指定对局（会自动覆盖已有时间线）
  --since <日期>     只回填该日期之后的对局，例如 2026-11-01
  --before <日期>    只回填该日期之前的对局
  --window <n>       只在最近 N 场对局里找候选（面板启动时默认 200）
  --force            已有时间线也重新拉取
  --dry-run          只列出待回填对局，不访问客户端
  --quiet            减少日志
  --help             显示帮助

说明：
  · 时间线平均约 146 KB/场，回填 200 场约 30 MB
  · 5 分钟以内的重开局会跳过
  · 需要客户端已登录，且对局仍在客户端的战绩缓存里
`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const gameId = numberArg('--game');
  const options = {
    limit: numberArg('--limit'),
    concurrency: numberArg('--concurrency'),
    force: process.argv.includes('--force') || gameId !== undefined,
    gameId: gameId !== undefined && gameId > 0 ? gameId : undefined,
    since: dateArg('--since'),
    before: dateArg('--before'),
    windowGames: numberArg('--window'),
    quiet: process.argv.includes('--quiet'),
  };

  if (process.argv.includes('--dry-run')) {
    const candidates = await findTimelineBackfillCandidates(options);
    console.log(`待回填 ${candidates.length} 场：`);
    for (const id of candidates) console.log(`  ${id}`);
    return;
  }

  const result = await backfillTimelines(options);
  if (result.total === 0) {
    console.log('没有需要回填的对局（最近的对局都已有时间线）。');
    return;
  }
  if (result.saved === 0 && result.failed > 0) {
    console.error(fail('全部对局回填失败，请确认客户端已登录且战绩缓存仍在。'));
    process.exitCode = 1;
  }
}

void main()
  .catch((error) => {
    console.error(fail(`时间线回填失败：${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => undefined);
  });
