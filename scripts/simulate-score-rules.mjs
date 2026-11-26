/**
 * 离线评估评分规则改动，不改数据库。
 *
 * 对比：
 *   old = 当前口径（五项百分位 + 短板扣分，没有经济转化、没有挂机封顶）
 *   new = 加经济转化 ±分，并用同一套规则做挂机/逃跑封顶
 *
 * 运行：npm run build && node scripts/simulate-score-rules.mjs --limit 3000
 */

import '../dist/env.js';
import { getDb } from '../dist/stats/store.js';
import { championRoleProfile } from '../dist/stats/champion-roles.js';
import {
  capAfkScores,
  isAfkLikeRelative,
  percentileScores,
  scoreAdjustments,
} from '../dist/stats/rating.js';

const limitArg = process.argv.indexOf('--limit');
const limit =
  limitArg >= 0 && Number(process.argv[limitArg + 1]) > 0
    ? Math.trunc(Number(process.argv[limitArg + 1]))
    : 3000;

const BANDS = [
  { label: '75+', min: 75 },
  { label: '65–74', min: 65 },
  { label: '55–64', min: 55 },
  { label: '45–54', min: 45 },
  { label: '35–44', min: 35 },
  { label: '< 35', min: -Infinity },
];

function bandOf(score) {
  return BANDS.find((band) => score >= band.min).label;
}

function summarize(scores) {
  const bands = new Map(BANDS.map((band) => [band.label, 0]));
  let sum = 0;
  for (const score of scores) {
    sum += score;
    bands.set(bandOf(score), bands.get(bandOf(score)) + 1);
  }
  return {
    avg: scores.length ? sum / scores.length : 0,
    bands: Object.fromEntries(
      [...bands.entries()].map(([label, count]) => [
        label,
        `${count} (${Math.round((count / Math.max(1, scores.length)) * 100)}%)`,
      ]),
    ),
  };
}

const db = await getDb();
const [gameRows] = await db.query(
  `SELECT m.game_id, m.duration_seconds
   FROM matches m
   JOIN match_participants p ON p.game_id = m.game_id
   GROUP BY m.game_id, m.duration_seconds
   ORDER BY m.game_creation DESC
   LIMIT ?`,
  [limit],
);
const gameIds = gameRows.map((row) => Number(row.game_id));
const durationById = new Map(
  gameRows.map((row) => [Number(row.game_id), Number(row.duration_seconds)]),
);
if (!gameIds.length) {
  console.log('没有可模拟的对局');
  await db.end();
  process.exit(0);
}

const placeholders = gameIds.map(() => '?').join(',');
const [rows] = await db.query(
  `SELECT p.game_id, p.participant_id, p.team_id, p.champion_id, p.kills, p.deaths,
          p.assists, p.cs, p.gold, p.damage, p.damage_taken, p.heal, p.vision, p.position,
          p.idle_streak_seconds, p.stationary_streak_seconds
   FROM match_participants p
   WHERE p.game_id IN (${placeholders})
   ORDER BY p.game_id, p.participant_id`,
  gameIds,
);

const byGame = new Map();
for (const row of rows) {
  const gameId = Number(row.game_id);
  const list = byGame.get(gameId) ?? [];
  list.push(row);
  byGame.set(gameId, list);
}

let participants = 0;
let changed = 0;
let deltaSum = 0;
let changedDeltaSum = 0;
let economyBonus = 0;
let economyDeduction = 0;
let killBonus = 0;
let deathDeduction = 0;
let afkCapped = 0;
const oldScores = [];
const newScores = [];
const movers = [];

for (const [gameId, list] of byGame) {
  const durationMin = Math.max(1, (durationById.get(gameId) ?? 0) / 60);
  const teams = new Map();
  for (const row of list) {
    const teamId = Number(row.team_id);
    const total = teams.get(teamId) ?? {
      kills: 0,
      deaths: 0,
      gold: 0,
      damage: 0,
      taken: 0,
      heal: 0,
    };
    total.kills += Number(row.kills);
    total.deaths += Number(row.deaths);
    total.gold += Number(row.gold);
    total.damage += Number(row.damage);
    total.taken += Number(row.damage_taken);
    total.heal += Number(row.heal);
    teams.set(teamId, total);
  }

  const buildInputs = (withGoldShare) =>
    list.map((row) => {
      const total = teams.get(Number(row.team_id));
      const kills = Number(row.kills);
      const deaths = Number(row.deaths);
      const assists = Number(row.assists);
      const profile = championRoleProfile(Number(row.champion_id));
      return {
        kda: (kills + assists) / Math.max(1, deaths),
        killParticipation: total.kills > 0 ? (kills + assists) / total.kills : 0,
        damageShare: total.damage > 0 ? Number(row.damage) / total.damage : 0,
        tankShare: total.taken > 0 ? Number(row.damage_taken) / total.taken : 0,
        healShare: total.heal > 0 ? Number(row.heal) / total.heal : 0,
        ...(withGoldShare
          ? {
              goldShare:
                total.gold > 0 ? Number(row.gold) / total.gold : 0,
              kills,
              teamKills: total.kills,
              teamDeaths: total.deaths,
              assists,
            }
          : {}),
        role: profile.primary,
        secondaryRole: profile.secondary,
        classes: profile.classes,
        deaths,
      };
    });

  const oldRaw = percentileScores(buildInputs(false));
  const newInputs = buildInputs(true);
  const newRaw = percentileScores(newInputs);

  const afkByTeam = new Map();
  const statsById = new Map();
  for (const row of list) {
    const total = teams.get(Number(row.team_id));
    const kills = Number(row.kills);
    const assists = Number(row.assists);
    const stats = {
      durationMin,
      gold: Number(row.gold),
      damage: Number(row.damage),
      cs: Number(row.cs),
      kills,
      deaths: Number(row.deaths),
      assists,
      visionScore: Number(row.vision),
      position: row.position ?? undefined,
      killParticipation: total.kills > 0 ? (kills + assists) / total.kills : 0,
      damageTaken: Number(row.damage_taken),
      heal: Number(row.heal),
      idleStreakSeconds:
        row.idle_streak_seconds === null ? undefined : Number(row.idle_streak_seconds),
      stationaryStreakSeconds:
        row.stationary_streak_seconds === null
          ? undefined
          : Number(row.stationary_streak_seconds),
    };
    statsById.set(Number(row.participant_id), stats);
    const teamStats = afkByTeam.get(Number(row.team_id)) ?? [];
    teamStats.push(stats);
    afkByTeam.set(Number(row.team_id), teamStats);
  }
  const afkIds = new Set();
  for (const [teamId, teamStats] of afkByTeam) {
    const members = list.filter((row) => Number(row.team_id) === teamId);
    members.forEach((row, index) => {
      if (isAfkLikeRelative(teamStats[index], teamStats)) {
        afkIds.add(Number(row.participant_id));
      }
    });
  }
  const newFinal = capAfkScores(
    new Map(list.map((row, index) => [Number(row.participant_id), newRaw[index]])),
    afkIds,
  );

  list.forEach((row, index) => {
    const participantId = Number(row.participant_id);
    const before = oldRaw[index];
    const after = newFinal.get(participantId);
    participants += 1;
    oldScores.push(before);
    newScores.push(after);
    deltaSum += after - before;
    if (Math.abs(after - before) > 0.05) {
      changed += 1;
      changedDeltaSum += after - before;
    }
    const adjustmentValue = scoreAdjustments(newInputs[index]);
    for (const item of adjustmentValue) {
      if (item.key === 'economy') {
        if (item.value > 0) economyBonus += 1;
        else economyDeduction += 1;
      } else if (item.key === 'kill') {
        killBonus += 1;
      } else if (item.key === 'death') {
        deathDeduction += 1;
      }
    }
    if (afkIds.has(participantId) && newRaw[index] > after + 0.05) afkCapped += 1;
    movers.push({
      gameId,
      name: participantId,
      championId: Number(row.champion_id),
      role: championRoleProfile(Number(row.champion_id)).primary,
      before,
      after,
      delta: Math.round((after - before) * 10) / 10,
    });
  });
}

console.log(`样本：${byGame.size} 场 / ${participants} 名参与者（最近 ${limit} 场）`);
console.log('旧口径', summarize(oldScores));
console.log('新口径', summarize(newScores));
console.log(
  `变化：${changed} 人（${((changed / participants) * 100).toFixed(1)}%），平均 ${
    deltaSum / participants >= 0 ? '+' : ''
  }${(deltaSum / participants).toFixed(2)} 分，变化人群平均 ${
    changedDeltaSum / Math.max(1, changed) >= 0 ? '+' : ''
  }${(changedDeltaSum / Math.max(1, changed)).toFixed(2)} 分`,
);
console.log(
  `经济转化：加分 ${economyBonus} 人，扣分 ${economyDeduction} 人；` +
    `击杀核心 ${killBonus} 人，死亡过多 ${deathDeduction} 人；挂机封顶 ${afkCapped} 人`,
);
console.log(
  '变动最大的 8 人',
  movers
    .filter((row) => Math.abs(row.delta) >= 0.5)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 8),
);

await db.end();
