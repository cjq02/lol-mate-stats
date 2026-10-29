import assert from 'node:assert/strict';
import type { AnalyzedGame, Lane, RawGame } from '../types.js';
import { analyzeGame, detectLane } from './analyze.js';
import { PROFILES, gameTags, isAfkLike, performanceScore, summarize } from './rating.js';
import { currentQueueGroup, gameQueueGroup, modeFromQueue } from './constants.js';

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
  tankShare?: number;
  killParticipation?: number;
  csPerMin?: number;
  visionPerMin?: number;
  durationMin?: number;
  position?: Lane;
  queueId?: number;
  championId?: number;
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
  const tankShare = overrides.tankShare ?? 0.16;
  const kda = (kills + assists) / Math.max(1, deaths);
  const queueId = overrides.queueId ?? 420;

  return {
    gameId: 1000 + index,
    queueId,
    queueName: queueId === 450 ? '极地大乱斗' : '单双排',
    gameCreation: overrides.gameCreation ?? Date.now() - index * 3_600_000,
    durationMin,
    championId: overrides.championId ?? 103,
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
    tankShare,
    killParticipation,
    visionScore: Math.round(visionPerMin * durationMin),
    visionPerMin,
    position: overrides.position ?? lane,
    score: performanceScore(
      {
        kda,
        damageShare,
        damagePerMin,
        tankShare,
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

test('大乱斗不参考视野', () => {
  const noVision = makeGame(0, 'ARAM', { position: 'ARAM', visionPerMin: 0 });
  const highVision = makeGame(1, 'ARAM', { position: 'ARAM', visionPerMin: 2 });
  assert.equal(noVision.score, highVision.score);

  const games = Array.from({ length: 10 }, (_, index) =>
    makeGame(index, 'ARAM', { position: 'ARAM', visionPerMin: 0, win: index < 6 }),
  );
  const summary = summarize(games);
  assert.ok(!summary.labels.includes('视野偏弱'), summary.labels.join(','));
  assert.ok(!summary.labels.includes('视野大师'), summary.labels.join(','));
  assert.equal(isAfkLike(games[0]!), false);
});

test('大乱斗不因死亡多打超鬼/容易暴毙标签', () => {
  const aramTags = gameTags({
    win: false,
    score: 40,
    deaths: 12,
    kda: 1,
    damageShare: 0.2,
    position: 'ARAM',
  });
  assert.ok(!aramTags.includes('超鬼'), aramTags.join(','));

  const srTags = gameTags({
    win: false,
    score: 40,
    deaths: 12,
    kda: 1,
    damageShare: 0.2,
    position: 'MID',
  });
  assert.ok(srTags.includes('超鬼'), srTags.join(','));

  const games = Array.from({ length: 10 }, (_, index) =>
    makeGame(index, 'ARAM', { position: 'ARAM', deaths: 10, win: index < 5 }),
  );
  const summary = summarize(games);
  assert.ok(!summary.labels.includes('容易暴毙'), summary.labels.join(','));
});

test('单场标签：超神/零死/助攻/伤害/肉盾', () => {
  const base = {
    win: false,
    score: 50,
    kills: 3,
    deaths: 3,
    assists: 5,
    kda: 2,
    damageShare: 0.2,
    position: 'MID' as Lane,
  };
  assert.ok(gameTags({ ...base, largestKillingSpree: 8 }).includes('超神'));
  assert.ok(gameTags({ ...base, deaths: 0, kills: 8, assists: 2 }).includes('零死'));
  assert.ok(gameTags({ ...base, assists: 20 }).includes('助攻机器'));
  assert.ok(gameTags({ ...base, damageShare: 0.36 }).includes('伤害爆炸'));
  assert.ok(gameTags({ ...base, tankShare: 0.36 }).includes('肉盾'));
});

test('单场标签：多杀/一血/补刀/拆塔/时长', () => {
  const base = {
    win: false,
    score: 50,
    kills: 3,
    deaths: 3,
    assists: 5,
    kda: 2,
    damageShare: 0.2,
    position: 'MID' as Lane,
  };
  assert.ok(gameTags({ ...base, pentaKills: 1 }).includes('五杀'));
  assert.ok(gameTags({ ...base, quadraKills: 1 }).includes('四杀'));
  assert.ok(gameTags({ ...base, firstBloodKill: true }).includes('一血'));
  assert.ok(gameTags({ ...base, csPerMin: 9.2 }).includes('补刀怪'));
  assert.ok(gameTags({ ...base, turretKills: 5 }).includes('拆塔工'));
  assert.ok(gameTags({ ...base, win: true, score: 60, durationMin: 18 }).includes('速推局'));
  assert.ok(gameTags({ ...base, durationMin: 42 }).includes('膀胱局'));
});

test('大乱斗单场标签', () => {
  const base = {
    win: false,
    score: 50,
    kills: 10,
    deaths: 12,
    assists: 12,
    kda: 2,
    damageShare: 0.25,
    position: 'ARAM' as Lane,
  };
  assert.ok(
    gameTags({ ...base, damageShare: 0.35, damagePerMin: 1200 }).includes('乱斗炮台'),
  );
  assert.ok(gameTags({ ...base, killParticipation: 0.6 }).includes('乱斗敢死队'));
  assert.ok(gameTags({ ...base, totalHeal: 8000 }).includes('乱斗奶妈'));
});

test('大乱斗不判断英雄池', () => {
  const games = Array.from({ length: 10 }, (_, index) =>
    makeGame(index, 'MID', { championId: 100 + index }),
  );
  const summary = summarize(games);
  assert.ok(summary.labels.includes('英雄海'), summary.labels.join(','));

  const aramGames = games.map((_, index) =>
    makeGame(index, 'ARAM', { position: 'ARAM', queueId: 450, championId: 100 + index }),
  );
  const aramSummary = summarize(aramGames);
  assert.ok(!aramSummary.labels.includes('英雄海'), aramSummary.labels.join(','));
  assert.ok(!aramSummary.labels.includes('英雄勺'), aramSummary.labels.join(','));
});

test('近期标签：绝活哥与空砍群主', () => {
  const oneTrick = Array.from({ length: 10 }, (_, index) =>
    makeGame(index, 'MID', { win: index < 8 }),
  );
  assert.ok(summarize(oneTrick).labels.includes('绝活哥'));

  const emptyStats = Array.from({ length: 10 }, (_, index) =>
    makeGame(index, 'MID', {
      win: index < 4,
      damage: 42_000,
      damageShare: 0.38,
      killParticipation: 0.55,
    }),
  );
  assert.ok(summarize(emptyStats).labels.includes('空砍群主'));
});

test('近期标签：状态回升/稳健/专精', () => {
  const comeback = [
    ...Array.from({ length: 5 }, (_, index) =>
      makeGame(index, 'MID', {
        win: true,
        damage: 40_000,
        damageShare: 0.4,
        killParticipation: 0.7,
        csPerMin: 8,
      }),
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      makeGame(index + 5, 'MID', {
        win: false,
        kills: 1,
        deaths: 8,
        assists: 2,
        damage: 6_000,
        damageShare: 0.08,
        killParticipation: 0.3,
        csPerMin: 3,
        visionPerMin: 0.3,
      }),
    ),
  ];
  assert.ok(summarize(comeback).labels.includes('状态回升'));

  const steady = Array.from({ length: 10 }, (_, index) =>
    makeGame(index, 'MID', { deaths: 2 }),
  );
  const steadyLabels = summarize(steady).labels;
  assert.ok(steadyLabels.includes('稳健'), steadyLabels.join(','));
  assert.ok(steadyLabels.includes('专精中单'), steadyLabels.join(','));
});

test('识别疑似挂机对局并打标签', () => {
  const afk = Array.from({ length: 3 }, (_, index) =>
    makeGame(index, 'MID', {
      kills: 0,
      deaths: 0,
      assists: 0,
      damage: 0,
      damageShare: 0,
      killParticipation: 0,
      csPerMin: 0.2,
      visionPerMin: 0,
      durationMin: 20,
    }),
  );
  const normal = Array.from({ length: 7 }, (_, index) => makeGame(index + 3, 'MID', {}));
  const summary = summarize([...afk, ...normal]);
  assert.equal(isAfkLike(afk[0]!), true);
  assert.equal(isAfkLike(normal[0]!), false);
  assert.equal(summary.afkGames, 3);
  assert.ok(summary.labels.includes('常挂机'), summary.labels.join(','));
});

test('队列/模式分组', () => {
  assert.equal(modeFromQueue(450, 'ARAM'), 'ARAM');
  assert.equal(modeFromQueue(1700, 'CHERRY'), 'ARENA');
  assert.equal(modeFromQueue(420, 'CLASSIC'), 'SR');
  assert.equal(currentQueueGroup(420, 'SR'), 'solo');
  assert.equal(currentQueueGroup(440, 'SR'), 'flex');
  assert.equal(currentQueueGroup(450, 'ARAM'), 'aram');
  assert.equal(gameQueueGroup(450, 'ARAM'), 'aram');
  assert.equal(gameQueueGroup(420, 'MID'), 'solo');
});

console.log(`\n${passed} 项测试全部通过`);
