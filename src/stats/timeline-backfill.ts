import type { ChampionSummary } from '../lcu/api.js';
import { LcuApi } from '../lcu/api.js';
import { discoverConnection } from '../lcu/discover.js';
import { logTag } from '../util.js';
import { getDb, saveMatchTimeline } from './store.js';
import { parseMatchTimeline } from './timeline.js';

/**
 * 从数据库里找出“有对局存档、但没有时间线”的场次，回填最近的对局。
 * 时间线用来判断挂机/逃跑、生成每条命详情和 AI 复盘，没有时间线时
 * 只能退回整局数据推断，准确率会低很多。
 */
export interface TimelineBackfillOptions {
  /** 最多回填多少场，默认 100，范围 1-5000 */
  limit?: number;
  /** 并发数，默认 2，范围 1-8 */
  concurrency?: number;
  /** 已有时间线也重新拉取 */
  force?: boolean;
  /** 只回填指定对局 */
  gameId?: number;
  /** 只回填该时间之后的对局（毫秒时间戳） */
  since?: number;
  /** 只回填该时间之前的对局（毫秒时间戳） */
  before?: number;
  /** 只在最近 N 场对局里找候选，避免自动回填一路翻到很早的历史 */
  windowGames?: number;
  /** 复用已有客户端连接；不传时自行发现客户端 */
  api?: LcuApi;
  quiet?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface TimelineBackfillResult {
  /** 候选对局数 */
  total: number;
  /** 成功写入时间线 */
  saved: number;
  /** 客户端没有时间线或没有玩家数据 */
  skipped: number;
  /** 请求/解析失败 */
  failed: number;
  elapsedMs: number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_CONCURRENCY = 2;
const MAX_LIMIT = 5000;
const MAX_CONCURRENCY = 8;
/** 重开局时间线没有分析价值，跳过 5 分钟以内的对局 */
const MIN_DURATION_SECONDS = 300;

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(value)));
}

/**
 * 按“最近对局优先”返回需要回填的 gameId。
 * 默认跳过已有时间线的对局；传 force 或 gameId 时可以重新拉取。
 */
export async function findTimelineBackfillCandidates(
  options: TimelineBackfillOptions = {},
): Promise<number[]> {
  const db = await getDb();
  if (!db) throw new Error('远程 MySQL 未配置或连接失败，无法读取待回填对局');

  const conditions = [`COALESCE(m.duration_seconds, 0) >= ${MIN_DURATION_SECONDS}`];
  const params: number[] = [];
  if (!options.force && !options.gameId) conditions.push('t.game_id IS NULL');
  if (options.gameId) {
    conditions.push('m.game_id = ?');
    params.push(options.gameId);
  }
  if (options.since !== undefined && Number.isFinite(options.since)) {
    conditions.push('m.game_creation >= ?');
    params.push(options.since);
  }
  if (options.before !== undefined && Number.isFinite(options.before)) {
    conditions.push('m.game_creation < ?');
    params.push(options.before);
  }

  const windowGames =
    options.windowGames !== undefined && Number.isFinite(options.windowGames)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(options.windowGames)))
      : undefined;
  const fromClause = windowGames
    ? `(SELECT game_id, game_creation, duration_seconds
        FROM matches
        ORDER BY game_creation DESC
        LIMIT ${windowGames}) m`
    : 'matches m';

  const [rows] = await db.query(
    `SELECT m.game_id
     FROM ${fromClause}
     LEFT JOIN match_timelines t ON t.game_id = m.game_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.game_creation DESC
     LIMIT ${normalizeLimit(options.limit)}`,
    params,
  );
  return (rows as Array<{ game_id: number | string }>)
    .map((row) => Number(row.game_id))
    .filter((gameId) => Number.isFinite(gameId) && gameId > 0);
}

/**
 * 回填时间线。成功写入后会同时更新参与者表的挂机时长字段，
 * 所以历史战绩列表里的逃跑标签也会跟着变准。
 */
export async function backfillTimelines(
  options: TimelineBackfillOptions = {},
): Promise<TimelineBackfillResult> {
  const started = Date.now();
  const gameIds = await findTimelineBackfillCandidates(options);
  const result: TimelineBackfillResult = {
    total: gameIds.length,
    saved: 0,
    skipped: 0,
    failed: 0,
    elapsedMs: 0,
  };
  if (!gameIds.length) {
    result.elapsedMs = Date.now() - started;
    return result;
  }

  const ownedApi = options.api ? undefined : new LcuApi(await discoverConnection());
  const api = options.api ?? ownedApi;
  if (!api) throw new Error('无法连接游戏客户端');

  const concurrency = normalizeConcurrency(options.concurrency);
  const quiet = Boolean(options.quiet);
  if (!quiet) {
    logTag(
      'timeline',
      `开始回填 ${gameIds.length} 场时间线（并发 ${concurrency}，约需 ${
        Math.ceil(gameIds.length / Math.max(1, concurrency))
      } 秒）`,
    );
  }

  try {
    const championMap = await api
      .getChampionMap()
      .catch(() => new Map<number, ChampionSummary>());
    const championNames = new Map<number, string>();
    for (const [championId, champion] of championMap) {
      championNames.set(championId, champion.name);
    }

    let completed = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const gameId = gameIds[index];
        if (gameId === undefined) return;
        try {
          const [game, raw] = await Promise.all([
            api.getGame(gameId),
            api.getGameTimeline(gameId),
          ]);
          if (!raw.frames?.length) {
            result.skipped += 1;
            continue;
          }
          const timeline = parseMatchTimeline(game, raw, championNames);
          if (!timeline.players.length) {
            result.skipped += 1;
            continue;
          }
          timeline.gameId = gameId;
          if (await saveMatchTimeline(timeline)) result.saved += 1;
          else result.failed += 1;
        } catch (error) {
          result.failed += 1;
          if (!quiet) {
            logTag(
              'timeline',
              `[${gameId}] 回填失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        } finally {
          completed += 1;
          options.onProgress?.(completed, gameIds.length);
          if (!quiet && (completed % 20 === 0 || completed === gameIds.length)) {
            logTag(
              'timeline',
              `回填进度 ${completed}/${gameIds.length}：成功 ${result.saved}，跳过 ${result.skipped}，失败 ${result.failed}`,
            );
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, gameIds.length) }, () => worker()),
    );
  } finally {
    ownedApi?.destroy();
  }

  result.elapsedMs = Date.now() - started;
  if (!quiet) {
    logTag(
      'timeline',
      `时间线回填完成：${result.total} 场，新增 ${result.saved}，跳过 ${result.skipped}，失败 ${result.failed}，用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒`,
    );
  }
  return result;
}
