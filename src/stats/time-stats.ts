import type { GameModeKey, Grade, MatchSummary } from '../types.js';
import { championRoleProfile } from './champion-roles.js';
import { modeFromQueue } from './constants.js';
import { gradeOf } from './rating.js';

/** 时段维度的 bucket 长度（小时） */
export const TIME_PERIOD_HOURS = 2;
/** 天 / 周 / 月趋势保留最近多少个 bucket */
const RECENT_DAY_BUCKETS = 30;
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
  /** 本局单场评分（0-100），缺失时不参与平均分 */
  score?: number;
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
  /** 本 bucket 里带评分的对局数 */
  scoreGames: number;
  /** 平均单场评分 0-100（只统计带评分的对局） */
  avgScore: number;
  /** 带评分对局里的最高分 */
  bestScore: number;
  /** 带评分对局里的最低分 */
  worstScore: number;
  /** 均分对应的等级，没有评分样本时为空 */
  grade?: Grade;
}

export type TimeStatsDimension =
  | 'day'
  | 'week'
  | 'month'
  | 'hour'
  | 'weekday'
  | 'position'
  | 'type';

export interface TimeStatsDimensions {
  /** 最近 30 天 */
  day: TimeStatsBucket[];
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
  /** 坦克 / 战士 / 法师 / 射手 / 刺客 / 辅助等英雄官方主分类 */
  type: TimeStatsBucket[];
}

export interface TimeStatsSummary {
  totalGames: number;
  wins: number;
  winRate: number;
  /** 全部对局里带评分的场次 */
  scoreGames: number;
  /** 全部带评分对局的均分 */
  avgScore: number;
  dimensions: TimeStatsDimensions;
}

/** 六角星用的六项指标 */
export type TypeRadarMetricKey = 'kp' | 'gpm' | 'kda' | 'dtpm' | 'dpm' | 'hpm';

export interface TypeRadarMetric {
  label: string;
  /** 我的平均值 */
  self: number;
  /** 所有玩家的平均值 */
  all: number;
  /** 展示用短文本，例如 62% / 1.5k */
  selfText: string;
  allText: string;
}

export interface TypeRadarEntry {
  /** 与按英雄类型的 bucket key 一致（type-tank 等） */
  key: string;
  label: string;
  selfGames: number;
  allGames: number;
  metrics: TypeRadarMetric[];
}

export interface RadarComparisonSummary {
  games: number;
  winRate: number;
  avgScore: number;
  avgRank: number;
}

export interface ChampionRadarEntry {
  championId: number;
  selfGames: number;
  allGames: number;
  metrics: TypeRadarMetric[];
  /** 我和所有玩家在同一筛选条件下的胜率 / 平均分 / 平均排名 */
  self: RadarComparisonSummary;
  all: RadarComparisonSummary;
}

/** 按英雄分组后的一行原始数据，交给 buildTypeRadar 汇总 */
export interface TypeRadarSample {
  championId: number;
  allGames: number;
  selfGames: number;
  all: Record<TypeRadarMetricKey, number>;
  self: Record<TypeRadarMetricKey, number>;
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
  ['pos-unknown', '未分路'],
];
/** 英雄官方主分类 → 展示名，按英雄类型统计和六角星共用 */
export const CHAMPION_TYPE_LABELS: Record<string, string> = {
  'type-tank': '坦克',
  'type-fighter': '战士',
  'type-mage': '法师',
  'type-marksman': '射手',
  'type-assassin': '刺客',
  'type-support': '辅助',
  'type-default': '其他',
};
const TYPE_DEFINITIONS: Array<[string, string]> = Object.entries(CHAMPION_TYPE_LABELS);
/** 官方主分类；按英雄类型统计时不再把法师 / 射手 / 刺客合并成“输出” */
const TYPE_CLASS_KEYS = new Set(['tank', 'fighter', 'mage', 'marksman', 'assassin', 'support']);
const TEAMMATE_BAD_TAG = /^队友(?:小坑|很坑|坑|巨坑|逃跑)$/;
const SELF_BAD_TAG = /^自己(?:小坑|很坑|坑|巨坑|逃跑)$/;

/** 英雄 ID → type-tank / type-mage 等分类 key */
export function championTypeKey(championId?: number): string {
  const id = Number(championId) || 0;
  const normalized = id >= 60000 ? id - 60000 : id;
  const official = championRoleProfile(normalized).classes?.find((cls) =>
    TYPE_CLASS_KEYS.has(cls),
  );
  return `type-${official ?? 'default'}`;
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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
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
    scoreGames: 0,
    avgScore: 0,
    bestScore: 0,
    worstScore: 0,
  };
}

function finalizeBucket(bucket: TimeStatsBucket): TimeStatsBucket {
  bucket.losses = bucket.games - bucket.wins;
  bucket.winRate = bucket.games ? bucket.wins / bucket.games : 0;
  bucket.teammateBadRate = bucket.games ? bucket.teammateBadGames / bucket.games : 0;
  bucket.selfBadRate = bucket.games ? bucket.selfBadGames / bucket.games : 0;
  bucket.avgScore = bucket.scoreGames ? round1(bucket.avgScore) : 0;
  bucket.grade = bucket.scoreGames ? gradeOf(bucket.avgScore) : undefined;
  return bucket;
}

function addGame(
  bucket: TimeStatsBucket,
  win: boolean,
  teammateBad: boolean,
  selfBad: boolean,
  score?: number,
): void {
  bucket.games += 1;
  bucket.wins += win ? 1 : 0;
  bucket.teammateBadGames += teammateBad ? 1 : 0;
  bucket.selfBadGames += selfBad ? 1 : 0;
  if (typeof score === 'number' && Number.isFinite(score) && score > 0) {
    const shown = Math.min(100, score);
    bucket.bestScore = bucket.scoreGames ? Math.max(bucket.bestScore, shown) : shown;
    bucket.worstScore = bucket.scoreGames ? Math.min(bucket.worstScore, shown) : shown;
    bucket.avgScore = (bucket.avgScore * bucket.scoreGames + shown) / (bucket.scoreGames + 1);
    bucket.scoreGames += 1;
  }
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

function dayLabel(date: Date): string {
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

function weekLabel(start: Date): string {
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `${pad(start.getMonth() + 1)}/${pad(start.getDate())}-${pad(end.getMonth() + 1)}/${pad(end.getDate())}`;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function buildRecentDays(
  latestTimestamp: number,
  bucketsByKey: Map<string, TimeStatsBucket>,
): TimeStatsBucket[] {
  const anchor = new Date(latestTimestamp || Date.now());
  const startOfDay = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const result: TimeStatsBucket[] = [];
  for (let offset = RECENT_DAY_BUCKETS - 1; offset >= 0; offset -= 1) {
    const day = new Date(startOfDay);
    day.setDate(startOfDay.getDate() - offset);
    const key = dateKey(day);
    result.push(bucketsByKey.get(key) ?? emptyBucket(key, dayLabel(day)));
  }
  return result;
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
 * 按本地时间统计多个维度：最近 30 天、一天内时段、星期、最近 12 周、最近 12 个月。
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
  const dayBuckets = new Map<string, TimeStatsBucket>();
  const weekBuckets = new Map<string, TimeStatsBucket>();
  const monthBuckets = new Map<string, TimeStatsBucket>();

  let totalGames = 0;
  let totalWins = 0;
  let totalScoreGames = 0;
  let totalScore = 0;
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
    const rawScore = Number(game.score);
    const score =
      Number.isFinite(rawScore) && rawScore > 0 ? Math.min(100, rawScore) : undefined;
    latestTimestamp = Math.max(latestTimestamp, timestamp);

    const hourIndex = Math.min(
      hourBuckets.length - 1,
      Math.max(0, Math.floor(date.getHours() / TIME_PERIOD_HOURS)),
    );
    const hourBucket = hourBuckets[hourIndex];
    if (hourBucket) addGame(hourBucket, win, teammateBad, selfBad, score);

    const weekdayIndex = (date.getDay() + 6) % 7;
    const weekdayBucket = weekdayBuckets[weekdayIndex];
    if (weekdayBucket) addGame(weekdayBucket, win, teammateBad, selfBad, score);

    const positionBucket = positionByKey.get(positionBucketKey(game.position));
    if (positionBucket) addGame(positionBucket, win, teammateBad, selfBad, score);

    const typeBucket = typeByKey.get(championTypeKey(game.championId));
    if (typeBucket) addGame(typeBucket, win, teammateBad, selfBad, score);

    const weekStart = startOfWeek(date);
    const weekKey = dateKey(weekStart);
    const weekBucket = weekBuckets.get(weekKey) ?? emptyBucket(weekKey, weekLabel(weekStart));
    weekBuckets.set(weekKey, weekBucket);
    addGame(weekBucket, win, teammateBad, selfBad, score);

    const dayKey = dateKey(date);
    const dayBucket = dayBuckets.get(dayKey) ?? emptyBucket(dayKey, dayLabel(date));
    dayBuckets.set(dayKey, dayBucket);
    addGame(dayBucket, win, teammateBad, selfBad, score);

    const month = monthKey(date);
    const monthBucket = monthBuckets.get(month) ?? emptyBucket(month, month);
    monthBuckets.set(month, monthBucket);
    addGame(monthBucket, win, teammateBad, selfBad, score);

    totalGames += 1;
    totalWins += win ? 1 : 0;
    if (score !== undefined) {
      totalScoreGames += 1;
      totalScore += score;
    }
  }

  return {
    totalGames,
    wins: totalWins,
    winRate: totalGames ? totalWins / totalGames : 0,
    scoreGames: totalScoreGames,
    avgScore: totalScoreGames ? round1(totalScore / totalScoreGames) : 0,
    dimensions: {
      day: buildRecentDays(latestTimestamp, dayBuckets).map(finalizeBucket),
      hour: hourBuckets.map(finalizeBucket),
      weekday: weekdayBuckets.map(finalizeBucket),
      week: buildRecentWeeks(latestTimestamp, weekBuckets).map(finalizeBucket),
      month: buildRecentMonths(latestTimestamp, monthBuckets).map(finalizeBucket),
      position: positionBuckets.map(finalizeBucket),
      type: typeBuckets.map(finalizeBucket),
    },
  };
}

const TYPE_RADAR_METRICS: Array<{
  key: TypeRadarMetricKey;
  label: string;
  format: (value: number) => string;
}> = [
  { key: 'kp', label: '参团', format: (value) => `${Math.round(value)}%` },
  { key: 'gpm', label: '经济', format: compactRadarValue },
  { key: 'kda', label: 'KDA', format: (value) => value.toFixed(2) },
  { key: 'dtpm', label: '承伤', format: compactRadarValue },
  { key: 'dpm', label: '伤害', format: compactRadarValue },
  { key: 'hpm', label: '治疗', format: compactRadarValue },
];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function compactRadarValue(value: number): string {
  const number = Number(value) || 0;
  if (number <= 0) return '0';
  if (number >= 1000) {
    return `${(number / 1000).toFixed(2)}k`;
  }
  if (number >= 100) return String(Math.round(number));
  if (number >= 10) return number.toFixed(0);
  return number.toFixed(1);
}

function radarMetrics(
  self: Record<TypeRadarMetricKey, number>,
  all: Record<TypeRadarMetricKey, number>,
): TypeRadarMetric[] {
  return TYPE_RADAR_METRICS.map((metric) => {
    const selfValue = Number(self[metric.key]) || 0;
    const allValue = Number(all[metric.key]) || 0;
    const round = metric.key === 'kda' ? round2 : round1;
    return {
      label: metric.label,
      self: round(selfValue),
      all: round(allValue),
      selfText: metric.format(selfValue),
      allText: metric.format(allValue),
    };
  });
}

/**
 * 按英雄官方主分类汇总我和所有玩家的六项指标。
 * 每个英雄先由 SQL 算出平均值，再按场次加权合并到同一类型，避免小样本英雄被放大。
 */
export function buildTypeRadar(samples: TypeRadarSample[]): TypeRadarEntry[] {
  const accumulators = new Map<
    string,
    {
      allGames: number;
      selfGames: number;
      all: Record<TypeRadarMetricKey, number>;
      self: Record<TypeRadarMetricKey, number>;
    }
  >();
  for (const key of Object.keys(CHAMPION_TYPE_LABELS)) {
    accumulators.set(key, {
      allGames: 0,
      selfGames: 0,
      all: { kp: 0, gpm: 0, kda: 0, dtpm: 0, dpm: 0, hpm: 0 },
      self: { kp: 0, gpm: 0, kda: 0, dtpm: 0, dpm: 0, hpm: 0 },
    });
  }

  for (const sample of samples) {
    const entry = accumulators.get(championTypeKey(sample.championId));
    if (!entry) continue;
    const allGames = Math.max(0, Number(sample.allGames) || 0);
    const selfGames = Math.max(0, Number(sample.selfGames) || 0);
    entry.allGames += allGames;
    entry.selfGames += selfGames;
    for (const metric of TYPE_RADAR_METRICS) {
      entry.all[metric.key] += (Number(sample.all[metric.key]) || 0) * allGames;
      entry.self[metric.key] += (Number(sample.self[metric.key]) || 0) * selfGames;
    }
  }

  return Object.entries(CHAMPION_TYPE_LABELS).map(([key, label]) => {
    const entry = accumulators.get(key);
    const self: Record<TypeRadarMetricKey, number> = {
      kp: 0,
      gpm: 0,
      kda: 0,
      dtpm: 0,
      dpm: 0,
      hpm: 0,
    };
    const all: Record<TypeRadarMetricKey, number> = {
      kp: 0,
      gpm: 0,
      kda: 0,
      dtpm: 0,
      dpm: 0,
      hpm: 0,
    };
    if (entry) {
      for (const metric of TYPE_RADAR_METRICS) {
        self[metric.key] = entry.selfGames
          ? (entry.self[metric.key] ?? 0) / entry.selfGames
          : 0;
        all[metric.key] = entry.allGames
          ? (entry.all[metric.key] ?? 0) / entry.allGames
          : 0;
      }
    }
    return {
      key,
      label,
      selfGames: entry?.selfGames ?? 0,
      allGames: entry?.allGames ?? 0,
      metrics: radarMetrics(self, all),
    };
  });
}

/** 单个英雄的六角星：直接用 SQL 已经算好的我和所有玩家平均值 */
export function buildChampionRadar(
  sample: TypeRadarSample,
  championId: number,
  summary: { self: RadarComparisonSummary; all: RadarComparisonSummary },
): ChampionRadarEntry {
  return {
    championId,
    selfGames: sample.selfGames,
    allGames: sample.allGames,
    metrics: radarMetrics(sample.self, sample.all),
    self: summary.self,
    all: summary.all,
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
      score: game.score,
    })),
  );
}
