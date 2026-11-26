import type {
  AnalyzedGame,
  Grade,
  Lane,
  PlayerBaseline,
  RecentSummary,
  RiskAssessment,
  Streak,
  TopChampion,
} from '../types.js';
import type { ChampionClass, ChampionRole, ChampionRoleProfile } from './champion-roles.js';
import { clamp, round } from '../util.js';
import { LANE_NAMES } from './constants.js';

/** 低于此分数算“很坑” */
export const BAD_GAME_SCORE = 25;
/** 略低于正常水平，算“小坑” */
export const MILD_BAD_GAME_SCORE = 30;
/** 多项数据严重不达标，算“巨坑” */
export const SEVERE_BAD_GAME_SCORE = 20;
/** 极端局评分封顶 */
export const CATASTROPHIC_SCORE_CAP = 12;
/** 挂机/逃跑成立时的评分上限，和极端局保持一致 */
export const AFK_SCORE_CAP = 12;

/** 经济转化：伤害占比 ÷ 经济占比 */
export const ECONOMY_EFFICIENCY_HIGH_RATIO = 1.3;
export const ECONOMY_EFFICIENCY_LOW_RATIO = 0.85;
/** 拿这么多经济才值得看转化率，避免辅助/坦克被误伤 */
export const ECONOMY_EFFICIENCY_MIN_GOLD_SHARE = 0.2;
/** 打出这么多伤害才给加分，避免低分局整体被抬 */
export const ECONOMY_EFFICIENCY_MIN_DAMAGE_SHARE = 0.2;
export const ECONOMY_EFFICIENCY_BONUS = 1.5;
export const ECONOMY_EFFICIENCY_DEDUCTION = 2;
/**
 * 经济/击杀/死亡等加减分累计后的上限，避免多条规则叠加。
 * 负战绩扣分不参与这个封顶，单独按净亏分档扣。
 */
export const MAX_SCORE_ADJUSTMENT = 4;

export interface ScoreAdjustment {
  key: 'economy' | 'kill' | 'death' | 'negative';
  label: string;
  value: number;
  /** 不参与 ±MAX_SCORE_ADJUSTMENT 封顶的独立扣分 */
  uncapped?: boolean;
}

interface KillDeathRule {
  kill?: { minKills: number; value: number };
  death?: { minShare: number; minDeaths: number; value: number };
}

/**
 * 人头/死亡按位置区别对待：
 * - 输出位拿人头是本职，击杀数高才加分；死亡代价最大
 * - 战士可以换命，死亡占比非常极端才扣
 * - 坦克/辅助不靠击杀加分；坦克要开团，死亡门槛更高
 * 击杀用绝对值，避免队伍总击杀高时把个人击杀稀释掉。
 * 负战绩（击杀 + 助攻 < 死亡）另按净亏分档扣分，见 NEGATIVE_KDA_RULES。
 */
const KILL_DEATH_RULES: Record<ChampionRole, KillDeathRule> = {
  carry: {
    kill: { minKills: 18, value: 1.5 },
    death: { minShare: 0.25, minDeaths: 8, value: -1.5 },
  },
  fighter: {
    kill: { minKills: 15, value: 1 },
    death: { minShare: 0.32, minDeaths: 12, value: -1 },
  },
  tank: {
    death: { minShare: 0.3, minDeaths: 13, value: -1 },
  },
  support: {
    death: { minShare: 0.25, minDeaths: 8, value: -1 },
  },
  default: {
    kill: { minKills: 15, value: 1 },
    death: { minShare: 0.3, minDeaths: 10, value: -1 },
  },
};

interface NegativeKdaRule {
  /** 净亏（死亡 - 击杀 - 助攻）达到这些值时分别扣下一档 */
  edges: [number, number, number, number];
  values: [number, number, number, number];
}

/**
 * 负战绩分档：死亡 > 击杀 + 助攻 时，按净亏 `死亡 - 击杀 - 助攻` 扣分。
 * 输出/辅助从净亏 1 起扣，战士 2 起，坦克 3 起；坦克开团本来就会多死，门槛最高。
 * 净亏 1-2 的局往往只是团战换命，第一档只扣 2 分；净亏越大扣得越重。
 * 这条扣分不参与 MAX_SCORE_ADJUSTMENT 的 ±4 封顶，否则会被击杀/经济加分抵消。
 */
const NEGATIVE_KDA_RULES: Record<ChampionRole, NegativeKdaRule> = {
  carry: { edges: [1, 3, 5, 8], values: [-2, -4, -6, -8] },
  support: { edges: [1, 3, 5, 8], values: [-2, -4, -6, -8] },
  fighter: { edges: [2, 4, 6, 10], values: [-2, -4, -6, -8] },
  tank: { edges: [3, 6, 9, 13], values: [-2, -4, -6, -8] },
  default: { edges: [1, 3, 5, 8], values: [-2, -4, -6, -8] },
};

/** 负战绩至少死这么多次才判断，避免短局或单次阵亡被当成送头 */
export const NEGATIVE_KDA_MIN_DEATHS = 5;

/** 负战绩分档扣分；缺少击杀/助攻数据时返回 0，避免误伤旧调用方 */
export function negativeKdaValue(input: MatchPercentileInput): number {
  if (input.kills === undefined || input.assists === undefined) return 0;
  const kills = Number(input.kills) || 0;
  const assists = Number(input.assists) || 0;
  const deaths = Number(input.deaths) || 0;
  if (deaths < NEGATIVE_KDA_MIN_DEATHS) return 0;
  const deficit = deaths - kills - assists;
  if (deficit <= 0) return 0;
  const rule = NEGATIVE_KDA_RULES[input.role ?? 'default'];
  for (let index = rule.edges.length - 1; index >= 0; index -= 1) {
    if (deficit >= rule.edges[index]) return rule.values[index];
  }
  return 0;
}

/**
 * 含刺客标签的英雄按刺客标准算击杀：
 * 刺客本来就以收人头为职责，15 杀就视为完成收割，不再等输出位的 18 杀。
 * 20 / 25 杀再根据参团率加码，只奖励真正参与击杀的刺客，避免收残局和抢人头被高估；
 * 大乱斗死亡天然偏高，所以不按死亡数打折。
 * 例如劫 / 阿卡丽 这类纯刺客，以及刀妹 / 剑圣这种战士 + 刺客。
 */
const ASSASSIN_KILL_TIERS = [
  { minKills: 25, minKillParticipation: 0.6, value: 3.5 },
  { minKills: 20, minKillParticipation: 0.55, value: 2.5 },
  { minKills: 15, minKillParticipation: 0, value: 1.5 },
];

/** 刺客击杀分：没有命中分档时返回 null，回落到主定位规则 */
function assassinKillValue(input: MatchPercentileInput): number | null {
  if (!input.classes?.includes('assassin')) return null;
  const kills = Number(input.kills) || 0;
  const killParticipation = Number(input.killParticipation) || 0;
  const tier = ASSASSIN_KILL_TIERS.find(
    (item) => kills >= item.minKills && killParticipation >= item.minKillParticipation,
  );
  return tier ? tier.value : null;
}

/** 人头/死亡加减分：击杀看绝对值，死亡看占比，负战绩按净亏分档扣分 */
export function killDeathAdjustments(
  input: MatchPercentileInput,
): ScoreAdjustment[] {
  const role = input.role ?? 'default';
  const rule = KILL_DEATH_RULES[role];
  const adjustments: ScoreAdjustment[] = [];
  const kills = Number(input.kills) || 0;
  const deaths = Number(input.deaths) || 0;
  const teamDeaths = Number(input.teamDeaths) || 0;
  const deathShare = teamDeaths > 0 ? deaths / teamDeaths : 0;
  const assassinValue = assassinKillValue(input);

  if (assassinValue !== null) {
    adjustments.push({ key: 'kill', label: '击杀核心', value: assassinValue });
  } else if (rule.kill && kills >= rule.kill.minKills) {
    adjustments.push({ key: 'kill', label: '击杀核心', value: rule.kill.value });
  }
  if (rule.death && deathShare >= rule.death.minShare && deaths >= rule.death.minDeaths) {
    adjustments.push({ key: 'death', label: '死亡过多', value: rule.death.value });
  }
  const negative = negativeKdaValue(input);
  if (negative !== 0) {
    adjustments.push({
      key: 'negative',
      label: '战绩为负',
      value: negative,
      uncapped: true,
    });
  }
  return adjustments;
}

/** 五项百分位之外的加减分项：经济转化 + 按位置区分的人头/死亡 */
export function scoreAdjustments(input: MatchPercentileInput): ScoreAdjustment[] {
  const role = input.role ?? 'default';
  const adjustments: ScoreAdjustment[] = [];

  const goldShare = Number(input.goldShare) || 0;
  if ((role === 'carry' || role === 'fighter') && goldShare > 0) {
    const ratio = input.damageShare / goldShare;
    if (
      ratio >= ECONOMY_EFFICIENCY_HIGH_RATIO &&
      input.damageShare >= ECONOMY_EFFICIENCY_MIN_DAMAGE_SHARE
    ) {
      adjustments.push({
        key: 'economy',
        label: '经济转化',
        value: ECONOMY_EFFICIENCY_BONUS,
      });
    } else if (
      goldShare >= ECONOMY_EFFICIENCY_MIN_GOLD_SHARE &&
      ratio <= ECONOMY_EFFICIENCY_LOW_RATIO
    ) {
      // 只有经济拿得多的人才会因为“没打出伤害”被扣，低经济高输出只加分
      adjustments.push({
        key: 'economy',
        label: '资源黑洞',
        value: -ECONOMY_EFFICIENCY_DEDUCTION,
      });
    }
  }

  adjustments.push(...killDeathAdjustments(input));
  return adjustments;
}

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

/** 旧版单场评分：保留给 demo 和单元测试；业务评分改用 percentileScores */
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

export interface MatchPercentileInput {
  kda: number;
  killParticipation: number;
  damageShare: number;
  tankShare: number;
  healShare: number;
  /** 经济占比（本人经济 / 队伍总经济），用于经济转化加减分 */
  goldShare?: number;
  /** 本人击杀数，用于按位置区分的人头加分 */
  kills?: number;
  /** 本人助攻数，用于负战绩分档扣分 */
  assists?: number;
  /** 队伍总击杀 / 总死亡，用于计算击杀、死亡占比 */
  teamKills?: number;
  teamDeaths?: number;
  role?: ChampionRole;
  /** 副定位：按 30% 权重参与评分，短板规则仍看主定位 */
  secondaryRole?: ChampionRole;
  /** 官方原始分类：含 assassin 时击杀按刺客标准加分 */
  classes?: ChampionClass[];
  /** 本局死亡数，用于识别极端的“没输出又一直死”局 */
  deaths?: number;
}

interface RoleWeights {
  kda: number;
  kp: number;
  damage: number;
  taken: number;
  heal: number;
}

/**
 * 分英雄类型的权重：
 * - carry（法师/ADC/刺客）：输出权重最高
 * - support（软辅/治疗）：治疗和参团权重更高，输出权重降低
 * - tank（坦克/硬辅）：承伤和参团权重最高，输出权重最低
 * - fighter（战士）：输出和承伤均衡
 * 总权重都保持在约 16.7，避免不同定位之间整体分数漂移。
 * 英雄有官方副定位时，主定位占 70%、副定位占 30%。
 */
const ROLE_WEIGHTS: Record<ChampionRole, RoleWeights> = {
  carry: { kda: 5.4, kp: 1.2, damage: 7.8, taken: 2.3, heal: 0.01 },
  support: { kda: 5.0, kp: 3.5, damage: 3.0, taken: 3.5, heal: 1.7 },
  tank: { kda: 2.8, kp: 3.2, damage: 2.0, taken: 7.8, heal: 0.9 },
  fighter: { kda: 4.8, kp: 2.2, damage: 5.0, taken: 4.5, heal: 0.2 },
  default: { kda: 5.3987, kp: 1.2844, damage: 6.7913, taken: 3.2165, heal: 0.0214 },
};

/** 主定位在混合权重中的占比，剩下的 30% 给副定位 */
export const PRIMARY_ROLE_SHARE = 0.7;

/**
 * 输出位的承伤百分位下限。
 * 输出位打出伤害、少挨打通常是站位好，不能因为承伤全场最低就按“垫底”扣分；
 * 只有承伤明显高于中位才继续加分。坦克/战士不受此限制，承伤是他们的本职。
 */
export const CARRY_TANK_PERCENTILE_FLOOR = 0.5;

type CoreMetric = 'kda' | 'kp' | 'damage' | 'taken' | 'heal';

/** 各类型的核心指标：少于 2 项处于本局后 20% 才不扣短板分 */
const CORE_METRICS: Record<ChampionRole, CoreMetric[]> = {
  carry: ['kda', 'kp', 'damage'],
  support: ['kda', 'kp', 'heal'],
  tank: ['kda', 'kp', 'taken'],
  fighter: ['kda', 'damage', 'taken'],
  default: ['kda', 'kp', 'damage'],
};

/** 参团 + 另一项核心指标同时低于该阈值时，额外扣短板分 */
const LOW_PAIR: Record<
  ChampionRole,
  { metric: 'damageShare' | 'tankShare' | 'healShare'; threshold: number }
> = {
  carry: { metric: 'damageShare', threshold: 0.08 },
  support: { metric: 'healShare', threshold: 0.1 },
  tank: { metric: 'tankShare', threshold: 0.18 },
  fighter: { metric: 'damageShare', threshold: 0.08 },
  default: { metric: 'damageShare', threshold: 0.08 },
};

/** 评分权重（供 AI 提示词等地方复用，避免和评分模型脱节） */
export function roleScoreWeights(role: ChampionRole): RoleWeights {
  return ROLE_WEIGHTS[role];
}

/** 主 + 副定位的混合权重；没有副定位时直接返回主定位权重 */
export function roleProfileWeights(profile: ChampionRoleProfile): RoleWeights {
  const primary = ROLE_WEIGHTS[profile.primary];
  if (!profile.secondary || profile.secondary === profile.primary) return primary;
  const secondary = ROLE_WEIGHTS[profile.secondary];
  const secondaryShare = 1 - PRIMARY_ROLE_SHARE;
  return {
    kda: primary.kda * PRIMARY_ROLE_SHARE + secondary.kda * secondaryShare,
    kp: primary.kp * PRIMARY_ROLE_SHARE + secondary.kp * secondaryShare,
    damage: primary.damage * PRIMARY_ROLE_SHARE + secondary.damage * secondaryShare,
    taken: primary.taken * PRIMARY_ROLE_SHARE + secondary.taken * secondaryShare,
    heal: primary.heal * PRIMARY_ROLE_SHARE + secondary.heal * secondaryShare,
  };
}

/** 极端局判定：几乎没打出作用，评分直接封顶，不再套加减分 */
export function isCatastrophicLine(input: MatchPercentileInput): boolean {
  return (
    (input.damageShare < 0.06 &&
      input.killParticipation < 0.35 &&
      (input.deaths ?? 0) >= 10) ||
    // 低伤害、低承伤、低治疗、低参团、低死亡：典型长时间挂机/避战后偶尔收残局，
    // 即使 KDA 好看也不能算正常表现。
    (input.damageShare < 0.05 &&
      input.tankShare < 0.08 &&
      input.healShare < 0.1 &&
      input.killParticipation < 0.3 &&
      (input.deaths ?? 0) <= 5)
  );
}

/** 0–1 百分位；并列时取平均名次 */
function percentileRank(values: number[], value: number): number {
  if (!values.length) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length <= 1) return 0.5;
  const below = sorted.filter((item) => item < value).length;
  const equal = sorted.filter((item) => item === value).length;
  return (below + Math.max(0, equal - 1) / 2) / Math.max(1, sorted.length - 1);
}

/**
 * 单场评分：按本局 10 名玩家的 KDA / 参团 / 输出 / 承伤 / 治疗百分位加权。
 * 权重来自 40 个掌盟评分样本的拟合结果，直接得到绝对分（掌盟 0–20 × 5）；
 * 最后对“参团 + 另一项核心指标同时垫底”的局扣短板分。
 */
function scoreWithWeights(
  inputs: MatchPercentileInput[],
  weightsFor: (input: MatchPercentileInput) => RoleWeights,
  options: { deficitDeduction?: boolean; roleAdjustments?: boolean } = {},
): number[] {
  if (!inputs.length) return [];
  const applyDeficitDeduction = options.deficitDeduction ?? true;
  const applyRoleAdjustments = options.roleAdjustments ?? true;
  const rank = (
    key: 'kda' | 'killParticipation' | 'damageShare' | 'tankShare' | 'healShare',
  ): number[] => {
    const values = inputs.map((input) => input[key]);
    return inputs.map((input) => percentileRank(values, input[key]));
  };

  const kda = rank('kda');
  const kp = rank('killParticipation');
  const damage = rank('damageShare');
  // 输出位承伤低于中位时按中位算：少挨打是站位好，不该被当成最后一名扣分
  const taken = rank('tankShare').map((value, index) =>
    inputs[index]?.role === 'carry'
      ? Math.max(value, CARRY_TANK_PERCENTILE_FLOOR)
      : value,
  );
  const heal = rank('healShare');

  return inputs.map((input, index) => {
    const role = input.role ?? 'default';
    const weights = weightsFor(input);
    const score20 =
      0.9764 +
      weights.kda * (kda[index] ?? 0.5) +
      weights.kp * (kp[index] ?? 0.5) +
      weights.damage * (damage[index] ?? 0.5) +
      weights.taken * (taken[index] ?? 0.5) +
      weights.heal * (heal[index] ?? 0.5);
    const absolute = clamp(score20 * 5, 0, 100);
    // 伤害占比和参团都极低、死亡还多：属于整局几乎没打出作用的“巨坑”局，
    // 不再让辅助/坦克权重把分数托到正常范围。
    const catastrophic = isCatastrophicLine(input);

    let deduction = 0;
    if (applyDeficitDeduction && !catastrophic) {
      const percentiles: Record<CoreMetric, number> = {
        kda: kda[index] ?? 0.5,
        kp: kp[index] ?? 0.5,
        damage: damage[index] ?? 0.5,
        taken: taken[index] ?? 0.5,
        heal: heal[index] ?? 0.5,
      };
      const weakCount = CORE_METRICS[role].filter(
        (key) => percentiles[key] <= 0.2,
      ).length;
      const pair = LOW_PAIR[role];
      // 参团和另一项核心指标同时低到阈值以下：即便权重托了一下，也要扣分
      const pairLow =
        input.killParticipation < 0.35 && input[pair.metric] < pair.threshold;
      deduction = weakCount >= 3 ? 8 : pairLow ? 6 : weakCount >= 2 ? 4 : 0;
    }

    const adjustmentItems =
      applyRoleAdjustments && !catastrophic ? scoreAdjustments(input) : [];
    // 负战绩是独立扣分，不参与 ±MAX_SCORE_ADJUSTMENT 封顶；
    // 其它加减分仍然封顶，避免击杀 + 经济转化叠加把分数抬飞。
    const cappedAdjustment = Math.max(
      -MAX_SCORE_ADJUSTMENT,
      Math.min(
        MAX_SCORE_ADJUSTMENT,
        adjustmentItems
          .filter((item) => !item.uncapped)
          .reduce((sum, item) => sum + item.value, 0),
      ),
    );
    const uncappedAdjustment = adjustmentItems
      .filter((item) => item.uncapped)
      .reduce((sum, item) => sum + item.value, 0);
    const adjustment = cappedAdjustment + uncappedAdjustment;

    return round(
      clamp(
        catastrophic
          ? Math.min(absolute, CATASTROPHIC_SCORE_CAP)
          : Math.max(0, absolute + adjustment - deduction),
        0,
        100,
      ),
      1,
    );
  });
}

/** 按英雄主/副定位选择权重 */
export function percentileScores(inputs: MatchPercentileInput[]): number[] {
  return scoreWithWeights(inputs, (input) =>
    roleProfileWeights({
      primary: input.role ?? 'default',
      secondary: input.secondaryRole,
    }),
  );
}

/** 旧版全局权重：用于分阶段回滚/对比（不应用短板减分和加减分） */
export function legacyPercentileScores(inputs: MatchPercentileInput[]): number[] {
  return scoreWithWeights(inputs, () => ROLE_WEIGHTS.default, {
    deficitDeduction: false,
    roleAdjustments: false,
  });
}

/** 挂机/逃跑判定成立后把评分压到上限；原本更低的不抬分 */
export function capAfkScores(
  scores: Map<number, number>,
  afkIds: Set<number>,
): Map<number, number> {
  if (!afkIds.size) return scores;
  const capped = new Map(scores);
  for (const participantId of afkIds) {
    const score = capped.get(participantId);
    if (score !== undefined && score > AFK_SCORE_CAP) {
      capped.set(participantId, AFK_SCORE_CAP);
    }
  }
  return capped;
}

export function gradeOf(rating: number): Grade {
  if (rating >= 78) return 'S';
  if (rating >= 68) return 'A';
  if (rating >= 58) return 'B';
  if (rating >= 48) return 'C';
  return 'D';
}

/** 历史基线样本（来自长期存档） */
export interface BaselineSample {
  games: number;
  avgScore: number;
  stdDev: number;
}

/** 至少要有这么多场历史，个人基线才有参考价值 */
export const BASELINE_MIN_GAMES = 10;

/**
 * 用历史均分和标准差衡量近期状态。
 * 标准差下限按 6 分兜底：历史越稳定，同样的波动越值得提示，
 * 但不至于因为一两分就给出夸张的 σ。
 */
export function compareBaseline(
  recentAvgScore: number,
  sample: BaselineSample | undefined,
): PlayerBaseline | undefined {
  if (!sample || sample.games < BASELINE_MIN_GAMES) return undefined;
  if (!Number.isFinite(recentAvgScore) || !Number.isFinite(sample.avgScore)) return undefined;
  const stdDev = Math.max(6, sample.stdDev || 0);
  const delta = recentAvgScore - sample.avgScore;
  return {
    games: sample.games,
    avgScore: round(sample.avgScore, 1),
    stdDev: round(stdDev, 1),
    delta: round(delta, 1),
    z: round(delta / stdDev, 2),
  };
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
export interface AfkLikeStats {
  durationMin: number;
  gold: number;
  damage: number;
  cs: number;
  kills: number;
  deaths: number;
  assists: number;
  visionScore: number;
  position?: Lane;
  /** 连续没有经济/经验增长的最长分钟数（结算 timeline 提供时才有） */
  idleMinutes?: number;
}

export function isAfkLikeStats(input: AfkLikeStats): boolean {
  if (input.durationMin < 8) return false;
  // 有分段数据时优先看“中段是否长时间没有成长”：
  // 整局总数据可能被前 10 分钟掩盖，但连续 5 分钟无经济/经验通常就是挂机。
  if ((input.idleMinutes ?? 0) >= 5) return true;
  const minutes = Math.max(1, input.durationMin);
  const checks = [
    input.damage / minutes < 150,
    input.gold / minutes < 220,
    input.cs / minutes < 1.2,
    input.kills + input.assists <= 1,
  ];
  if (appliesVision(input.position ?? 'UNKNOWN')) {
    checks.push(input.visionScore / minutes < 0.35);
  }
  const hits = checks.filter(Boolean).length;
  return (
    hits >= checks.length ||
    (hits >= checks.length - 1 && input.kills + input.deaths + input.assists === 0)
  );
}

export function isAfkLike(game: AnalyzedGame): boolean {
  return isAfkLikeStats({
    durationMin: game.durationMin,
    gold: game.gold,
    damage: game.damage,
    cs: game.cs,
    kills: game.kills,
    deaths: game.deaths,
    assists: game.assists,
    visionScore: game.visionScore,
    position: game.position,
    idleMinutes: game.timeline?.idleMinutes,
  });
}

export interface AfkRelativeStats extends AfkLikeStats {
  /** 参团率 0-1，能拿到时优先使用 */
  killParticipation?: number;
  /** 承受伤害，用于判断是否真的参与过战斗 */
  damageTaken?: number;
  /** 治疗量，用于识别有治疗行为的辅助 */
  heal?: number;
  /** 时间线里连续没有补刀和战斗事件的最长秒数，来自 match_timelines */
  idleStreakSeconds?: number;
  /** 时间线里累计没有补刀和战斗事件的秒数，用来识别分段挂机 */
  idleAliveSeconds?: number;
  /** 时间线里连续原地不动、无补刀和战斗事件的最长秒数 */
  stationaryStreakSeconds?: number;
}

/** 时间线显示每隔这么久就有补刀或战斗参与，就不再判逃跑 */
export const AFK_IDLE_VETO_MINUTES = 5;
export const AFK_IDLE_VETO_SECONDS = AFK_IDLE_VETO_MINUTES * 60;
/** 存活期间连续原地不动超过这么久，直接判逃跑（典型基地挂机/掉线） */
export const AFK_STATIONARY_MINUTES = 3;
export const AFK_STATIONARY_SECONDS = AFK_STATIONARY_MINUTES * 60;
/** 单次空闲都没到 5 分钟时，累计空闲达到这个时长且占对局这个比例，仍判分段挂机 */
export const AFK_TOTAL_IDLE_SECONDS = 5 * 60;
export const AFK_TOTAL_IDLE_SHARE = 0.35;
/** 输出/承伤达到队友这个比例时，认为整局一直在参战，不再拿“没补刀”当挂机证据 */
export const AFK_COMBAT_DAMAGE_SHARE = 0.6;
export const AFK_COMBAT_TAKEN_SHARE = 0.8;

/**
 * “长时间挂机/逃跑”推断：
 * 绝对阈值只能抓到完全没数据的局；相对阈值必须同时排除“很坑但一直在打”的玩家。
 * 因此只要出现击杀/助攻、承伤或治疗等活跃信号，就不再判逃跑。
 */
export function isAfkLikeRelative(
  player: AfkRelativeStats,
  team: AfkRelativeStats[],
): boolean {
  const others = team.filter((item) => item !== player);
  const average = (pick: (item: AfkRelativeStats) => number): number =>
    others.length
      ? others.reduce((sum, item) => sum + pick(item), 0) / others.length
      : 0;
  const avgDamage = average((item) => item.damage);
  const avgTaken = average((item) => item.damageTaken ?? 0);
  // 没补刀不等于没参战：大乱斗里的坦克/辅助经常不吃线，
  // 只要输出或承伤接近队友水平，就说明一直在打架，不能按“没有补刀和战斗”判挂机。
  const inCombat =
    (avgDamage > 0 && player.damage >= avgDamage * AFK_COMBAT_DAMAGE_SHARE) ||
    (avgTaken > 0 &&
      (player.damageTaken ?? 0) >= avgTaken * AFK_COMBAT_TAKEN_SHARE);

  // 时间线显示连续原地不动超过 3 分钟：典型基地挂机或掉线，
  // 即使前期拿过击杀/助攻，也判逃跑。
  // 这是与时长无关的直接证据，7 分钟速推局里照样成立。
  if (
    player.stationaryStreakSeconds !== undefined &&
    player.stationaryStreakSeconds >= AFK_STATIONARY_SECONDS
  ) {
    return true;
  }
  // 分段挂机：单次空闲都没到 5 分钟，但累计有大块时间既没补刀也没参战。
  // 大乱斗里正常玩家几乎每分钟都有补刀或战斗，累计 5 分钟且占对局 35% 以上基本就是在挂机；
  // 但如果输出/承伤一直在线，说明只是在打团没补刀，不能算挂机。
  if (
    !inCombat &&
    player.idleAliveSeconds !== undefined &&
    player.idleAliveSeconds >= AFK_TOTAL_IDLE_SECONDS &&
    player.idleAliveSeconds >= player.durationMin * 60 * AFK_TOTAL_IDLE_SHARE
  ) {
    return true;
  }
  // 短局的伤害、经济、补刀天然偏低，不再按总量和队内相对值判断，
  // 避免把速推局里正常参战的玩家误标成逃跑。
  if (player.durationMin < 8) return false;
  // 时间线能证明每隔几分钟就有补刀或战斗参与时，说明玩家一直在打，
  // 即使整局数据被阵亡或位置拖累，也只判坑、不判逃跑。
  if (
    player.idleStreakSeconds !== undefined &&
    player.idleStreakSeconds < AFK_IDLE_VETO_SECONDS
  ) {
    return false;
  }
  if (isAfkLikeStats(player)) return true;
  if (!others.length) return false;

  const avgGold = average((item) => item.gold);
  const avgHeal = average((item) => item.heal ?? 0);
  const totalKills = team.reduce((sum, item) => sum + item.kills, 0);
  const participation =
    player.killParticipation ??
    (totalKills > 0 ? (player.kills + player.assists) / totalKills : 0);
  const actions = player.kills + player.assists;
  const damageTaken = player.damageTaken ?? 0;
  const heal = player.heal ?? 0;

  const lowDamage = avgDamage > 0 && player.damage < avgDamage * 0.35;
  const lowGold = avgGold > 0 && player.gold < avgGold * 0.55;
  const lowParticipation = participation < 0.3;
  const lowTaken = avgTaken > 0 && damageTaken < avgTaken * 0.35;

  // 低伤害 + 低承伤 + 低治疗 + 低参团 + 低死亡：
  // 即使有几个击杀/助攻，也说明大部分时间没有进入战斗（常见于长期挂机后出来收残局）。
  const offCombat =
    avgDamage > 0 &&
    player.damage < avgDamage * 0.2 &&
    avgTaken > 0 &&
    damageTaken < avgTaken * 0.2 &&
    (avgHeal <= 0 || heal < avgHeal * 0.5) &&
    participation < 0.3 &&
    player.deaths <= 5;
  if (offCombat) return true;

  // 只要有明确的参战/承伤/治疗痕迹，就说明不是逃跑，最多是坑
  const hasActivity =
    actions >= 4 ||
    (avgTaken > 0 && damageTaken >= avgTaken * 0.5) ||
    (avgHeal > 0 && heal >= avgHeal * 0.5 && heal >= 500);
  if (hasActivity) return false;

  return lowDamage && lowParticipation && (lowGold || lowTaken);
}

/** 平均排名至少需要这么多场同样人数、且有评分的对局，避免 1 场第 2 名被显示成“平均 #2” */
export const MIN_AVERAGE_RANK_GAMES = 3;

export interface RankedGameLike {
  rank?: number;
  rankTotal?: number;
  tags?: string[];
}

/**
 * 近期平均排名：只统计有排名的正常对局，并排除人数不一致的场次
 *（例如某些旧存档只有 7 人有评分，第 2/7 不能和第 2/10 放在一起平均）。
 * 有效样本不足时返回空对象，由调用方隐藏平均排名。
 */
export function averageGameRank(games: RankedGameLike[]): {
  avgRank?: number;
  avgRankGames?: number;
} {
  const played = games.filter((game) => !game.tags?.includes('重开'));
  const totals = played
    .map((game) => Number(game.rankTotal))
    .filter((total) => Number.isFinite(total) && total > 0);
  const expectedTotal = totals.length ? Math.max(...totals) : 0;
  const ranks = played
    .filter((game) => {
      const rank = Number(game.rank);
      if (!Number.isFinite(rank) || rank <= 0) return false;
      const total = Number(game.rankTotal);
      return !(
        expectedTotal > 0 &&
        Number.isFinite(total) &&
        total > 0 &&
        total !== expectedTotal
      );
    })
    .map((game) => Number(game.rank));
  if (ranks.length < MIN_AVERAGE_RANK_GAMES) return {};
  return {
    avgRank: round(ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length, 1),
    avgRankGames: ranks.length,
  };
}

export function summarize(games: AnalyzedGame[], signals: AccountSignals = {}): RecentSummary {
  // 重开不是一场正常对局：不计胜负/胜率，也不参与评分、英雄池等近期统计
  const played = games.filter((game) => !game.tags?.includes('重开'));
  const sorted = [...played].sort((a, b) => b.gameCreation - a.gameCreation);
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
  const { avgRank, avgRankGames } = averageGameRank(sorted);
  const uniqueChampions = new Set(sorted.map((game) => game.championId)).size;
  const topChampions = buildTopChampions(sorted);
  const winRate = sorted.length ? wins / sorted.length : 0;
  const afkGames = sorted.filter(isAfkLike).length;
  const afkRate = sorted.length ? afkGames / sorted.length : 0;
  // 坑场次按单场评分统一计算，包含小坑 / 很坑 / 巨坑
  const pitGames = sorted.filter((game) => Number(game.score) < MILD_BAD_GAME_SCORE).length;

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
    avgScore,
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
    pitGames,
    avgKda: round(avgKda, 2),
    avgScore: round(avgScore, 1),
    avgRank,
    avgRankGames,
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
    mainPosition,
    mainPositionShare: round(mainPositionShare, 2),
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
  avgScore: number;
  winRate: number;
  level?: number;
}

/** 单场“不达标”权重：>=2.0 算明显不达标，>=3.2 算严重不达标 */
function gameDeficit(game: AnalyzedGame): number {
  const profile = PROFILES[game.position] ?? PROFILES.UNKNOWN;
  const target = profile.target;
  let flags = 0;

  if (game.damagePerMin < target.damagePerMin * 0.42) flags += 1.8;
  else if (game.damagePerMin < target.damagePerMin * 0.65) flags += 1.0;

  if (game.position === 'TOP' || game.position === 'JUNGLE' || game.position === 'MID' || game.position === 'ADC') {
    if (game.csPerMin < target.csPerMin * 0.38) flags += 1.2;
    else if (game.csPerMin < target.csPerMin * 0.6) flags += 0.6;
  }

  if (game.deaths >= 9) flags += 1.0;
  else if (game.deaths >= 7) flags += 0.5;

  if (game.killParticipation < 0.33) flags += 1.0;
  else if (game.killParticipation < 0.45) flags += 0.5;

  if (appliesVision(game.position)) {
    if (game.visionPerMin < target.visionPerMin * 0.38) flags += 0.8;
    else if (game.visionPerMin < target.visionPerMin * 0.6) flags += 0.4;
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
    if (deficit >= 3.2) severeGames += 1;
    if (deficit >= 2.0) badGames += 1;
  }

  const badRatio = badGames / games.length;
  const severeRatio = severeGames / games.length;
  let score = 100 * (0.6 * badRatio + 0.4 * severeRatio);

  const latest = games[0] as AnalyzedGame;
  const reference = PROFILES[latest.position] ?? PROFILES.UNKNOWN;
  const weakDamage = reference.target.damagePerMin * 0.6;
  const weakCs = reference.target.csPerMin * 0.55;
  const weakVision = reference.target.visionPerMin * 0.55;

  if (averages.avgScore < 55) {
    score += Math.min(12, (55 - averages.avgScore) * 0.5);
  }
  if (averages.avgDeaths >= 7.5) score += 5;
  if (averages.winRate <= 0.35 && games.length >= 5) score += 4;
  if (averages.avgDamagePerMin < weakDamage) score += 4;
  if (averages.level !== undefined && averages.level < 40 && score >= 20) score += 8;

  // 样本太少时不要直接判死刑
  if (games.length < 3) score = Math.min(score, 45);
  score = Math.round(clamp(score, 0, 100));

  const level: RiskAssessment['level'] =
    score >= 60 ? 'severe' : score >= 40 ? 'high' : score >= 20 ? 'medium' : 'low';

  const reasons: string[] = [];
  const csApplies = latest.position !== 'SUPPORT' && latest.position !== 'ARAM' && latest.position !== 'ARENA';
  const visionApplies = appliesVision(latest.position);

  if (averages.avgScore < 50) {
    reasons.push(`近 ${games.length} 场场均评分 ${Math.round(averages.avgScore)}`);
  }
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
  if (averages.winRate <= 0.35 && games.length >= 5) {
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
  if (input.risk.level === 'severe') labels.push('很坑');
  else if (input.risk.level === 'high') labels.push('偏坑');
  else if (input.risk.level === 'medium') labels.push('有点坑');
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

  // MVP/SVP 由本局每队评分最高者决定，需要全队数据，不能只看单人评分
  if (game.win && game.score < 45) tags.push('躺赢');
  else if (!game.win && game.score >= 70) tags.push('尽力局');

  if ((game.largestKillingSpree ?? 0) >= 8) tags.push('超神');
  if (game.deaths === 0 && kills + assists >= 5) tags.push('零死');
  // 大乱斗/竞技场死亡次数天然偏高，不据此打“超鬼”标签
  if (deathTagsApply(game.position) && game.deaths >= 10) tags.push('超鬼');
  if (game.score < 30) tags.push('战犯');

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
