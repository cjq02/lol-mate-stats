/**
 * WeGame 大乱斗单局评分分析（只做拟合，不是官方公式）
 *
 * 数据来自两张战局详情截图：胜方 5 人、败方 5 人。
 * 运行：node scripts/analyze-wegame-score.mjs
 */

const MATCHES = [
  // 胜方（84 杀）
  { name: '吾乃青帝#46599', win: 1, k: 6, d: 11, a: 60, dmg: 0.05, taken: 0.24, heal: 0.76, teamKills: 84, score: 13.1 },
  { name: '邪之圣君#76461', win: 1, k: 35, d: 16, a: 25, dmg: 0.29, taken: 0.19, heal: 0.06, teamKills: 84, score: 14.5 },
  { name: '骑猪看妹子超神#20545', win: 1, k: 8, d: 14, a: 41, dmg: 0.14, taken: 0.19, heal: 0.01, teamKills: 84, score: 7.0 },
  { name: '舒芙蕾看着很好吃#44428', win: 1, k: 18, d: 13, a: 32, dmg: 0.25, taken: 0.22, heal: 0.16, teamKills: 84, score: 14.2 },
  { name: '左手往昔你用#50091', win: 1, k: 17, d: 10, a: 48, dmg: 0.27, taken: 0.16, heal: 0.01, teamKills: 84, score: 14.8 },
  // 败方（64 杀）
  { name: '情伤难自愈#31107', win: 0, k: 15, d: 22, a: 27, dmg: 0.29, taken: 0.23, heal: 0.04, teamKills: 64, score: 12.4 },
  { name: '黑夜之晁#45570', win: 0, k: 8, d: 19, a: 27, dmg: 0.12, taken: 0.17, heal: 0.28, teamKills: 64, score: 4.0 },
  { name: 'so龙yi#69709', win: 0, k: 8, d: 13, a: 18, dmg: 0.17, taken: 0.31, heal: 0.40, teamKills: 64, score: 8.6 },
  { name: 'RAJ、枷新#68121', win: 0, k: 20, d: 17, a: 16, dmg: 0.21, taken: 0.17, heal: 0.18, teamKills: 64, score: 7.4 },
  { name: '她和影流都是劫#54285', win: 0, k: 13, d: 13, a: 22, dmg: 0.21, taken: 0.12, heal: 0.10, teamKills: 64, score: 10.5 },
];

const rows = MATCHES.map((m) => ({
  ...m,
  kda: (m.k + m.a) / Math.max(1, m.d),
  kp: (m.k + m.a) / m.teamKills,
  deathsPer10: m.d / 10,
  kdaCap6: Math.min((m.k + m.a) / Math.max(1, m.d), 6),
}));

const labels = rows.map((r) => r.score);

/* ------------------------------ 数学工具 ------------------------------ */

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    if (Math.abs(div) < 1e-12) return null;
    for (let c = col; c <= n; c += 1) M[col][c] /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c += 1) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function fit(featureRows) {
  const n = featureRows[0].length;
  const A = Array.from({ length: n }, () => Array(n).fill(0));
  const b = Array(n).fill(0);
  for (let i = 0; i < featureRows.length; i += 1) {
    for (let j = 0; j < n; j += 1) {
      b[j] += featureRows[i][j] * labels[i];
      for (let k = 0; k < n; k += 1) A[j][k] += featureRows[i][j] * featureRows[i][k];
    }
  }
  return solve(A, b);
}

function metrics(preds) {
  const mae = preds.reduce((sum, p, i) => sum + Math.abs(p - labels[i]), 0) / preds.length;
  const rmse = Math.sqrt(
    preds.reduce((sum, p, i) => sum + (p - labels[i]) ** 2, 0) / preds.length,
  );
  const mean = labels.reduce((s, v) => s + v, 0) / labels.length;
  const ssTot = labels.reduce((s, v) => s + (v - mean) ** 2, 0);
  const ssRes = preds.reduce((s, p, i) => s + (p - labels[i]) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
  return { mae, rmse, r2 };
}

function evaluate(keys, data = rows) {
  const X = data.map((r) => [1, ...keys.map((key) => r[key])]);
  const coef = fit(X);
  if (!coef) return null;
  const preds = X.map((f) => f.reduce((sum, v, i) => sum + v * coef[i], 0));
  return { keys, coef, preds, ...metrics(preds) };
}

function printModel(model, title = '') {
  if (title) console.log(`\n${title}`);
  console.log(`  特征：${['截距', ...model.keys].join(' + ')}`);
  console.log(`  系数：${model.coef.map((v) => Number(v.toFixed(4))).join(', ')}`);
  console.log(
    `  MAE ${model.mae.toFixed(3)} / RMSE ${model.rmse.toFixed(3)} / R² ${model.r2.toFixed(3)}`,
  );
  console.log(
    `  预测：${model.preds.map((v) => v.toFixed(2)).join(' / ')}`,
  );
  console.log(`  实际：${labels.join(' / ')}`);
}

/* ------------------------------ 基础统计 ------------------------------ */

const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
const scoreMean = mean(labels);
const scoreStd = Math.sqrt(mean(labels.map((v) => (v - scoreMean) ** 2)));

function correlation(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

console.log('='.repeat(88));
console.log('WeGame 大乱斗单局评分：10 人样本分析');
console.log('='.repeat(88));
console.log(`评分均值 ${scoreMean.toFixed(2)}，标准差 ${scoreStd.toFixed(2)}，范围 ${Math.min(...labels)}–${Math.max(...labels)}`);
console.log(`胜方均值 ${mean(rows.slice(0, 5).map((r) => r.score)).toFixed(2)}，败方均值 ${mean(rows.slice(5).map((r) => r.score)).toFixed(2)}`);

console.log('\n特征表：');
console.log('玩家'.padEnd(22), 'KDA'.padStart(5), '参团'.padStart(6), '输出'.padStart(6), '承伤'.padStart(6), '治疗'.padStart(6), '评分'.padStart(6));
for (const r of rows) {
  console.log(
    r.name.padEnd(22),
    r.kda.toFixed(2).padStart(5),
    `${(r.kp * 100).toFixed(1)}%`.padStart(6),
    `${(r.dmg * 100).toFixed(0)}%`.padStart(6),
    `${(r.taken * 100).toFixed(0)}%`.padStart(6),
    `${(r.heal * 100).toFixed(0)}%`.padStart(6),
    r.score.toFixed(1).padStart(6),
  );
}

console.log('\n与评分的相关系数：');
for (const key of ['kda', 'kp', 'dmg', 'taken', 'heal', 'k', 'd', 'a', 'win']) {
  console.log(`  ${key.padEnd(8)} ${correlation(rows.map((r) => r[key]), labels).toFixed(3)}`);
}

/* ------------------------------ 候选模型 ------------------------------ */

console.log('\n' + '='.repeat(88));
console.log('固定候选模型');
console.log('='.repeat(88));

const candidates = [
  ['kda'],
  ['kda', 'kp'],
  ['kda', 'dmg'],
  ['kda', 'dmg', 'heal'],
  ['kda', 'kp', 'dmg', 'heal'],
  ['kda', 'kp', 'dmg', 'heal', 'win'],
  ['kdaCap6', 'kp', 'dmg', 'heal', 'win'],
  ['kda', 'kp', 'dmg', 'heal', 'deathsPer10', 'win'],
  ['k', 'd', 'a', 'dmg', 'heal', 'win'],
];
for (const keys of candidates) {
  const model = evaluate(keys);
  if (model) printModel(model, `模型：${keys.join(' + ')}`);
}

/* ------------------------------ 自动搜索 ------------------------------ */

console.log('\n' + '='.repeat(88));
console.log('自动搜索：从候选特征中选 1–4 个（仅按 MAE 排序，样本少，容易过拟合）');
console.log('='.repeat(88));

const pool = ['kda', 'kp', 'dmg', 'taken', 'heal', 'k', 'd', 'a', 'deathsPer10', 'kdaCap6', 'win'];
const results = [];
function combine(start, keys) {
  if (keys.length) {
    const model = evaluate(keys);
    if (model) results.push(model);
  }
  if (keys.length >= 4) return;
  for (let i = start; i < pool.length; i += 1) {
    combine(i + 1, [...keys, pool[i]]);
  }
}
combine(0, []);
results.sort((a, b) => a.mae - b.mae);
for (const model of results.slice(0, 8)) {
  printModel(model);
}

/* ------------------------------ 百分位模型 ------------------------------ */

console.log('\n' + '='.repeat(88));
console.log('局内百分位模型：把每项换成“本局 10 人中的排名”后再拟合');
console.log('='.repeat(88));

function percentile(values, value) {
  const sorted = [...values].sort((a, b) => a - b);
  const below = sorted.filter((v) => v < value).length;
  const equal = sorted.filter((v) => v === value).length;
  return (below + (equal - 1) / 2) / Math.max(1, sorted.length - 1);
}

const percentileKeys = ['kda', 'kp', 'dmg', 'taken', 'heal'];
const percentileRows = rows.map((r) => ({
  ...r,
  ...Object.fromEntries(
    percentileKeys.map((key) => [key, percentile(rows.map((item) => item[key]), r[key])]),
  ),
}));
const percentileModel = evaluate(percentileKeys, percentileRows);
if (percentileModel) printModel(percentileModel, '模型：KDA / 参团 / 输出 / 承伤 / 治疗 的局内百分位');

/* ------------------------------ 残差 ------------------------------ */

console.log('\n' + '='.repeat(88));
console.log('推荐近似模型的逐人残差');
console.log('='.repeat(88));
const recommended = evaluate(['kda', 'kp', 'dmg', 'heal', 'win']);
if (recommended) {
  console.log('玩家'.padEnd(22), '实际'.padStart(6), '预测'.padStart(6), '误差'.padStart(7));
  rows.forEach((r, i) => {
    const pred = recommended.preds[i];
    console.log(
      r.name.padEnd(22),
      r.score.toFixed(1).padStart(6),
      pred.toFixed(2).padStart(6),
      (pred - r.score).toFixed(2).padStart(7),
    );
  });
  const terms = recommended.coef.map((value, index) => {
    if (index === 0) return value.toFixed(4);
    const sign = value >= 0 ? ' + ' : ' - ';
    return `${sign}${Math.abs(value).toFixed(4)}×${recommended.keys[index - 1]}`;
  });
  console.log(`\n近似式：score = ${terms.join('')}`);
}

console.log('\n注意：这是拟合，不是 WeGame 官方公式；10 个样本不足以唯一确定权重，更没有金币、推塔、控制时长和英雄基准系数。');
