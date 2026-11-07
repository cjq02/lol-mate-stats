/** 英雄综合熟练度：场次经验 + 表现分 × 样本置信度，结果在 0-100 之间 */
export interface ChampionProficiencyInput {
  games: number;
  /** 0-1 */
  winRate: number;
  /** 0-100 */
  avgScore: number;
  /** 0-100 */
  bestScore: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * 场次经验最多 40 分，按 20 场为尺度逐渐饱和；
 * 表现分最多 60 分（胜率 20、均分 30、最高分 10），
 * 再乘以场次/(场次+5) 的置信度，避免 1-2 场高胜率直接把熟练度拉满。
 */
export function championProficiency(input: ChampionProficiencyInput): number {
  const games = Math.max(0, Number(input.games) || 0);
  if (!games) return 0;
  const winRate = clamp(Number(input.winRate) || 0, 0, 1);
  const avgScore = clamp(Number(input.avgScore) || 0, 0, 100);
  const bestScore = clamp(Number(input.bestScore) || 0, 0, 100);

  const experience = 40 * (1 - Math.exp(-games / 20));
  const performance = 20 * winRate + 30 * (avgScore / 100) + 10 * (bestScore / 100);
  const confidence = games / (games + 5);
  return Math.round(clamp(experience + performance * confidence, 0, 100) * 10) / 10;
}
