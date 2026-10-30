import type {
  AnalyzedGame,
  Grade,
  Lane,
  RecentSummary,
  RiskAssessment,
  Streak,
  TopChampion,
} from '../types.js';
import { clamp, round } from '../util.js';
import { LANE_NAMES } from './constants.js';

interface MetricProfile {
  kda: number;
  damageShare: number;
  damagePerMin: number;
  tankShare: number;
  killParticipation: number;
  csPerMin: number;
  visionPerMin: number;
}

export interface Profile {
  label: string;
  weight: MetricProfile;
  target: MetricProfile;
}

/**
 * 分位置的评分基准：
 * - target 大致对应“该位置表现不错（前 30% 左右）”的水平
 * - weight 之和为 1
 * - damagePerMin 是绝对伤害，避免“队友都低所以伤害占比看起来还行”的情况
 */
export const PROFILES: Record<Lane, Profile> = {
  TOP: {
    label: '上单',
    weight: { kda: 0.18, damageShare: 0.2, damagePerMin: 0.15, tankShare: 0.13, killParticipation: 0.14, csPerMin: 0.12, visionPerMin: 0.08 },
    target: { kda: 3.0, damageShare: 0.22, damagePerMin: 550, tankShare: 0.27, killParticipation: 0.5, csPerMin: 6.5, visionPerMin: 0.9 },
  },
  JUNGLE: {
    label: '打野',
    weight: { kda: 0.2, damageShare: 0.15, damagePerMin: 0.13, tankShare: 0.08, killParticipation: 0.22, csPerMin: 0.12, visionPerMin: 0.1 },
    target: { kda: 3.2, damageShare: 0.18, damagePerMin: 500, tankShare: 0.2, killParticipation: 0.62, csPerMin: 5.2, visionPerMin: 1.05 },
  },
  MID: {
    label: '中单',
    weight: { kda: 0.2, damageShare: 0.22, damagePerMin: 0.18, tankShare: 0.06, killParticipation: 0.14, csPerMin: 0.12, visionPerMin: 0.08 },
    target: { kda: 3.2, damageShare: 0.27, damagePerMin: 650, tankShare: 0.16, killParticipation: 0.55, csPerMin: 6.8, visionPerMin: 0.85 },
  },
  ADC: {
    label: 'ADC',
    weight: { kda: 0.18, damageShare: 0.24, damagePerMin: 0.2, tankShare: 0.06, killParticipation: 0.13, csPerMin: 0.12, visionPerMin: 0.07 },
    target: { kda: 3.0, damageShare: 0.3, damagePerMin: 700, tankShare: 0.14, killParticipation: 0.55, csPerMin: 7.5, visionPerMin: 0.75 },
  },
  SUPPORT: {
    label: '辅助',
    weight: { kda: 0.22, damageShare: 0.08, damagePerMin: 0.08, tankShare: 0.12, killParticipation: 0.22, csPerMin: 0.04, visionPerMin: 0.24 },
    target: { kda: 3.5, damageShare: 0.12, damagePerMin: 380, tankShare: 0.18, killParticipation: 0.62, csPerMin: 1.5, visionPerMin: 1.6 },
  },
  ARAM: {
    label: '大乱斗',
    // 大乱斗没有眼位，视野分不参与评分
    weight: { kda: 0.24, damageShare: 0.26, damagePerMin: 0.2, tankShare: 0.1, killParticipation: 0.18, csPerMin: 0.02, visionPerMin: 0 },
    target: { kda: 3.3, damageShare: 0.26, damagePerMin: 850, tankShare: 0.22, killParticipation: 0.65, csPerMin: 3.0, visionPerMin: 0.8 },
  },
  ARENA: {
    label: '竞技场',
    weight: { kda: 0.26, damageShare: 0.24, damagePerMin: 0.18, tankShare: 0.08, killParticipation: 0.16, csPerMin: 0.02, visionPerMin: 0.06 },
    target: { kda: 3.0, damageShare: 0.3, damagePerMin: 900, tankShare: 0.22, killParticipation: 0.6, csPerMin: 3.0, visionPerMin: 0.6 },
  },
  UNKNOWN: {
    label: '综合',
    weight: { kda: 0.2, damageShare: 0.2, damagePerMin: 0.16, tankShare: 0.08, killParticipation: 0.16, csPerMin: 0.12, visionPerMin: 0.08 },
    target: { kda: 3.1, damageShare: 0.24, damagePerMin: 550, tankShare: 0.2, killParticipation: 0.55, csPerMin: 5.0, visionPerMin: 1.0 },
  },
};

export interface PerformanceInput {
  kda: number;
  damageShare: number;
  damagePerMin: number;
  tankShare: number;
  killParticipation: number;
  csPerMin: number;
  visionPerMin: number;
  win: boolean;
}

/** 单项达成率：达到基准记 100 分，最高 130 分，避免碾压局无限拉高 */
function ratio(value: number, target: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) return 0;
  return clamp(value / target, 0, 1.3) * 100;
}

export function performanceScore(input: PerformanceInput, lane: Lane): number {
  const profile = PROFILES[lane] ?? PROFILES.UNKNOWN;
  const w = profile.weight;
  const t = profile.target;

  const weighted =
    w.kda * ratio(input.kda, t.kda) +
    w.damageShare * ratio(input.damageShare, t.damageShare) +
    w.damagePerMin * ratio(input.damagePerMin, t.damagePerMin) +
    w.tankShare * ratio(input.tankShare, t.tankShare) +
    w.killParticipation * ratio(input.killParticipation, t.killParticipation) +
    w.csPerMin * ratio(input.csPerMin, t.csPerMin) +
    w.visionPerMin * ratio(input.visionPerMin, t.visionPerMin);

  // 表现分映射到 0-100，胜利 +10 / 失败 -5（单纯输赢不足以决定评分）
  return round(clamp(weighted * 0.8 + (input.win ? 10 : 0) - 5, 0, 100), 1);
}

export function gradeOf(rating: number): Grade {
  if (rating >= 78) return 'S';
  if (rating >= 68) return 'A';
  if (rating >= 58) return 'B';
  if (rating >= 48) return 'C';
  return 'D';
}

export function gradeLabel(grade: Grade): string {
  switch (grade) {
    case 'S':
      return '表现优异';
    case 'A':
      return '状态不错';
    case 'B':
      return '中规中矩';
    case 'C':
      return '表现一般';
    case 'D':
      return '状态低迷';
  }
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface AccountSignals {
  /** 账号等级，仅作为“新手”的弱信号 */
  level?: number;
}

/** 大乱斗/竞技场没有常规眼位，不参考视野数据 */
export function appliesVision(position: Lane): boolean {
  return position !== 'ARAM' && position !== 'ARENA';
}

/** 大乱斗/竞技场死亡次数天然偏高，不据此打负面标签 */
function deathTagsApply(position: Lane | undefined): boolean {
  return position !== 'ARAM' && position !== 'ARENA';
}

/**
 * 官方战绩接口没有挂机标记，这里只用“明显异常”的对局做推断：
 * 时长 ≥ 8 分钟，且伤害、经济、补刀、参团、视野同时极低。
 * 宁可漏判，也不要把被针对/辅助玩家误标成挂机。
 */
export function isAfkLike(game: AnalyzedGame): boolean {
  if (game.durationMin < 8) return false;
  const goldPerMin = game.gold / Math.max(1, game.durationMin);
  const checks = [
    game.damagePerMin < 150,
    goldPerMin < 220,
    game.csPerMin < 1.2,
    game.kills + game.assists <= 1,
  ];
  if (appliesVision(game.position)) checks.push(game.visionPerMin < 0.35);
  const hits = checks.filter(Boolean).length;
  return (
    hits >= checks.length ||
    (hits >= checks.length - 1 && game.kills + game.deaths + game.assists === 0)
  );
}

export function summarize(games: AnalyzedGame[], signals: AccountSignals = {}): RecentSummary {
  const sorted = [...games].sort((a, b) => b.gameCreation - a.gameCreation);
  const wins = sorted.filter((game) => game.win).length;
  const losses = sorted.length - wins;

  // 越近的对局权重越高
  let weightSum = 0;
  let weightedScore = 0;
  sorted.forEach((game, index) => {
    const weight = 0.92 ** index;
    weightedScore += game.score * weight;
    weightSum += weight;
  });
  let rating = weightSum > 0 ? weightedScore / weightSum : 0;

  // 样本太少时向 55 分回归，避免 2 连胜就显示“大腿”
  if (sorted.length > 0 && sorted.length < 5) {
    const blend = ((5 - sorted.length) / 5) * 0.5;
    rating = rating * (1 - blend) + 55 * blend;
  }

  const streak = computeStreak(sorted);
  const avgDeaths = average(sorted.map((game) => game.deaths));
  const avgKda = average(sorted.map((game) => game.kda));
  const avgDamage = average(sorted.map((game) => game.damage));
  const avgDamagePerMin = average(sorted.map((game) => game.damagePerMin));
  const avgDamageShare = average(sorted.map((game) => game.damageShare));
  const avgKillParticipation = average(sorted.map((game) => game.killParticipation));
  const avgCsPerMin = average(sorted.map((game) => game.csPerMin));
  const avgVisionPerMin = average(sorted.map((game) => game.visionPerMin));
  const avgHeal = average(sorted.map((game) => game.heal));
  const avgDurationMin = average(sorted.map((game) => game.durationMin));
  const avgAssists = average(sorted.map((game) => game.assists));
  const avgTankShare = average(sorted.map((game) => game.tankShare));
  const avgScore = average(sorted.map((game) => game.score));
  const uniqueChampions = new Set(sorted.map((game) => game.championId)).size;
  const topChampions = buildTopChampions(sorted);
  const winRate = sorted.length ? wins / sorted.length : 0;
  const afkGames = sorted.filter(isAfkLike).length;
  const afkRate = sorted.length ? afkGames / sorted.length : 0;

  const positionCounts = new Map<Lane, number>();
  for (const game of sorted) {
    if (game.position === 'ARAM' || game.position === 'ARENA' || game.position === 'UNKNOWN') continue;
    positionCounts.set(game.position, (positionCounts.get(game.position) ?? 0) + 1);
  }
  const positionGames = [...positionCounts.values()].reduce((sum, count) => sum + count, 0);
  const [mainPosition, mainPositionCount] =
    [...positionCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  const mainPositionShare = positionGames ? (mainPositionCount ?? 0) / positionGames : 0;

  const nightGames = sorted.filter((game) => {
    const hour = new Date(game.gameCreation).getHours();
    return hour >= 0 && hour < 6;
  }).length;
  const rankedGames = sorted.filter((game) => game.queueId === 420 || game.queueId === 440).length;
  const recentScore = average(sorted.slice(0, 5).map((game) => game.score));
  const olderScore =
    sorted.length >= 10 ? average(sorted.slice(5, 10).map((game) => game.score)) : undefined;
  const scoreTrend = olderScore === undefined ? undefined : recentScore - olderScore;

  const ratingRounded = Math.round(clamp(rating, 0, 100));
  const profileGames = sorted.filter((game) => game.position !== 'ARAM' && game.position !== 'ARENA');
  const aramGames = sorted.filter((game) => game.position === 'ARAM').length;
  const risk = assessRisk(sorted, {
    avgDamagePerMin,
    avgDamageShare,
    avgCsPerMin,
    avgVisionPerMin,
    avgDeaths,
    avgKillParticipation,
    winRate,
    level: signals.level,
  });

  const labels = buildLabels(
    {
      games: sorted.length,
      winRate,
      rating: ratingRounded,
      avgKda,
      avgDeaths,
      avgDamagePerMin,
      avgDamageShare,
      avgKillParticipation,
      avgCsPerMin,
      avgVisionPerMin,
      avgAssists,
      avgTankShare,
      avgScore,
      uniqueChampions,
      topChampions,
      mainPosition,
      mainPositionShare,
      positionGames,
      nightGames,
      rankedGames,
      scoreTrend,
      aramGames,
      profileGames: profileGames.length,
      streak,
      risk,
      afkGames,
      afkRate,
    },
    sorted[0]?.position ?? 'UNKNOWN',
  );

  return {
    games: sorted.length,
    wins,
    losses,
    winRate,
    afkGames,
    afkRate,
    avgKda: round(avgKda, 2),
    avgScore: round(avgScore, 1),
    avgDamage: Math.round(avgDamage),
    avgDamagePerMin: Math.round(avgDamagePerMin),
    avgDamageShare,
    avgKillParticipation,
    avgCsPerMin: round(avgCsPerMin, 1),
    avgVisionPerMin: round(avgVisionPerMin, 2),
    avgDeaths: round(avgDeaths, 1),
    avgHeal: Math.round(avgHeal),
    avgDurationMin: round(avgDurationMin, 1),
    streak,
    rating: ratingRounded,
    grade: gradeOf(ratingRounded),
    labels,
    risk,
    topChampions,
  };
}

/* ------------------------------------------------------------------ */
/* 坑指数                                                              */
/* ------------------------------------------------------------------ */

interface RiskAverages {
  avgDamagePerMin: number;
  avgDamageShare: number;
  avgCsPerMin: number;
  avgVisionPerMin: number;
  avgDeaths: number;
  avgKillParticipation: number;
  winRate: number;
  level?: number;
}

/** 单场“不达标”权重：>=2.2 算明显不达标，>=3.6 算严重不达标 */
function gameDeficit(game: AnalyzedGame): number {
  const profile = PROFILES[game.position] ?? PROFILES.UNKNOWN;
  const target = profile.target;
  let flags = 0;

  if (game.damagePerMin < target.damagePerMin * 0.38) flags += 2.0;
  else if (game.damagePerMin < target.damagePerMin * 0.6) flags += 1.1;

  if (game.position === 'TOP' || game.position === 'JUNGLE' || game.position === 'MID' || game.position === 'ADC') {
    if (game.csPerMin < target.csPerMin * 0.35) flags += 1.4;
    else if (game.csPerMin < target.csPerMin * 0.55) flags += 0.7;
  }

  if (game.deaths >= 10) flags += 1.0;
  else if (game.deaths >= 8) flags += 0.5;

  if (game.killParticipation < 0.3) flags += 1.0;
  else if (game.killParticipation < 0.4) flags += 0.5;

  if (appliesVision(game.position)) {
    if (game.visionPerMin < target.visionPerMin * 0.35) flags += 0.8;
    else if (game.visionPerMin < target.visionPerMin * 0.55) flags += 0.4;
  }

  return flags;
}

function assessRisk(games: AnalyzedGame[], averages: RiskAverages): RiskAssessment {
  if (!games.length) {
    return { score: 0, level: 'low', reasons: [], badGames: 0, severeGames: 0, newbie: false };
  }

  let badGames = 0;
  let severeGames = 0;
  for (const game of games) {
    const deficit = gameDeficit(game);
    if (deficit >= 3.6) severeGames += 1;
    if (deficit >= 2.2) badGames += 1;
  }

  const badRatio = badGames / games.length;
  const severeRatio = severeGames / games.length;
  let score = 100 * (0.6 * badRatio + 0.4 * severeRatio);

  const latest = games[0] as AnalyzedGame;
  const reference = PROFILES[latest.position] ?? PROFILES.UNKNOWN;
  const weakDamage = reference.target.damagePerMin * 0.6;
  const weakCs = reference.target.csPerMin * 0.55;
  const weakVision = reference.target.visionPerMin * 0.55;

  if (averages.avgDeaths >= 8) score += 5;
  if (averages.winRate <= 0.3 && games.length >= 5) score += 4;
  if (averages.avgDamagePerMin < weakDamage) score += 4;
  if (averages.level !== undefined && averages.level < 40 && score >= 25) score += 8;

  // 样本太少时不要直接判死刑
  if (games.length < 3) score = Math.min(score, 45);
  score = Math.round(clamp(score, 0, 100));

  const level: RiskAssessment['level'] =
    score >= 65 ? 'severe' : score >= 45 ? 'high' : score >= 25 ? 'medium' : 'low';

  const reasons: string[] = [];
  const csApplies = latest.position !== 'SUPPORT' && latest.position !== 'ARAM' && latest.position !== 'ARENA';
  const visionApplies = appliesVision(latest.position);

  if (averages.avgDamagePerMin < weakDamage) {
    reasons.push(`分均伤害 ${Math.round(averages.avgDamagePerMin)}（参考 ≥${Math.round(weakDamage)}）`);
  }
  if (averages.avgDamageShare < 0.15) {
    reasons.push(`伤害占比 ${Math.round(averages.avgDamageShare * 100)}%`);
  }
  if (csApplies && averages.avgCsPerMin < weakCs) {
    reasons.push(`分均补刀 ${averages.avgCsPerMin.toFixed(1)}（参考 ≥${weakCs.toFixed(1)}）`);
  }
  if (averages.avgDeaths >= 7.5) reasons.push(`场均死亡 ${averages.avgDeaths.toFixed(1)}`);
  if (averages.avgKillParticipation < 0.42) {
    reasons.push(`参团率 ${Math.round(averages.avgKillParticipation * 100)}%`);
  }
  if (visionApplies && averages.avgVisionPerMin < weakVision) {
    reasons.push(`分均视野 ${averages.avgVisionPerMin.toFixed(2)}`);
  }
  if (averages.level !== undefined && averages.level < 40) {
    reasons.push(`账号等级 Lv.${averages.level}`);
  }
  if (averages.winRate <= 0.3 && games.length >= 5) {
    reasons.push(`近 ${games.length} 场胜率 ${Math.round(averages.winRate * 100)}%`);
  }

  if (!reasons.length && level !== 'low') {
    reasons.push(`${badGames}/${games.length} 场多项数据低于同位置参考值`);
  }

  const newbie =
    averages.level !== undefined &&
    averages.level < 50 &&
    (score >= 30 || averages.avgCsPerMin < weakCs * 0.8 || averages.avgDamagePerMin < weakDamage * 0.8);

  return {
    score,
    level,
    reasons: reasons.slice(0, 5),
    badGames,
    severeGames,
    newbie,
  };
}

/* ------------------------------------------------------------------ */

function computeStreak(games: AnalyzedGame[]): Streak | null {
  const first = games[0];
  if (!first) return null;
  let count = 0;
  for (const game of games) {
    if (game.win === first.win) count += 1;
    else break;
  }
  return { type: first.win ? 'win' : 'loss', count };
}

function buildTopChampions(games: AnalyzedGame[]): TopChampion[] {
  const map = new Map<number, { name: string; games: number; wins: number; kda: number }>();
  for (const game of games) {
    const entry = map.get(game.championId) ?? {
      name: game.championName,
      games: 0,
      wins: 0,
      kda: 0,
    };
    entry.games += 1;
    entry.wins += game.win ? 1 : 0;
    entry.kda += game.kda;
    map.set(game.championId, entry);
  }

  return [...map.entries()]
    .map(([championId, entry]) => ({
      championId,
      name: entry.name,
      games: entry.games,
      wins: entry.wins,
      winRate: entry.games ? entry.wins / entry.games : 0,
      avgKda: round(entry.kda / Math.max(1, entry.games), 2),
    }))
    .sort((a, b) => b.games - a.games || b.winRate - a.winRate)
    .slice(0, 3);
}

interface LabelInput {
  games: number;
  winRate: number;
  rating: number;
  avgKda: number;
  avgDeaths: number;
  avgDamagePerMin: number;
  avgDamageShare: number;
  avgKillParticipation: number;
  avgCsPerMin: number;
  avgVisionPerMin: number;
  avgAssists: number;
  avgTankShare: number;
  avgScore: number;
  uniqueChampions: number;
  topChampions: TopChampion[];
  mainPosition?: Lane;
  mainPositionShare: number;
  positionGames: number;
  nightGames: number;
  rankedGames: number;
  scoreTrend?: number;
  aramGames: number;
  profileGames: number;
  streak: Streak | null;
  risk: RiskAssessment;
  afkGames: number;
  afkRate: number;
}

function buildLabels(input: LabelInput, lane: Lane): string[] {
  if (input.games === 0) return [];
  const labels: string[] = [];
  const profile = PROFILES[lane] ?? PROFILES.UNKNOWN;

  // 挂机 / 坑 / 新手判断优先展示
  if (input.afkGames >= 3 || (input.afkGames >= 2 && input.afkRate >= 0.25)) {
    labels.push('常挂机');
  } else if (input.afkGames >= 1) {
    labels.push('疑似挂机');
  }
  if (input.risk.level === 'severe') labels.push('坑');
  else if (input.risk.level === 'high') labels.push('偏坑');
  if (input.risk.newbie) labels.push('疑似新手');
  if (input.games <= 2) labels.push('样本较少');
  if (input.avgDamagePerMin < profile.target.damagePerMin * 0.45) labels.push('伤害过低');

  if (input.rating >= 75 && input.winRate >= 0.5) labels.push('大腿');
  else if (input.rating >= 68) labels.push('稳定');
  else if (input.rating < 45 && input.risk.level === 'low') labels.push('状态低迷');

  // 近期走势：最近 5 场对比更早 5 场
  if (input.games >= 10 && input.scoreTrend !== undefined) {
    if (input.scoreTrend >= 8) labels.push('状态回升');
    else if (input.scoreTrend <= -8) labels.push('状态下滑');
  }
  if (input.games >= 5 && input.avgScore >= 70 && input.winRate <= 0.4) {
    labels.push('空砍群主');
  }

  if (lane === 'ARAM') {
    // 大乱斗英雄随机，不判断英雄池；改用乱斗玩法标签
    if (input.avgScore >= 78) labels.push('乱斗战神');
    if (input.avgDamageShare >= 0.3 && input.avgDamagePerMin >= 1000) labels.push('乱斗炮台');
    if (input.avgDeaths >= 10 && input.avgDamageShare >= 0.22) labels.push('乱斗敢死队');
    if (input.avgTankShare >= 0.3) labels.push('乱斗前排');
    if (input.avgAssists >= 15) labels.push('乱斗辅助');
  } else {
    if (input.games >= 10 && input.uniqueChampions >= 8) labels.push('英雄海');
    else if (input.games >= 8 && input.uniqueChampions <= 2) labels.push('英雄勺');
    const top = input.topChampions[0];
    if (top && top.games >= 5 && top.winRate >= 0.7) labels.push('绝活哥');
  }

  if (deathTagsApply(lane) && input.games >= 5 && input.avgDeaths <= 3.5) labels.push('稳健');
  if (
    lane !== 'ARAM' &&
    lane !== 'ARENA' &&
    input.positionGames >= 5 &&
    input.mainPosition &&
    input.mainPositionShare >= 0.6
  ) {
    labels.push(`专精${LANE_NAMES[input.mainPosition] ?? ''}`);
  }
  if (input.games >= 5 && input.nightGames / input.games >= 0.6) labels.push('夜猫子');
  if (input.games >= 5 && input.rankedGames / input.games >= 0.8) labels.push('排位狂魔');

  if (input.avgKda >= 4.5) labels.push('KDA怪');
  if (deathTagsApply(lane) && input.avgDeaths >= 7.5) labels.push('容易暴毙');
  if (input.avgDamageShare >= 0.3 && input.avgDamagePerMin >= profile.target.damagePerMin * 0.8) {
    labels.push('输出核心');
  }
  if (input.avgKillParticipation >= 0.68) labels.push('团战积极');
  if (input.avgKillParticipation < 0.4 && input.games >= 4) labels.push('参团偏低');
  if (input.avgCsPerMin >= 8) labels.push('补刀机器');
  const visionApplies = appliesVision(lane);
  if (visionApplies && input.avgVisionPerMin >= 1.5) labels.push('视野大师');
  if (visionApplies && input.avgVisionPerMin < 0.5 && input.profileGames >= 4) labels.push('视野偏弱');
  if (input.winRate >= 0.7 && input.games >= 5) labels.push('状态火热');
  if (input.streak?.type === 'win' && input.streak.count >= 3) labels.push(`${input.streak.count}连胜`);
  if (input.streak?.type === 'loss' && input.streak.count >= 3) labels.push(`${input.streak.count}连败`);
  if (input.aramGames / input.games >= 0.6 && input.games >= 4) labels.push('大乱斗常客');

  return [...new Set(labels)].slice(0, 5);
}

export function gameTags(game: {
  win: boolean;
  score: number;
  kills?: number;
  deaths: number;
  assists?: number;
  kda: number;
  damageShare: number;
  damagePerMin?: number;
  tankShare?: number;
  killParticipation?: number;
  csPerMin?: number;
  durationMin?: number;
  position?: Lane;
  largestKillingSpree?: number;
  pentaKills?: number;
  quadraKills?: number;
  turretKills?: number;
  totalHeal?: number;
  firstBloodKill?: boolean;
}): string[] {
  const tags: string[] = [];
  const kills = game.kills ?? 0;
  const assists = game.assists ?? 0;

  if ((game.pentaKills ?? 0) > 0) tags.push('五杀');
  else if ((game.quadraKills ?? 0) > 0) tags.push('四杀');

  if (game.score >= 85) tags.push('MVP');
  else if (game.win && game.score < 45) tags.push('躺赢');
  else if (!game.win && game.score >= 70) tags.push('尽力局');

  if ((game.largestKillingSpree ?? 0) >= 8) tags.push('超神');
  if (game.deaths === 0 && kills + assists >= 5) tags.push('零死');
  // 大乱斗/竞技场死亡次数天然偏高，不据此打“超鬼”标签
  if (deathTagsApply(game.position) && game.deaths >= 10) tags.push('超鬼');
  if (game.score <= 25) tags.push('战犯');

  if (game.position === 'ARAM') {
    if (game.damageShare >= 0.3 && (game.damagePerMin ?? 0) >= 1000) tags.push('乱斗炮台');
    if (game.deaths >= 12 && ((game.killParticipation ?? 0) >= 0.5 || game.damageShare >= 0.2)) {
      tags.push('乱斗敢死队');
    }
    if ((game.totalHeal ?? 0) >= 6000) tags.push('乱斗奶妈');
  }

  if (assists >= 20 || (game.killParticipation ?? 0) >= 0.8) tags.push('助攻机器');
  if (game.damageShare >= 0.35) tags.push('伤害爆炸');
  if ((game.tankShare ?? 0) >= 0.35) tags.push('肉盾');
  if (
    (game.csPerMin ?? 0) >= 9 &&
    game.position !== 'SUPPORT' &&
    game.position !== 'ARAM' &&
    game.position !== 'ARENA'
  ) {
    tags.push('补刀怪');
  }
  if ((game.turretKills ?? 0) >= 5) tags.push('拆塔工');
  if (game.win && (game.durationMin ?? 0) > 0 && (game.durationMin ?? 0) <= 20) tags.push('速推局');
  if ((game.durationMin ?? 0) >= 40) tags.push('膀胱局');
  if (game.firstBloodKill) tags.push('一血');
  if (game.kda >= 6 && !game.win) tags.push('数据好看');
  if (game.damagePerMin !== undefined && game.damagePerMin < 200 && game.win) tags.push('混赢');
  return tags.slice(0, 3);
}
