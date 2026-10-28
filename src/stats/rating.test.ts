import assert from 'node:assert/strict';
import type { AnalyzedGame, Lane, RawGame } from '../types.js';
import { analyzeGame, detectLane } from './analyze.js';
import { PROFILES, performanceScore, summarize } from './rating.js';

let passed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    console.error(`  ✘ ${name}`);
    throw error;
  }
}

interface GameOverrides {
  win?: boolean;
  kills?: number;
  deaths?: number;
  assists?: number;
  damage?: number;
  damageShare?: number;
  killParticipation?: number;
  csPerMin?: number;
  visionPerMin?: number;
  durationMin?: number;
  position?: Lane;
  gameCreation?: number;
}

function makeGame(index: number, lane: Lane, overrides: GameOverrides = {}): AnalyzedGame {
  const durationMin = overrides.durationMin ?? 30;
  const kills = overrides.kills ?? 6;
  const deaths = overrides.deaths ?? 3;
  const assists = overrides.assists ?? 8;
  const win = overrides.win ?? true;
  const damage = overrides.damage ?? 27_000;
  const damageShare = overrides.damageShare ?? 0.3;
  const damagePerMin = damage / durationMin;
  const killParticipation = overrides.killParticipation ?? 0.65;
  const csPerMin = overrides.csPerMin ?? 7;
  const visionPerMin = overrides.visionPerMin ?? 1;
  const kda = (kills + assists) / Math.max(1, deaths);

  return {
    gameId: 1000 + index,
    queueId: 420,
    queueName: '单双排',
    gameCreation: overrides.gameCreation ?? Date.now() - index * 3_600_000,
    durationMin,
    championId: 103,
    championName: '九尾妖狐',
    win,
    kills,
    deaths,
    assists,
    kda: Math.round(kda * 100) / 100,
    cs: Math.round(csPerMin * durationMin),
    csPerMin,
    gold: 12_000,
    damage,
    damageShare,
    damagePerMin: Math.round(damagePerMin),
    tankShare: 0.16,
    killParticipation,
    visionScore: Math.round(visionPerMin * durationMin),
    visionPerMin,
    position: overrides.position ?? lane,
    score: performanceScore(
      {
        kda,
        damageShare,
        damagePerMin,
        tankShare: 0.16,
        killParticipation,
        csPerMin,
        visionPerMin,
        win,
      },
      overrides.position ?? lane,
    ),
    tags: [],
  };
}

console.log('rating');
test('各位置权重之和为 1', () => {
  for (const [lane, profile] of Object.entries(PROFILES)) {
    const sum = Object.values(profile.weight).reduce((total, value) => total + value, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${lane} 权重之和为 ${sum}`);
  }
});

test('正常中单玩家：评分正常、坑指数低', () => {
  const games = Array.from({ length: 10 }, (_, index) =>
    makeGame(index, 'MID', { win: index < 7 }),
  );
  const summary = summarize(games, { level: 300 });
  assert.ok(summary.rating >= 60, `rating=${summary.rating}`);
  assert.ok(summary.risk.score <= 25, `risk=${summary.risk.score}`);
  assert.ok(!summary.labels.includes('坑'));
});

test('新手菜鸟：伤害只有几 K、补刀低、死亡多 → 判为坑', () => {
  const games = Array.from({ length: 10 }, (_, index) =>
    makeGame(index, 'MID', {
      win: index === 0,
      kills: 2,
      deaths: 9,
      assists: 3,
      damage: 4_000,
      damageShare: 0.08,
      killParticipation: 0.35,
      csPerMin: 2,
      visionPerMin: 0.25,
    }),
  );
  const summary = summarize(games, { level: 22 });
  assert.equal(summary.risk.level, 'severe', `risk=${summary.risk.score}`);
  assert.ok(summary.risk.score >= 65, `risk=${summary.risk.score}`);
  assert.ok(summary.labels.includes('坑'), summary.labels.join(','));
  assert.ok(summary.labels.includes('疑似新手'), summary.labels.join(','));
  assert.equal(summary.risk.newbie, true);
  assert.ok(summary.avgDamagePerMin < 200);
  assert.ok(summary.rating < 50, `rating=${summary.rating}`);
});

test('样本不足时坑指数会被限制', () => {
  const games = Array.from({ length: 2 }, (_, index) =>
    makeGame(index, 'MID', {
      kills: 1,
      deaths: 10,
      assists: 1,
      damage: 3_000,
      damageShare: 0.06,
      killParticipation: 0.2,
      csPerMin: 1.5,
      visionPerMin: 0.1,
    }),
  );
  const summary = summarize(games, { level: 18 });
  assert.ok(summary.risk.score <= 45, `risk=${summary.risk.score}`);
  assert.ok(summary.labels.includes('样本较少'));
});

test('近期对局权重更高', () => {
  const recentGood = Array.from({ length: 5 }, (_, index) =>
    makeGame(index, 'MID', { win: true }),
  );
  const olderBad = Array.from({ length: 5 }, (_, index) =>
    makeGame(index + 5, 'MID', {
      win: false,
      kills: 2,
      deaths: 8,
      assists: 2,
      damage: 8_000,
      damageShare: 0.12,
      killParticipation: 0.3,
      csPerMin: 3,
      visionPerMin: 0.3,
    }),
  );
  const summary = summarize([...recentGood, ...olderBad]);
  const plainAverage =
    [...recentGood, ...olderBad].reduce((sum, game) => sum + game.score, 0) / 10;
  assert.ok(summary.rating > plainAverage, `${summary.rating} <= ${plainAverage}`);
});

test('辅助不按补刀判断坑', () => {
  const games = Array.from({ length: 10 }, (_, index) =>
    makeGame(index, 'SUPPORT', {
      kills: 1,
      deaths: 5,
      assists: 18,
      win: index < 6,
      damage: 9_000,
      damageShare: 0.1,
      killParticipation: 0.65,
      csPerMin: 1.2,
      visionPerMin: 1.8,
      position: 'SUPPORT',
    }),
  );
  const summary = summarize(games, { level: 200 });
  assert.ok(summary.risk.reasons.every((reason) => !reason.startsWith('分均补刀')));
  assert.ok(summary.risk.score < 45, `risk=${summary.risk.score}`);
});

console.log('analyze');
test('解析 LCU 对局：位置、分均伤害、参团、伤害占比', () => {
  const game: RawGame = {
    gameId: 42,
    gameCreation: 1_700_000_000_000,
    gameDuration: 1_800,
    queueId: 420,
    participants: [
      {
        participantId: 1,
        teamId: 100,
        championId: 103,
        timeline: { lane: 'MIDDLE', role: 'SOLO' },
        stats: {
          kills: 5,
          deaths: 2,
          assists: 7,
          win: true,
          totalDamageDealtToChampions: 20_000,
          totalDamageTaken: 15_000,
          visionScore: 25,
          totalMinionsKilled: 180,
          neutralMinionsKilled: 10,
          goldEarned: 12_000,
        },
      },
      {
        participantId: 2,
        teamId: 100,
        championId: 64,
        timeline: { lane: 'JUNGLE', role: 'NONE' },
        stats: {
          kills: 8,
          deaths: 3,
          assists: 5,
          win: true,
          totalDamageDealtToChampions: 10_000,
          totalDamageTaken: 20_000,
          visionScore: 30,
          totalMinionsKilled: 90,
          neutralMinionsKilled: 40,
          goldEarned: 11_000,
        },
      },
    ],
    participantIdentities: [
      { participantId: 1, player: { puuid: 'p1', summonerId: 1 } },
      { participantId: 2, player: { puuid: 'p2', summonerId: 2 } },
    ],
  };

  const championMap = new Map([[103, { id: 103, name: '九尾妖狐', alias: 'Ahri' }]]);
  const analyzed = analyzeGame(game, { puuid: 'p1', summonerId: 1 }, championMap);
  assert.ok(analyzed);
  assert.equal(analyzed.position, 'MID');
  assert.equal(analyzed.championName, '九尾妖狐');
  assert.equal(analyzed.win, true);
  assert.equal(analyzed.damagePerMin, Math.round(20_000 / 30));
  assert.ok(Math.abs(analyzed.killParticipation - 12 / 13) < 0.01);
  assert.ok(Math.abs(analyzed.damageShare - 2 / 3) < 0.01);
});

test('识别大乱斗与竞技场', () => {
  const participant = { teamId: 100, timeline: { lane: 'BOTTOM', role: 'SOLO' } };
  assert.equal(detectLane({ queueId: 450, gameMode: 'ARAM' }, participant), 'ARAM');
  assert.equal(detectLane({ queueId: 1700, gameMode: 'CHERRY' }, participant), 'ARENA');
});

console.log(`\n${passed} 项测试全部通过`);
