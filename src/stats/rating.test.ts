import assert from 'node:assert/strict';
import type { AnalyzedGame, GameTimeline, Lane, RawGame, Snapshot } from '../types.js';
import { analyzeGame, detectLane, matchBestTags, parseGameTimeline } from './analyze.js';
import { liveItemIds } from '../lcu/live.js';
import { buildLiveAnalysisMessages } from '../ai.js';
import { badLevelLabel, badLevelOfScore, gameFlagTags, worseBadLevel } from './flags.js';
import { PROFILES, compareBaseline, gameTags, isAfkLike, isAfkLikeRelative, percentileScores, performanceScore, summarize } from './rating.js';
import { currentQueueGroup, gameQueueGroup, modeFromQueue } from './constants.js';
import { matchesGameContext, mergeIncrementalGames } from './collector.js';
import { summarizeTimeStats } from './time-stats.js';

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
  heal?: number;
  timeline?: GameTimeline;
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
    heal: overrides.heal ?? 4_000,
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
    timeline: overrides.timeline,
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

test('重开不计入胜率和场次', () => {
  const games = Array.from({ length: 4 }, (_, index) =>
    makeGame(index, 'MID', { win: index !== 0 && index !== 3 }),
  );
  games[0]!.tags = ['重开'];
  const summary = summarize(games);
  assert.equal(summary.games, 3);
  assert.equal(summary.wins, 2);
  assert.equal(summary.losses, 1);
  assert.ok(Math.abs(summary.winRate - 2 / 3) < 1e-9, `winRate=${summary.winRate}`);
  assert.equal(summary.streak?.type, 'win');
  assert.equal(summary.streak?.count, 2);
  assert.equal(summary.topChampions[0]?.games, 3);
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

test('单场坑的程度分档', () => {
  assert.equal(badLevelOfScore(40), undefined);
  assert.equal(badLevelOfScore(32), undefined);
  assert.equal(badLevelOfScore(31), 'mild');
  assert.equal(badLevelOfScore(25), 'mild');
  assert.equal(badLevelOfScore(24), 'bad');
  assert.equal(badLevelOfScore(18), 'bad');
  assert.equal(badLevelOfScore(17), 'severe');
  assert.equal(badLevelLabel('mild'), '小坑');
  assert.equal(badLevelLabel('bad'), '坑');
  assert.equal(badLevelLabel('severe'), '巨坑');
  assert.equal(worseBadLevel('mild', 'severe'), 'severe');
  assert.equal(worseBadLevel(undefined, 'bad'), 'bad');
  assert.equal(worseBadLevel('bad', 'mild'), 'bad');
});

test('自己坑/逃跑也会打标签', () => {
  assert.deepEqual(
    gameFlagTags({
      remake: false,
      teammateAfk: false,
      opponentAfk: false,
      selfBad: 'severe',
    }),
    ['自己巨坑'],
  );
  assert.deepEqual(
    gameFlagTags({
      remake: false,
      teammateAfk: false,
      opponentAfk: false,
      selfAfk: true,
      selfBad: 'severe',
    }),
    ['自己逃跑'],
  );
});

test('局内百分位评分：强于队友的玩家分更高', () => {
  const inputs = Array.from({ length: 10 }, (_, index) => ({
    kda: 1 + index * 0.5,
    killParticipation: 0.4 + index * 0.04,
    damageShare: 0.12 + index * 0.015,
    tankShare: 0.1 + index * 0.01,
    healShare: 0.02 + index * 0.01,
  }));
  const scores = percentileScores(inputs);
  assert.equal(scores.length, 10);
  assert.ok(scores.every((score) => score >= 0 && score <= 100));
  assert.ok(scores[9]! > scores[0]!, `scores=${scores.join(',')}`);
  const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  assert.ok(avg > 54 && avg < 63, `avg=${avg}`);
  assert.ok(scores[9]! > 85, `top=${scores[9]}`);
  assert.ok(scores[0]! < 15, `bottom=${scores[0]}`);
});

test('分英雄类型权重：软辅高治疗吃香，法师高输出吃香', () => {
  const base = Array.from({ length: 10 }, (_, index) => ({
    kda: 2 + index * 0.4,
    killParticipation: 0.5 + index * 0.03,
    damageShare: 0.1 + index * 0.02,
    tankShare: 0.1 + index * 0.01,
    healShare: index === 0 ? 0.6 : 0.05,
    role: index === 0 ? ('support' as const) : ('carry' as const),
  }));
  const supportScores = percentileScores(base);
  const carryScores = percentileScores(
    base.map((input, index) =>
      index === 0 ? { ...input, role: 'carry' as const } : input,
    ),
  );
  assert.ok(
    supportScores[0]! > carryScores[0]!,
    `support=${supportScores[0]} carry=${carryScores[0]}`,
  );
});

test('解析 Live Client Data 的装备对象', () => {
  assert.deepEqual(liveItemIds([{ itemID: 6655 }, { itemID: 3020 }]), [6655, 3020]);
  assert.deepEqual(liveItemIds([6655, 3020]), [6655, 3020]);
  assert.deepEqual(liveItemIds([{ itemId: 3157 }, { itemID: 0 }]), [3157]);
  assert.deepEqual(liveItemIds(undefined), []);
});

test('实时 AI 提示词包含装备、召唤师技能、符文、血量和事件', () => {
  const snapshot = {
    mode: 'live',
    phase: 'InProgress',
    inChampSelect: false,
    inGame: true,
    collecting: false,
    updatedAt: '',
    queueId: 450,
    gameMode: 'ARAM',
    gameTime: 300,
    liveSessionId: 'session',
    liveEvents: [
      { EventName: 'ChampionKill', EventTime: 100, KillerName: '我', VictimName: '敌人' },
    ],
    localPlayer: {
      summonerId: 1,
      displayName: '我',
      cellId: 0,
      championId: 1,
      championName: '格温',
    },
    players: [
      {
        summonerId: 1,
        displayName: '我',
        championName: '格温',
        position: 'ARAM',
        isEnemy: false,
        labels: [],
        live: {
          kills: 0,
          deaths: 3,
          assists: 7,
          cs: 0,
          championLevel: 5,
          items: [6655],
          summonerSpells: ['闪现', '点燃'],
          runes: '电刑 / 主宰',
          respawnTimer: 12,
          currentGold: 1500,
          health: 1200,
          maxHealth: 1800,
          resourceValue: 300,
          resourceMax: 500,
          resourceType: 'MANA',
          attackDamage: 80,
          abilityPower: 120,
          armor: 50,
          magicResist: 40,
          abilityHaste: 20,
          abilities: [
            { key: 'Q', level: 4 },
            { key: 'W', level: 2 },
          ],
        },
      },
    ],
  } as unknown as Snapshot;
  const text = buildLiveAnalysisMessages(snapshot, (id) =>
    id === 6655 ? '峡谷制造者' : '',
  )
    .map((message) => message.content)
    .join('\n');
  assert.ok(text.includes('召唤师技能 闪现/点燃'), text);
  assert.ok(text.includes('符文 电刑 / 主宰'), text);
  assert.ok(text.includes('血量 1200/1800'), text);
  assert.ok(text.includes('技能 Q4 W2'), text);
  assert.ok(text.includes('峡谷制造者'), text);
  assert.ok(text.includes('本局事件'), text);
  assert.ok(text.includes('我 击杀 敌人'), text);
  assert.ok(text.includes('【评分目标】'), text);
  assert.ok(text.includes('权重（局内百分位）'), text);
  assert.ok(text.includes('输出占比权重最高'), text);
  assert.ok(text.includes('2. 我的评分提升重点'), text);
});

test('每队最佳：胜方 MVP、负方 SVP', () => {
  const game = {
    participants: [
      { participantId: 1, teamId: 100, stats: { win: true } },
      { participantId: 2, teamId: 100, stats: { win: true } },
      { participantId: 3, teamId: 200, stats: { win: false } },
      { participantId: 4, teamId: 200, stats: { win: false } },
    ],
  } as RawGame;
  const tags = matchBestTags(
    game,
    new Map([
      [1, 60],
      [2, 80],
      [3, 90],
      [4, 70],
    ]),
  );
  assert.equal(tags.size, 2);
  assert.equal(tags.get(2), 'MVP');
  assert.equal(tags.get(3), 'SVP');
});

test('有参团和承伤的“坑”玩家不判逃跑', () => {
  const player = {
    durationMin: 20,
    gold: 9790,
    damage: 5997,
    cs: 2,
    kills: 1,
    deaths: 18,
    assists: 13,
    visionScore: 0,
    position: 'ARAM' as Lane,
    killParticipation: 0.28,
    damageTaken: 31287,
    heal: 2638,
  };
  const team = [
    player,
    {
      durationMin: 20,
      gold: 15515,
      damage: 49799,
      cs: 43,
      kills: 18,
      deaths: 11,
      assists: 13,
      visionScore: 0,
      position: 'ARAM' as Lane,
      killParticipation: 0.62,
      damageTaken: 28486,
      heal: 6014,
    },
  ];
  assert.equal(isAfkLikeRelative(player, team), false);
});

test('真正没有参与对局的玩家仍判逃跑', () => {
  const afk = {
    durationMin: 20,
    gold: 3000,
    damage: 500,
    cs: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    visionScore: 0,
    position: 'MID' as Lane,
    killParticipation: 0,
    damageTaken: 1600,
    heal: 0,
  };
  const normal = {
    durationMin: 20,
    gold: 12000,
    damage: 25000,
    cs: 150,
    kills: 8,
    deaths: 4,
    assists: 6,
    visionScore: 30,
    position: 'MID' as Lane,
    killParticipation: 0.5,
    damageTaken: 20000,
    heal: 1000,
  };
  assert.equal(isAfkLikeRelative(afk, [afk, normal]), true);
});

test('极端低输出且高死亡的对局按巨坑封顶', () => {
  const scores = percentileScores([
    {
      kda: 0.78,
      killParticipation: 0.28,
      damageShare: 0.032,
      tankShare: 0.208,
      healShare: 0.146,
      role: 'support' as const,
      deaths: 18,
    },
    {
      kda: 3.2,
      killParticipation: 0.65,
      damageShare: 0.26,
      tankShare: 0.2,
      healShare: 0.1,
      role: 'carry' as const,
      deaths: 8,
    },
  ]);
  assert.ok(scores[0]! < 18, `score=${scores[0]}`);
  assert.equal(badLevelOfScore(scores[0]), 'severe');
});

test('时段统计按本地两小时分组并统计坑率', () => {
  const at = (hour: number, minute = 0) => new Date(2026, 0, 5, hour, minute).getTime();
  const summary = summarizeTimeStats([
    { gameCreation: at(0, 30), win: true, tags: [] },
    { gameCreation: at(1, 59), win: false, tags: ['队友坑'] },
    { gameCreation: at(2, 10), win: true, tags: ['队友巨坑', '自己小坑'] },
    { gameCreation: at(23, 10), win: false, tags: ['队友逃跑'] },
    { gameCreation: at(23, 50), win: true, tags: ['重开'] },
  ]);
  assert.equal(summary.totalGames, 4);
  assert.equal(summary.wins, 2);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.periods.length, 12);

  const early = summary.periods[0];
  assert.ok(early);
  assert.equal(early.games, 2);
  assert.equal(early.wins, 1);
  assert.equal(early.losses, 1);
  assert.equal(early.teammateBadGames, 1);
  assert.equal(early.selfBadGames, 0);

  const morning = summary.periods[1];
  assert.ok(morning);
  assert.equal(morning.games, 1);
  assert.equal(morning.wins, 1);
  assert.equal(morning.teammateBadGames, 1);
  assert.equal(morning.selfBadGames, 1);

  const late = summary.periods[11];
  assert.ok(late);
  assert.equal(late.games, 1);
  assert.equal(late.wins, 0);
  assert.equal(late.teammateBadGames, 1);
  assert.equal(late.teammateBadRate, 1);
});

test('低伤害低承伤但 KDA 好看的局判为挂机', () => {
  const player = {
    durationMin: 21,
    gold: 11802,
    damage: 5817,
    cs: 17,
    kills: 5,
    deaths: 2,
    assists: 9,
    visionScore: 0,
    position: 'ARAM' as Lane,
    killParticipation: 0.25,
    damageTaken: 6971,
    heal: 1737,
  };
  const team = [
    player,
    {
      durationMin: 21,
      gold: 15954,
      damage: 48563,
      cs: 49,
      kills: 17,
      deaths: 12,
      assists: 28,
      visionScore: 0,
      position: 'ARAM' as Lane,
      killParticipation: 0.804,
      damageTaken: 46899,
      heal: 8889,
    },
    {
      durationMin: 21,
      gold: 13018,
      damage: 58206,
      cs: 68,
      kills: 3,
      deaths: 20,
      assists: 28,
      visionScore: 0,
      position: 'ARAM' as Lane,
      killParticipation: 0.554,
      damageTaken: 39588,
      heal: 3589,
    },
    {
      durationMin: 21,
      gold: 13301,
      damage: 29094,
      cs: 34,
      kills: 6,
      deaths: 15,
      assists: 24,
      visionScore: 0,
      position: 'ARAM' as Lane,
      killParticipation: 0.536,
      damageTaken: 51620,
      heal: 3521,
    },
    {
      durationMin: 21,
      gold: 17596,
      damage: 92438,
      cs: 35,
      kills: 25,
      deaths: 13,
      assists: 20,
      visionScore: 0,
      position: 'ARAM' as Lane,
      killParticipation: 0.804,
      damageTaken: 74100,
      heal: 32456,
    },
  ];
  assert.equal(isAfkLikeRelative(player, team), true);
});

test('低伤害低承伤低死亡的保 KDA 局评分也封顶', () => {
  const scores = percentileScores([
    {
      kda: 7,
      killParticipation: 0.25,
      damageShare: 0.025,
      tankShare: 0.032,
      healShare: 0.035,
      role: 'carry' as const,
      deaths: 2,
    },
    {
      kda: 3.5,
      killParticipation: 0.8,
      damageShare: 0.4,
      tankShare: 0.34,
      healShare: 0.65,
      role: 'fighter' as const,
      deaths: 13,
    },
  ]);
  assert.ok(scores[0]! < 18, `score=${scores[0]}`);
  assert.equal(badLevelOfScore(scores[0]), 'severe');
});

console.log('incremental');
test('增量更新只接收当前模式的新对局', () => {
  assert.equal(matchesGameContext({ queueId: 450 }, { queueId: 420, mode: 'SR' }), false);
  assert.equal(matchesGameContext({ queueId: 420 }, { queueId: 420, mode: 'SR' }), true);
  assert.equal(matchesGameContext({ queueId: 440 }, { queueId: 420, mode: 'SR' }), false);
  assert.equal(matchesGameContext({ queueId: 1700 }, { queueId: 450, mode: 'ARAM' }), false);
  assert.equal(matchesGameContext({ queueId: 450 }, undefined), true);
});

test('增量更新只补新对局并保持最近 N 场', () => {
  const previous = [
    makeGame(1, 'MID', { gameCreation: 2_000 }),
    makeGame(2, 'MID', { gameCreation: 1_000 }),
  ];
  const added = [makeGame(3, 'MID', { gameCreation: 3_000 })];
  const merged = mergeIncrementalGames(added, previous, 2);
  assert.deepEqual(
    merged.map((game) => game.gameId),
    [1003, 1001],
  );
  assert.equal(merged.length, 2);
});

test('增量更新会对重复对局去重', () => {
  const game = makeGame(1, 'MID');
  const merged = mergeIncrementalGames([game], [game], 10);
  assert.equal(merged.length, 1);
});

console.log('baseline');
test('个人基线需要至少 10 场历史', () => {
  assert.equal(compareBaseline(70, { games: 9, avgScore: 60, stdDev: 8 }), undefined);
  const baseline = compareBaseline(70, { games: 30, avgScore: 60, stdDev: 8 });
  assert.equal(baseline?.games, 30);
  assert.equal(baseline?.delta, 10);
  assert.equal(baseline?.z, 1.25);
});

test('个人基线标准差过小时按 6 分兜底', () => {
  const baseline = compareBaseline(70, { games: 20, avgScore: 60, stdDev: 1 });
  assert.equal(baseline?.stdDev, 6);
  assert.equal(baseline?.z, 1.67);
});

test('近期摘要给出主玩位置与占比', () => {
  const games = [
    makeGame(1, 'MID'),
    makeGame(2, 'MID'),
    makeGame(3, 'MID'),
    makeGame(4, 'MID'),
    makeGame(5, 'TOP'),
  ];
  const summary = summarize(games);
  assert.equal(summary.mainPosition, 'MID');
  assert.equal(summary.mainPositionShare, 0.8);
});

console.log('timeline');
test('解析结算时间线：分均经济、对位补刀差与掉线段', () => {
  const timeline = parseGameTimeline(
    {
      goldPerMinDeltas: { '0-10': 320, '10-20': 40, '20-30': 500 },
      xpPerMinDeltas: { '0-10': 500, '10-20': 50, '20-30': 600 },
      csDiffPerMinDeltas: { '0-10': -4, '10-20': 1, '20-30': 3 },
    },
    30,
  );
  assert.equal(timeline?.segments.length, 3);
  assert.equal(timeline?.idleMinutes, 10);
  assert.equal(timeline?.csDiffEarly, -4);
  assert.equal(timeline?.csDiffLate, 3);
});

test('时间线字段缺失时不影响对局解析', () => {
  assert.equal(parseGameTimeline(undefined, 30), undefined);
  assert.equal(parseGameTimeline({ lane: 'MID' }, 30), undefined);
});

test('中段长时间没有成长会判为疑似挂机', () => {
  const game = makeGame(1, 'MID', {
    timeline: {
      segments: [],
      idleMinutes: 6,
    },
  });
  assert.equal(isAfkLike(game), true);
});

console.log(`\n${passed} 项测试全部通过`);
