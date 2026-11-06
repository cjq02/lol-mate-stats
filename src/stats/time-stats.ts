import type { GameModeKey, MatchSummary } from '../types.js';
import { championRole } from './champion-roles.js';
import { modeFromQueue } from './constants.js';

/** 时段维度的 bucket 长度（小时） */
export const TIME_PERIOD_HOURS = 2;
/** 周 / 月趋势保留最近多少个 bucket */
const RECENT_WEEK_BUCKETS = 12;
const RECENT_MONTH_BUCKETS = 12;

/** 参与统计的最小对局信息 */
export interface TimeStatsGame {
  gameCreation: number;
  win: boolean;
  tags?: string[];
  /** 本局位置（TOP / JUNGLE / MID / ADC / SUPPORT / ARAM / ARENA / UNKNOWN） */
  position?: string;
  /** 本局使用的英雄，用于按英雄类型统计 */
  championId?: number;
  /** 重新按当前坑线判断的结果（历史 tags 可能仍是旧阈值） */
  teammateBad?: boolean;
  selfBad?: boolean;
}

export interface TimeStatsBucket {
  key: string;
  label: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  /** 本 bucket 里至少有一名队友被标记为坑/逃跑的对局数 */
  teammateBadGames: number;
  teammateBadRate: number;
  /** 本 bucket 里自己被标记为坑/逃跑的对局数 */
  selfBadGames: number;
  selfBadRate: number;
}

export type TimeStatsDimension =
  | 'hour'
  | 'weekday'
  | 'week'
  | 'month'
  | 'position'
  | 'type';

export interface TimeStatsDimensions {
  /** 一天内每两小时一段 */
  hour: TimeStatsBucket[];
  /** 周一至周日 */
  weekday: TimeStatsBucket[];
  /** 最近 12 周 */
  week: TimeStatsBucket[];
  /** 最近 12 个月 */
  month: TimeStatsBucket[];
  /** 上单 / 打野 / 中单 / ADC / 辅助等位置 */
  position: TimeStatsBucket[];
  /** 坦克 / 战士 / 输出 / 辅助等英雄类型 */
  type: TimeStatsBucket[];
}

export interface TimeStatsSummary {
  totalGames: number;
  wins: number;
  winRate: number;
  dimensions: TimeStatsDimensions;
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const POSITION_DEFINITIONS: Array<[string, string]> = [
  ['pos-top', '上单'],
  ['pos-jungle', '打野'],
  ['pos-mid', '中单'],
  ['pos-adc', 'ADC'],
  ['pos-support', '辅助'],
  ['pos-aram', '大乱斗'],
  ['pos-arena', '竞技场'],
  ['pos-unknown', '未知'],
];
const TYPE_DEFINITIONS: Array<[string, string]> = [
  ['type-tank', '坦克'],
  ['type-fighter', '战士'],
  ['type-carry', '输出'],
  ['type-support', '辅助'],
  ['type-default', '其他'],
];
const TEAMMATE_BAD_TAG = /^队友(?:小坑|坑|巨坑|逃跑)$/;
const SELF_BAD_TAG = /^自己(?:小坑|坑|巨坑|逃跑)$/;

function typeBucketKey(championId?: number): string {
  const id = Number(championId) || 0;
  const normalized = id >= 60000 ? id - 60000 : id;
  return `type-${championRole(normalized)}`;
}

function positionBucketKey(position?: string): string {
  switch (String(position ?? '').trim().toUpperCase()) {
    case 'TOP':
      return 'pos-top';
    case 'JUNGLE':
      return 'pos-jungle';
    case 'MIDDLE':
    case 'MID':
      return 'pos-mid';
    case 'BOTTOM':
    case 'ADC':
      return 'pos-adc';
    case 'UTILITY':
    case 'SUPPORT':
      return 'pos-support';
    case 'ARAM':
      return 'pos-aram';
    case 'ARENA':
      return 'pos-arena';
    default:
      return 'pos-unknown';
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function emptyBucket(key: string, label: string): TimeStatsBucket {
  return {
    key,
    label,
    games: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    teammateBadGames: 0,
    teammateBadRate: 0,
    selfBadGames: 0,
    selfBadRate: 0,
  };
}

function finalizeBucket(bucket: TimeStatsBucket): TimeStatsBucket {
  bucket.losses = bucket.games - bucket.wins;
  bucket.winRate = bucket.games ? bucket.wins / bucket.games : 0;
  bucket.teammateBadRate = bucket.games ? bucket.teammateBadGames / bucket.games : 0;
  bucket.selfBadRate = bucket.games ? bucket.selfBadGames / bucket.games : 0;
  return bucket;
}

function addGame(
  bucket: TimeStatsBucket,
  win: boolean,
  teammateBad: boolean,
  selfBad: boolean,
): void {
  bucket.games += 1;
  bucket.wins += win ? 1 : 0;
  bucket.teammateBadGames += teammateBad ? 1 : 0;
  bucket.selfBadGames += selfBad ? 1 : 0;
}

/** 本地时间周一 00:00 */
function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  return start;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function weekLabel(start: Date): string {
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `${pad(start.getMonth() + 1)}/${pad(start.getDate())}-${pad(end.getMonth() + 1)}/${pad(end.getDate())}`;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function buildRecentWeeks(
  latestTimestamp: number,
  bucketsByKey: Map<string, TimeStatsBucket>,
): TimeStatsBucket[] {
  const anchor = startOfWeek(new Date(latestTimestamp || Date.now()));
  const result: TimeStatsBucket[] = [];
  for (let offset = RECENT_WEEK_BUCKETS - 1; offset >= 0; offset -= 1) {
    const start = new Date(anchor);
    start.setDate(anchor.getDate() - offset * 7);
    const key = dateKey(start);
    result.push(bucketsByKey.get(key) ?? emptyBucket(key, weekLabel(start)));
  }
  return result;
}

function buildRecentMonths(
  latestTimestamp: number,
  bucketsByKey: Map<string, TimeStatsBucket>,
): TimeStatsBucket[] {
  const anchor = new Date(latestTimestamp || Date.now());
  const result: TimeStatsBucket[] = [];
  for (let offset = RECENT_MONTH_BUCKETS - 1; offset >= 0; offset -= 1) {
    const start = new Date(anchor.getFullYear(), anchor.getMonth() - offset, 1);
    const key = monthKey(start);
    result.push(bucketsByKey.get(key) ?? emptyBucket(key, key));
  }
  return result;
}

/**
 * 按本地时间统计多个维度：一天内时段、星期、最近 12 周、最近 12 个月。
 * 重开对局不计入；坑率按存档里的队友/自己坑与逃跑标签计算。
 */
export function summarizeTimeStats(games: TimeStatsGame[]): TimeStatsSummary {
  const hourBuckets = Array.from({ length: 24 / TIME_PERIOD_HOURS }, (_, index) => {
    const startHour = index * TIME_PERIOD_HOURS;
    return emptyBucket(
      `h${startHour}`,
      `${pad(startHour)}:00-${pad(startHour + TIME_PERIOD_HOURS)}:00`,
    );
  });
  const weekdayBuckets = WEEKDAY_LABELS.map((label, index) =>
    emptyBucket(`d${index + 1}`, label),
  );
  const positionBuckets = POSITION_DEFINITIONS.map(([key, label]) => emptyBucket(key, label));
  const positionByKey = new Map(positionBuckets.map((bucket) => [bucket.key, bucket]));
  const typeBuckets = TYPE_DEFINITIONS.map(([key, label]) => emptyBucket(key, label));
  const typeByKey = new Map(typeBuckets.map((bucket) => [bucket.key, bucket]));
  const weekBuckets = new Map<string, TimeStatsBucket>();
  const monthBuckets = new Map<string, TimeStatsBucket>();

  let totalGames = 0;
  let totalWins = 0;
  let latestTimestamp = 0;

  for (const game of games) {
    const tags = Array.isArray(game.tags) ? game.tags : [];
    // 重开不计入胜负和坑率
    if (tags.includes('重开')) continue;
    const timestamp = Number(game.gameCreation);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;

    const date = new Date(timestamp);
    const win = Boolean(game.win);
    const teammateBad =
      Boolean(game.teammateBad) || tags.some((tag) => TEAMMATE_BAD_TAG.test(tag));
    const selfBad = Boolean(game.selfBad) || tags.some((tag) => SELF_BAD_TAG.test(tag));
    latestTimestamp = Math.max(latestTimestamp, timestamp);

    const hourIndex = Math.min(
      hourBuckets.length - 1,
      Math.max(0, Math.floor(date.getHours() / TIME_PERIOD_HOURS)),
    );
    const hourBucket = hourBuckets[hourIndex];
    if (hourBucket) addGame(hourBucket, win, teammateBad, selfBad);

    const weekdayIndex = (date.getDay() + 6) % 7;
    const weekdayBucket = weekdayBuckets[weekdayIndex];
    if (weekdayBucket) addGame(weekdayBucket, win, teammateBad, selfBad);

    const positionBucket = positionByKey.get(positionBucketKey(game.position));
    if (positionBucket) addGame(positionBucket, win, teammateBad, selfBad);

    const typeBucket = typeByKey.get(typeBucketKey(game.championId));
    if (typeBucket) addGame(typeBucket, win, teammateBad, selfBad);

    const weekStart = startOfWeek(date);
    const weekKey = dateKey(weekStart);
    const weekBucket = weekBuckets.get(weekKey) ?? emptyBucket(weekKey, weekLabel(weekStart));
    weekBuckets.set(weekKey, weekBucket);
    addGame(weekBucket, win, teammateBad, selfBad);

    const month = monthKey(date);
    const monthBucket = monthBuckets.get(month) ?? emptyBucket(month, month);
    monthBuckets.set(month, monthBucket);
    addGame(monthBucket, win, teammateBad, selfBad);

    totalGames += 1;
    totalWins += win ? 1 : 0;
  }

  return {
    totalGames,
    wins: totalWins,
    winRate: totalGames ? totalWins / totalGames : 0,
    dimensions: {
      hour: hourBuckets.map(finalizeBucket),
      weekday: weekdayBuckets.map(finalizeBucket),
      week: buildRecentWeeks(latestTimestamp, weekBuckets).map(finalizeBucket),
      month: buildRecentMonths(latestTimestamp, monthBuckets).map(finalizeBucket),
      position: positionBuckets.map(finalizeBucket),
      type: typeBuckets.map(finalizeBucket),
    },
  };
}

/** 把最近战绩列表转换成时段统计（本地存档不可用时的兜底） */
export function summarizeMatchSummaries(
  games: MatchSummary[],
  mode?: GameModeKey,
): TimeStatsSummary {
  const filtered = mode
    ? games.filter((game) => modeFromQueue(Number(game.queueId)) === mode)
    : games;
  return summarizeTimeStats(
    filtered.map((game) => ({
      gameCreation: Number(game.gameCreation) || 0,
      win: Boolean(game.win),
      tags: game.tags,
      position: game.position,
      championId: game.championId,
    })),
  );
}
