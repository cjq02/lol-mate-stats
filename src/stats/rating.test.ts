import assert from 'node:assert/strict';
import type {
  AnalyzedGame,
  GameTimeline,
  Lane,
  MatchDetail,
  MatchTimeline,
  RawGame,
  Snapshot,
} from '../types.js';
import { analyzeGame, detectLane, matchBestTags, parseGameTimeline } from './analyze.js';
import { liveItemIds } from '../lcu/live.js';
import { buildAnalysisMessages, buildChampSelectAnalysisMessages, buildLiveAnalysisMessages, buildLiveFollowUpMessages } from '../ai.js';
import { afkParticipantIds, badLevelLabel, badLevelOfScore, gameFlagTags, isRemakeGame, worseBadLevel } from './flags.js';
import { AFK_IDLE_VETO_SECONDS, AFK_STATIONARY_SECONDS, AFK_SCORE_CAP, PROFILES, capAfkScores, compareBaseline, gameTags, isAfkLike, isAfkLikeRelative, killDeathAdjustments, percentileScores, performanceScore, roleProfileWeights, roleScoreWeights, scoreAdjustments, summarize } from './rating.js';
import { currentQueueGroup, gameQueueGroup, modeFromQueue, queueGroupName, queueName } from './constants.js';
import { endOfGameToRawGame } from './eog.js';
import { matchesGameContext, mergeIncrementalGames } from './collector.js';
import { summarizeTimeStats } from './time-stats.js';
import { championProficiency } from './proficiency.js';
import { championRole, championRoleProfile } from './champion-roles.js';
import { premadeSizesByPuuid, premadeSizesFromGames } from './premade.js';
import { buildLiveTimeline } from './live-timeline.js';
import { estimateRespawnMs, parseMatchTimeline } from './timeline.js';
import { isNewFinishedGame } from '../watcher.js';

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
  score?: number;
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
    score:
      overrides.score ??
      performanceScore(
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
  assert.ok(!summary.labels.includes('很坑'));
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
  assert.ok(summary.labels.includes('很坑'), summary.labels.join(','));
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
  assert.equal(queueName(890), '人机（中等）');
  assert.equal(queueName(480), '快速模式');
  assert.equal(queueName(3140), '训练模式');
  assert.equal(queueGroupName('ranked'), '排位');
  assert.equal(queueGroupName('bot'), '人机');
  assert.equal(queueGroupName('swift'), '快速模式');
  assert.equal(queueGroupName('practice'), '训练模式');
});

test('单场坑的程度分档', () => {
  assert.equal(badLevelOfScore(35), undefined);
  assert.equal(badLevelOfScore(30), undefined);
  assert.equal(badLevelOfScore(29.9), 'mild');
  assert.equal(badLevelOfScore(25), 'mild');
  assert.equal(badLevelOfScore(24.9), 'bad');
  assert.equal(badLevelOfScore(20), 'bad');
  assert.equal(badLevelOfScore(19.9), 'severe');
  assert.equal(badLevelOfScore(15), 'severe');
  assert.equal(badLevelOfScore(10), 'severe');
  assert.equal(badLevelLabel('mild'), '小坑');
  assert.equal(badLevelLabel('bad'), '很坑');
  assert.equal(badLevelLabel('severe'), '巨坑');
  assert.equal(worseBadLevel('mild', 'severe'), 'severe');
  assert.equal(worseBadLevel(undefined, 'bad'), 'bad');
  assert.equal(worseBadLevel('bad', 'mild'), 'bad');
});

test('自己很坑/逃跑也会打标签', () => {
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
      selfBad: 'bad',
      teammateBad: 'bad',
    }),
    ['自己很坑', '队友很坑'],
  );
  assert.deepEqual(
    gameFlagTags({
      remake: false,
      teammateAfk: false,
      opponentAfk: false,
      selfAfk: true,
      selfBad: 'severe',
    }),
    ['自己逃跑', '自己巨坑'],
  );
  assert.deepEqual(
    gameFlagTags({
      remake: false,
      teammateAfk: true,
      opponentAfk: true,
      teammateBad: 'severe',
      opponentBad: 'mild',
    }),
    ['队友逃跑', '对手逃跑', '队友巨坑', '敌方小坑'],
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
  assert.ok(avg > 42 && avg < 50, `avg=${avg}`);
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

test('各英雄类型评分权重总和保持一致', () => {
  for (const role of ['carry', 'support', 'tank', 'fighter', 'default'] as const) {
    const weights = roleScoreWeights(role);
    const sum = Object.values(weights).reduce((total, value) => total + value, 0);
    assert.ok(Math.abs(sum - 16.7) < 0.02, `${role} 权重之和为 ${sum}`);
  }
  const carry = roleScoreWeights('carry');
  assert.ok(
    carry.kda > carry.taken && carry.damage > carry.taken,
    `输出位 KDA=${carry.kda}、输出=${carry.damage} 都应高于承伤=${carry.taken}`,
  );
});

test('英雄定位改为主 + 副：刀妹战士主刺客副、猴子战士主坦克副', () => {
  assert.deepEqual(
    championRoleProfile(39),
    { primary: 'fighter', secondary: 'carry', classes: ['fighter', 'assassin'] },
    '刀妹官方定位是 fighter + assassin，刺客归入 carry 副定位',
  );
  assert.deepEqual(
    championRoleProfile(62),
    { primary: 'fighter', secondary: 'tank', classes: ['fighter', 'tank'] },
    '猴子官方定位是 fighter + tank，坦克应作为副定位参与评分',
  );
  assert.deepEqual(
    championRoleProfile(67),
    { primary: 'carry', classes: ['marksman', 'assassin'] },
    'VN 的射手和刺客都映射到 carry，不需要副定位',
  );
  assert.equal(championRole(39), 'fighter', '只取主定位的调用方仍返回战士');
  assert.deepEqual(
    championRoleProfile(60062),
    { primary: 'fighter', secondary: 'tank', classes: ['fighter', 'tank'] },
    'Jade 猴子要和基础英雄保持一致',
  );
});

test('主副定位按 7:3 混合评分权重', () => {
  const fighter = roleScoreWeights('fighter');
  const tank = roleScoreWeights('tank');
  const mixed = roleProfileWeights({ primary: 'fighter', secondary: 'tank' });
  assert.ok(
    Math.abs(mixed.taken - (fighter.taken * 0.7 + tank.taken * 0.3)) < 1e-9,
    `混合承伤权重=${mixed.taken}`,
  );
  assert.ok(
    Math.abs(mixed.kda - (fighter.kda * 0.7 + tank.kda * 0.3)) < 1e-9,
    `混合 KDA 权重=${mixed.kda}`,
  );
  const sum = Object.values(mixed).reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - 16.7) < 0.02, `混合权重之和为 ${sum}`);
  assert.deepEqual(
    roleProfileWeights({ primary: 'carry' }),
    roleScoreWeights('carry'),
    '没有副定位时不应改变权重',
  );
});

test('副定位让承伤型战士的评分更高', () => {
  // 猴子：承伤第一、输出垫底。混入 30% 坦克权重后，承伤应该更值钱。
  const base = [
    {
      kda: 2,
      killParticipation: 0.6,
      damageShare: 0.12,
      tankShare: 0.35,
      healShare: 0.1,
      deaths: 6,
    },
    {
      kda: 4,
      killParticipation: 0.7,
      damageShare: 0.3,
      tankShare: 0.1,
      healShare: 0.1,
      deaths: 4,
    },
  ];
  const fighterOnly = percentileScores(
    base.map((input) => ({ ...input, role: 'fighter' as const })),
  );
  const withTankSecondary = percentileScores(
    base.map((input, index) =>
      index === 0
        ? { ...input, role: 'fighter' as const, secondaryRole: 'tank' as const }
        : { ...input, role: 'fighter' as const },
    ),
  );
  assert.ok(
    withTankSecondary[0]! > fighterOnly[0]!,
    `纯战士=${fighterOnly[0]}，战士+坦克副定位=${withTankSecondary[0]}`,
  );
});

test('经济转化：低经济高输出加分，吃资源不输出扣分', () => {
  const base = {
    kda: 3,
    killParticipation: 0.6,
    tankShare: 0.2,
    healShare: 0.1,
    role: 'carry' as const,
  };
  const bonus = scoreAdjustments({
    ...base,
    damageShare: 0.3,
    goldShare: 0.2,
  });
  assert.equal(bonus[0]?.value, 1.5, '伤害占比 30% / 经济占比 20% 应加 1.5 分');
  const deduction = scoreAdjustments({
    ...base,
    damageShare: 0.2,
    goldShare: 0.3,
  });
  assert.equal(deduction[0]?.value, -2, '经济占比 30% 只打出 20% 伤害应扣 2 分');
  assert.equal(
    scoreAdjustments({ ...base, role: 'support', damageShare: 0.3, goldShare: 0.2 }).length,
    0,
    '软辅不吃经济转化',
  );
  assert.equal(
    scoreAdjustments({ ...base, role: 'tank', damageShare: 0.2, goldShare: 0.3 }).length,
    0,
    '坦克不吃资源黑洞扣分',
  );
});

test('人头/死亡加减分按位置区分', () => {
  const base = {
    kda: 3,
    killParticipation: 0.6,
    damageShare: 0.22,
    tankShare: 0.2,
    healShare: 0.1,
    goldShare: 0.22,
  };
  const carryKills = killDeathAdjustments({
    ...base,
    role: 'carry',
    kills: 21,
    teamKills: 63,
    deaths: 5,
    teamDeaths: 43,
  });
  assert.equal(carryKills[0]?.key, 'kill', '输出位 21 杀应该加分');
  assert.equal(carryKills[0]?.value, 1.5);
  assert.ok(!carryKills.some((item) => item.key === 'death'), '5 死不触发死亡扣分');
  assert.equal(
    killDeathAdjustments({
      ...base,
      role: 'carry',
      kills: 17,
      teamKills: 63,
      deaths: 5,
      teamDeaths: 43,
    }).length,
    0,
    '17 杀还没到输出位加分门槛',
  );

  const fighterNormal = killDeathAdjustments({
    ...base,
    role: 'fighter',
    kills: 13,
    teamKills: 63,
    deaths: 11,
    teamDeaths: 43,
  });
  assert.equal(fighterNormal.length, 0, '战士 21% 击杀、25.6% 死亡属于正常范围，不调整');

  const fighterExtreme = killDeathAdjustments({
    ...base,
    role: 'fighter',
    kills: 18,
    teamKills: 60,
    deaths: 14,
    teamDeaths: 40,
  });
  assert.deepEqual(
    fighterExtreme.map((item) => [item.key, item.value]),
    [
      ['kill', 1],
      ['death', -1],
    ],
    '战士 30% 击杀 + 35% 死亡才触发',
  );

  const tank = killDeathAdjustments({
    ...base,
    role: 'tank',
    kills: 20,
    teamKills: 50,
    deaths: 14,
    teamDeaths: 40,
  });
  assert.deepEqual(
    tank.map((item) => item.key),
    ['death'],
    '坦克不靠人头加分，死亡只有非常极端才扣',
  );

  const support = killDeathAdjustments({
    ...base,
    role: 'support',
    kills: 15,
    teamKills: 50,
    deaths: 8,
    teamDeaths: 30,
  });
  assert.deepEqual(
    support.map((item) => item.key),
    ['death'],
    '辅助同样不拿人头分，死亡门槛比坦克低',
  );

  const assassinCarry = killDeathAdjustments({
    ...base,
    role: 'carry',
    kills: 15,
    teamKills: 63,
    deaths: 6,
    teamDeaths: 43,
    classes: ['assassin'],
  });
  assert.deepEqual(
    assassinCarry.map((item) => [item.key, item.value]),
    [['kill', 1.5]],
    '含刺客标签的输出位 15 杀就按刺客标准加分',
  );

  const assassin20 = killDeathAdjustments({
    ...base,
    role: 'carry',
    kills: 20,
    teamKills: 63,
    deaths: 8,
    teamDeaths: 43,
    classes: ['assassin'],
  });
  assert.deepEqual(
    assassin20.map((item) => [item.key, item.value]),
    [['kill', 2.5]],
    '刺客 20 杀且参团 60% 升到 2.5',
  );

  const assassin20LowKp = killDeathAdjustments({
    ...base,
    role: 'carry',
    kills: 20,
    killParticipation: 0.54,
    teamKills: 63,
    deaths: 8,
    teamDeaths: 43,
    classes: ['assassin'],
  });
  assert.deepEqual(
    assassin20LowKp.map((item) => [item.key, item.value]),
    [['kill', 1.5]],
    '刺客 20 杀但参团不到 55% 只拿基础 1.5',
  );

  const assassin25 = killDeathAdjustments({
    ...base,
    role: 'carry',
    kills: 25,
    teamKills: 63,
    deaths: 8,
    teamDeaths: 43,
    classes: ['assassin'],
  });
  assert.deepEqual(
    assassin25.map((item) => [item.key, item.value]),
    [['kill', 3.5]],
    '刺客 25 杀且参团 60% 升到 3.5',
  );

  const assassin25LowKp = killDeathAdjustments({
    ...base,
    role: 'carry',
    kills: 25,
    killParticipation: 0.59,
    teamKills: 63,
    deaths: 8,
    teamDeaths: 43,
    classes: ['assassin'],
  });
  assert.deepEqual(
    assassin25LowKp.map((item) => [item.key, item.value]),
    [['kill', 2.5]],
    '刺客 25 杀但参团不到 60% 仍按 20 杀档 2.5',
  );

  const assassinHighDeath = killDeathAdjustments({
    ...base,
    role: 'carry',
    kills: 25,
    teamKills: 63,
    deaths: 15,
    teamDeaths: 43,
    classes: ['assassin'],
  });
  assert.deepEqual(
    assassinHighDeath.map((item) => [item.key, item.value]),
    [
      ['kill', 3.5],
      ['death', -1.5],
    ],
    '刺客击杀分不按死亡数打折，死亡扣分仍按输出位规则单独计算',
  );

  const assassinFighter = killDeathAdjustments({
    ...base,
    role: 'fighter',
    kills: 15,
    teamKills: 63,
    deaths: 6,
    teamDeaths: 43,
    classes: ['fighter', 'assassin'],
  });
  assert.deepEqual(
    assassinFighter.map((item) => [item.key, item.value]),
    [['kill', 1.5]],
    '战士 + 刺客 15 杀拿刺客档 1.5，而不是战士档 1',
  );

  const carryNoAssassin = killDeathAdjustments({
    ...base,
    role: 'carry',
    kills: 15,
    teamKills: 63,
    deaths: 6,
    teamDeaths: 43,
    classes: ['mage'],
  });
  assert.equal(carryNoAssassin.length, 0, '普通法师 15 杀还没到输出位的 18 杀门槛');
});

test('经济转化会进入最终评分', () => {
  const base = {
    kda: 4,
    killParticipation: 0.7,
    damageShare: 0.3,
    tankShare: 0.15,
    healShare: 0.05,
    role: 'carry' as const,
    deaths: 4,
  };
  // 经济占比 25% 时转化比 1.2，不触发；降到 20% 后转化比 1.5，触发 +1.5
  const neutral = percentileScores([{ ...base, goldShare: 0.25 }])[0]!;
  const rewarded = percentileScores([{ ...base, goldShare: 0.2 }])[0]!;
  assert.ok(
    Math.abs(rewarded - neutral - 1.5) < 1e-9,
    `中性=${neutral}，低经济高输出=${rewarded}`,
  );
});

test('挂机/逃跑封顶只压高评分，不抬低评分', () => {
  const capped = capAfkScores(
    new Map([
      [1, 80],
      [2, 8],
      [3, 40],
    ]),
    new Set([1, 2]),
  );
  assert.equal(capped.get(1), AFK_SCORE_CAP, '80 分应被压到封顶值');
  assert.equal(capped.get(2), 8, '本来就低于封顶值的不抬分');
  assert.equal(capped.get(3), 40, '未被判定逃跑的玩家不受影响');
});

test('射手和软辅不会被误判成坦克', () => {
  // 赛娜、派克、莫甘娜曾被分到 tank，承伤权重 7.8 会把低承伤的局压到 50 分左右。
  assert.equal(championRole(235), 'carry', '赛娜应算输出');
  assert.equal(championRole(555), 'support', '派克应算辅助');
  assert.equal(championRole(25), 'carry', '莫甘娜应算输出');
  // 特殊模式 ID 需要和基础英雄保持一致。
  assert.equal(championRole(60267), 'support', 'Jade 娜美应算辅助');
  assert.equal(championRole(60025), 'carry', 'Jade 莫甘娜应算输出');
});

test('坦克高承伤和参团时不再被输出位稳压', () => {
  // 2026-11-16 极地大乱斗真实数据：慎（坦克）承伤 32.7% / 参团 74.6% / 治疗 31.8%，
  // 提莫（输出）输出 22.3% / KDA 3.15，但承伤只有 15.8%。调整后坦克不应再被压一头。
  const scores = percentileScores([
    {
      kda: 2.93,
      killParticipation: 0.746,
      damageShare: 0.192,
      tankShare: 0.327,
      healShare: 0.318,
      role: 'tank' as const,
      deaths: 15,
    },
    {
      kda: 2.89,
      killParticipation: 0.441,
      damageShare: 0.131,
      tankShare: 0.18,
      healShare: 0.126,
      role: 'carry' as const,
      deaths: 9,
    },
    {
      kda: 3.55,
      killParticipation: 0.661,
      damageShare: 0.252,
      tankShare: 0.153,
      healShare: 0.296,
      role: 'carry' as const,
      deaths: 11,
    },
    {
      kda: 3.15,
      killParticipation: 0.695,
      damageShare: 0.223,
      tankShare: 0.158,
      healShare: 0.021,
      role: 'carry' as const,
      deaths: 13,
    },
    {
      kda: 2.33,
      killParticipation: 0.593,
      damageShare: 0.202,
      tankShare: 0.182,
      healShare: 0.239,
      role: 'carry' as const,
      deaths: 15,
    },
    {
      kda: 4.33,
      killParticipation: 0.619,
      damageShare: 0.218,
      tankShare: 0.41,
      healShare: 0.682,
      role: 'tank' as const,
      deaths: 9,
    },
    {
      kda: 3,
      killParticipation: 0.571,
      damageShare: 0.214,
      tankShare: 0.145,
      healShare: 0.095,
      role: 'carry' as const,
      deaths: 12,
    },
    {
      kda: 2.25,
      killParticipation: 0.571,
      damageShare: 0.172,
      tankShare: 0.177,
      healShare: 0.121,
      role: 'carry' as const,
      deaths: 16,
    },
    {
      kda: 2.71,
      killParticipation: 0.603,
      damageShare: 0.194,
      tankShare: 0.152,
      healShare: 0.034,
      role: 'carry' as const,
      deaths: 14,
    },
    {
      kda: 5.75,
      killParticipation: 0.73,
      damageShare: 0.202,
      tankShare: 0.116,
      healShare: 0.068,
      role: 'carry' as const,
      deaths: 8,
    },
  ]);
  assert.ok(
    scores[0]! >= scores[3]!,
    `坦克 ${scores[0]} 不应低于提莫 ${scores[3]}（全部：${scores.join(',')}）`,
  );
});

test('参团和输出同时垫底时按减分制判巨坑', () => {
  // 2026-11-16 23:50 极地大乱斗真实数据：螳螂 9/6/3，参团 32.4%、输出占比 7.2%，
  // 两项都远低于输出位阈值，绝对分应再扣短板分，落到「巨坑」。
  const scores = percentileScores([
    { kda: 2.0, killParticipation: 0.541, damageShare: 0.188, tankShare: 0.197, healShare: 0.356, role: 'carry' as const },
    { kda: 1.35, killParticipation: 0.622, damageShare: 0.275, tankShare: 0.319, healShare: 0.388, role: 'fighter' as const },
    { kda: 1.83, killParticipation: 0.595, damageShare: 0.253, tankShare: 0.211, healShare: 0.113, role: 'carry' as const },
    { kda: 2.0, killParticipation: 0.324, damageShare: 0.072, tankShare: 0.109, healShare: 0.079, role: 'carry' as const },
    { kda: 3.0, killParticipation: 0.73, damageShare: 0.213, tankShare: 0.163, healShare: 0.064, role: 'carry' as const },
    { kda: 5.67, killParticipation: 0.63, damageShare: 0.215, tankShare: 0.168, healShare: 0.106, role: 'carry' as const },
    { kda: 5.13, killParticipation: 0.759, damageShare: 0.249, tankShare: 0.251, healShare: 0.414, role: 'carry' as const },
    { kda: 3.2, killParticipation: 0.593, damageShare: 0.125, tankShare: 0.289, healShare: 0.298, role: 'fighter' as const },
    { kda: 6.0, killParticipation: 0.333, damageShare: 0.065, tankShare: 0.08, healShare: 0.083, role: 'carry' as const },
    { kda: 4.0, killParticipation: 0.741, damageShare: 0.346, tankShare: 0.211, healShare: 0.099, role: 'carry' as const },
  ]);
  assert.ok(scores[3]! < 20, `螳螂=${scores[3]}`);
  assert.equal(badLevelOfScore(scores[3]), 'severe');
});

test('评分百分位在本局 10 人内比较', () => {
  const team = (bonus: number) =>
    Array.from({ length: 5 }, (_, index) => ({
      kda: 1 + index + bonus,
      killParticipation: 0.4 + index * 0.08 + bonus * 0.05,
      damageShare: 0.1 + index * 0.03 + bonus * 0.05,
      tankShare: 0.1 + index * 0.02 + bonus * 0.05,
      healShare: 0.05 + index * 0.02 + bonus * 0.05,
    }));
  // 两队内部排序完全一样，只是 B 队整体数据更高：
  // 按局内 10 人比较时，B 队每个位置都应高于 A 队。
  const scores = percentileScores([...team(0), ...team(3)]);
  for (let index = 0; index < 5; index += 1) {
    assert.ok(
      scores[index + 5]! > scores[index]!,
      `B 队第 ${index + 1} 名 ${scores[index + 5]} 应高于 A 队第 ${index + 1} 名 ${scores[index]}`,
    );
  }
  const avg = (values: number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(
    avg(scores.slice(5)) > avg(scores.slice(0, 5)),
    `整体更强的 B 队均值应更高：${scores.join(',')}`,
  );
});

test('大乱斗同队输出位：伤害接近时 KDA 更好的评分更高', () => {
  // 2026-11-18 23:05 极地大乱斗真实数据：
  // 烬 21/5/34，伤害 46,708；灰烬驱魔人 19/14/35，伤害 47,707。
  // 两人伤害只差 2%，旧权重下输出、承伤的名次差把 KDA 优势抵掉，烬反而更低。
  // 输出位降低承伤权重后，KDA 优势应该体现出来。
  const inputs = [
    { kda: 8.5, killParticipation: 0.7183, damageShare: 0.209, tankShare: 0.1477, healShare: 0.1661, role: 'carry' as const },
    { kda: 11, killParticipation: 0.7746, damageShare: 0.2167, tankShare: 0.1185, healShare: 0.1746, role: 'carry' as const },
    { kda: 3.8571, killParticipation: 0.7606, damageShare: 0.2214, tankShare: 0.192, healShare: 0.1978, role: 'carry' as const },
    { kda: 4.1818, killParticipation: 0.6479, damageShare: 0.2191, tankShare: 0.315, healShare: 0.389, role: 'fighter' as const, secondaryRole: 'tank' as const },
    { kda: 2.7857, killParticipation: 0.5493, damageShare: 0.1339, tankShare: 0.2268, healShare: 0.0724, role: 'carry' as const },
    { kda: 1.9444, killParticipation: 0.7, damageShare: 0.2444, tankShare: 0.2201, healShare: 0.3184, role: 'fighter' as const, secondaryRole: 'carry' as const },
    { kda: 3.3333, killParticipation: 0.6, damageShare: 0.1791, tankShare: 0.2084, healShare: 0.2009, role: 'tank' as const, secondaryRole: 'fighter' as const },
    { kda: 3.2308, killParticipation: 0.84, damageShare: 0.2399, tankShare: 0.2693, healShare: 0.2799, role: 'tank' as const },
    { kda: 1.6429, killParticipation: 0.46, damageShare: 0.1516, tankShare: 0.1276, healShare: 0.0995, role: 'carry' as const },
    { kda: 1.8235, killParticipation: 0.62, damageShare: 0.185, tankShare: 0.1745, healShare: 0.1013, role: 'fighter' as const, secondaryRole: 'carry' as const },
  ];
  const scores = percentileScores(inputs);
  assert.ok(
    scores[1]! > scores[2]!,
    `烬（21/5/34）=${scores[1]} 应高于灰烬驱魔人（19/14/35）=${scores[2]}`,
  );
});

test('碾压局的胜方整体高于败方', () => {
  // 2026-11-18 20:48 极地大乱斗：胜方 37 杀、败方 16 杀，11 分 39 秒结束。
  // 按本队 5 人比较时两队均分接近（约 62 : 62），按局内 10 人比较才能拉开差距。
  const scores = percentileScores([
    { kda: 32, killParticipation: 0.865, damageShare: 0.22, tankShare: 0.118, healShare: 0.136, role: 'carry' as const, deaths: 1 },
    { kda: 10, killParticipation: 0.541, damageShare: 0.116, tankShare: 0.31, healShare: 0.398, role: 'tank' as const, deaths: 2 },
    { kda: 5.5, killParticipation: 0.892, damageShare: 0.239, tankShare: 0.213, healShare: 0.089, role: 'carry' as const, deaths: 6 },
    { kda: 8.667, killParticipation: 0.703, damageShare: 0.134, tankShare: 0.192, healShare: 0.286, role: 'carry' as const, deaths: 3 },
    { kda: 7.25, killParticipation: 0.784, damageShare: 0.291, tankShare: 0.167, healShare: 0.092, role: 'carry' as const, deaths: 4 },
    { kda: 1.6, killParticipation: 0.5, damageShare: 0.134, tankShare: 0.226, healShare: 0.235, role: 'tank' as const, deaths: 5 },
    { kda: 1.25, killParticipation: 0.625, damageShare: 0.369, tankShare: 0.15, healShare: 0.089, role: 'carry' as const, deaths: 8 },
    { kda: 1, killParticipation: 0.563, damageShare: 0.147, tankShare: 0.269, healShare: 0.099, role: 'fighter' as const, deaths: 9 },
    { kda: 1, killParticipation: 0.625, damageShare: 0.184, tankShare: 0.241, healShare: 0.489, role: 'fighter' as const, deaths: 10 },
    { kda: 1.8, killParticipation: 0.563, damageShare: 0.166, tankShare: 0.113, healShare: 0.089, role: 'carry' as const, deaths: 5 },
  ]);
  const avg = (values: number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const winAvg = avg(scores.slice(0, 5));
  const lossAvg = avg(scores.slice(5));
  assert.ok(winAvg - lossAvg > 12, `胜方 ${winAvg.toFixed(1)} 应明显高于败方 ${lossAvg.toFixed(1)}`);
  assert.ok(
    Math.min(...scores.slice(5)) < 40,
    `败方最低分应明显偏低：${scores.slice(5).join(',')}`,
  );
});

test('解析 Live Client Data 的装备对象', () => {
  assert.deepEqual(liveItemIds([{ itemID: 6655 }, { itemID: 3020 }]), [6655, 3020]);
  assert.deepEqual(liveItemIds([6655, 3020]), [6655, 3020]);
  assert.deepEqual(liveItemIds([{ itemId: 3157 }, { itemID: 0 }]), [3157]);
  assert.deepEqual(liveItemIds(undefined), []);
});

test('实时 AI 提示词包含装备、模式限制、符文、血量和事件', () => {
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
    liveTimeline: {
      gameTimeMs: 300_000,
      dead: false,
      lives: [
        {
          index: 1,
          startMs: 0,
          endMs: 120_000,
          aliveMs: 120_000,
          respawnMs: 0,
          kills: 1,
          deaths: 1,
          assists: 0,
          cs: 20,
          level: 4,
          death: {
            timestampMs: 120_000,
            killerName: '敌人',
            assistNames: [],
          },
        },
        {
          index: 2,
          startMs: 132_000,
          endMs: 300_000,
          aliveMs: 168_000,
          respawnMs: 12_000,
          kills: 0,
          deaths: 0,
          assists: 2,
          cs: 15,
          level: 5,
        },
      ],
    },
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
        premadeSize: 2,
        premadeSource: 'session',
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
  assert.ok(text.includes('开黑 2 人（本局确认）'), text);
  assert.ok(text.includes('【评分目标】'), text);
  assert.ok(text.includes('权重（局内百分位）'), text);
  assert.ok(text.includes('输出占比权重最高'), text);
  assert.ok(text.includes('2. 我的评分提升重点'), text);
  // 对局中 AI 要带上实时每条命时间线
  assert.ok(text.includes('我的实时每条命'), text);
  assert.ok(text.includes('第1条'), text);
  assert.ok(text.includes('被敌人击杀'), text);
  assert.ok(text.includes('复活约 12s'), text);
  // 大乱斗必须明确禁用装备和不能回城等硬规则，避免 AI 推荐守护天使
  assert.ok(text.includes('商店禁用装备'), text);
  assert.ok(text.includes('守护天使'), text);
  assert.ok(text.includes('黑暗封印'), text);
  assert.ok(text.includes('没有回城'), text);
  assert.ok(text.includes('只列当前模式能买到'), text);
  // 出装要按敌方阵容给分支，并明确心之钢在大乱斗可用
  assert.ok(text.includes('出装分支要求'), text);
  assert.ok(text.includes('半肉'), text);
  assert.ok(text.includes('全肉'), text);
  assert.ok(text.includes('心之钢在极地大乱斗可以正常购买'), text);
  assert.ok(text.includes('敌方阵容构成'), text);

  const srText = buildLiveAnalysisMessages(
    { ...snapshot, queueId: 420, gameMode: 'CLASSIC' } as unknown as Snapshot,
    () => '',
  )
    .map((message) => message.content)
    .join('\n');
  assert.ok(!srText.includes('守护天使'), srText);
  assert.ok(!srText.includes('心之钢在极地大乱斗可以正常购买'), srText);
  assert.ok(srText.includes('【装备可用性】'), srText);
});

test('对局中 AI 追问只回答当前问题，不再重刷整篇复盘', () => {
  const snapshot = {
    mode: 'live',
    phase: 'InProgress',
    inChampSelect: false,
    inGame: true,
    collecting: false,
    updatedAt: '',
    queueId: 450,
    gameMode: 'ARAM',
    gameTime: 600,
    liveSessionId: 'session',
    liveEvents: [],
    localPlayer: {
      summonerId: 1,
      displayName: '我',
      cellId: 0,
      championId: 202,
      championName: '戏命师',
    },
    players: [
      {
        summonerId: 1,
        displayName: '我',
        championName: '戏命师',
        position: 'ARAM',
        isEnemy: false,
        labels: [],
        live: { kills: 5, deaths: 2, assists: 6, cs: 20, championLevel: 11 },
      },
    ],
  } as unknown as Snapshot;

  const messages = buildLiveFollowUpMessages(snapshot, () => '', '下一件装备出什么？');
  const system = messages[0]?.content ?? '';
  const user = messages[1]?.content ?? '';
  assert.ok(system.includes('追问模式'), '追问要切换到追问模式');
  assert.ok(system.includes('不要重复整篇复盘'), '追问不能重刷整篇复盘');
  assert.ok(user.includes('【本次追问】下一件装备出什么？'), '用户消息要带上具体问题');
  assert.ok(!user.includes('请按系统要求输出 7 个部分'), '追问不应再要求 7 个部分');
  assert.ok(user.includes('【我的英雄】'), '追问仍然要带上实时对局上下文');
});

test('选人阶段 AI 提示词包含替补席、开黑和模式限制', () => {  const recent = (champion: string) => ({
    games: 10,
    wins: 6,
    losses: 4,
    winRate: 0.6,
    avgScore: 62,
    avgKda: 2.4,
    avgDamage: 18000,
    avgDamagePerMin: 900,
    avgKillParticipation: 0.62,
    avgCsPerMin: 5.2,
    avgVisionPerMin: 0.8,
    avgDeaths: 4.1,
    labels: ['稳健'],
    topChampions: [
      { championId: 86, name: champion, games: 12, wins: 7, winRate: 0.58, avgKda: 2.6 },
      { championId: 103, name: '九尾妖狐', games: 6, wins: 4, winRate: 0.67, avgKda: 3.1 },
    ],
  });
  const snapshot = {
    mode: 'live',
    phase: 'ChampSelect',
    inChampSelect: true,
    inGame: false,
    collecting: false,
    updatedAt: '',
    queueId: 450,
    gameMode: 'ARAM',
    aramChampions: [
      {
        championId: 86,
        championName: '盖伦',
        isCurrent: true,
        games: 5,
        wins: 3,
        winRate: 0.6,
        avgScore: 62,
        globalGames: 100,
        globalWinRate: 0.52,
      },
      {
        championId: 103,
        championName: '九尾妖狐',
        isCurrent: false,
        isPriority: true,
        games: 0,
        wins: 0,
        winRate: 0,
        avgScore: 0,
        globalGames: 200,
        globalWinRate: 0.55,
      },
    ],
    localPlayer: {
      summonerId: 1,
      displayName: '我',
      cellId: 0,
      championId: 86,
      championName: '盖伦',
    },
    players: [
      {
        summonerId: 1,
        displayName: '我',
        championName: '盖伦',
        position: 'ARAM',
        isEnemy: false,
        rating: 62,
        labels: [],
        premadeSize: 2,
        premadeSource: 'session',
        recent: recent('盖伦'),
        championStats: {
          championId: 86,
          games: 5,
          wins: 3,
          winRate: 0.6,
          avgScore: 62,
          bestScore: 78,
        },
      },
      {
        summonerId: 2,
        displayName: '队友',
        isEnemy: false,
        rating: 48,
        labels: [],
      },
    ],
  } as unknown as Snapshot;
  const text = buildChampSelectAnalysisMessages(snapshot)
    .map((message) => message.content)
    .join('\n');
  assert.ok(text.includes('【选人阶段】'), text);
  assert.ok(text.includes('敌方英雄在选人阶段不可见'), text);
  assert.ok(text.includes('大乱斗可选英雄'), text);
  assert.ok(text.includes('九尾妖狐'), text);
  assert.ok(text.includes('替补'), text);
  assert.ok(text.includes('开黑 2 人'), text);
  assert.ok(text.includes('守护天使'), text);
  assert.ok(text.includes('6 个部分'), text);

  const srText = buildChampSelectAnalysisMessages({
    ...snapshot,
    queueId: 420,
    gameMode: 'SR',
    aramChampions: undefined,
  } as Snapshot)
    .map((message) => message.content)
    .join('\n');
  assert.ok(srText.includes('选人结论'), srText);
  assert.ok(!srText.includes('大乱斗可选英雄'), srText);
  assert.ok(!srText.includes('商店禁用装备'), srText);
});

test('赛后 AI 复盘同样校验大乱斗禁用装备', () => {
  const detail = {
    gameId: 1,
    queueId: 450,
    queueName: '极地大乱斗',
    gameMode: 'ARAM',
    gameCreation: 0,
    gameDuration: 1200,
    selfPuuid: 'me',
    scoreboard: [{ puuid: 'me', championName: '格温', teamId: 100, isEnemy: false }],
    players: [],
  } as unknown as MatchDetail;
  const text = buildAnalysisMessages(detail)
    .map((message) => message.content)
    .join('\n');
  assert.ok(text.includes('商店禁用装备'), text);
  assert.ok(text.includes('守护天使'), text);
  assert.ok(text.includes('先确认装备在当前模式可购买'), text);
});

test('赛后 AI 复盘会带上每条命时间线且不编造每命伤害', () => {
  const detail = {
    gameId: 2,
    queueId: 420,
    queueName: '单双排',
    gameMode: 'SR',
    gameCreation: 0,
    gameDuration: 1200,
    selfPuuid: 'me',
    scoreboard: [
      {
        puuid: 'me',
        championName: '格温',
        teamId: 100,
        isEnemy: false,
        kills: 2,
        deaths: 1,
        assists: 3,
        cs: 130,
        gold: 10_000,
        damage: 20_000,
        damageTaken: 15_000,
        vision: 10,
        win: true,
      },
    ],
    players: [],
  } as unknown as MatchDetail;
  const timeline = {
    gameId: 2,
    durationMs: 1_200_000,
    players: [
      {
        participantId: 1,
        puuid: 'me',
        name: '我',
        championId: 103,
        championName: '格温',
        teamId: 100,
        kills: 2,
        deaths: 1,
        assists: 3,
        damage: 20_000,
        damageTaken: 15_000,
        lives: [
          {
            index: 1,
            startMs: 0,
            endMs: 300_000,
            respawnMs: 0,
            aliveMs: 300_000,
            kills: 1,
            assists: 1,
            cs: 30,
            gold: 3_000,
            level: 6,
            death: {
              timestampMs: 300_000,
              killerId: 2,
              killerName: '敌1#0001',
              assistIds: [3],
              assistNames: ['敌2#0002'],
            },
          },
          {
            index: 2,
            startMs: 310_000,
            endMs: 1_200_000,
            respawnMs: 10_000,
            aliveMs: 890_000,
            kills: 1,
            assists: 2,
            cs: 100,
            gold: 9_000,
            level: 13,
          },
        ],
      },
      {
        participantId: 2,
        puuid: 'e1',
        name: '敌人一',
        championId: 64,
        championName: '盲僧',
        teamId: 200,
        kills: 1,
        deaths: 1,
        assists: 0,
        damage: 0,
        damageTaken: 0,
        lives: [],
      },
      {
        participantId: 3,
        puuid: 'e2',
        name: '敌人二',
        championId: 99,
        championName: '拉克丝',
        teamId: 200,
        kills: 0,
        deaths: 1,
        assists: 1,
        damage: 0,
        damageTaken: 0,
        lives: [],
      },
    ],
    series: [
      {
        timestampMs: 60_000,
        teams: [
          { teamId: 100, gold: 2_000, xp: 200 },
          { teamId: 200, gold: 1_500, xp: 150 },
        ],
      },
      {
        timestampMs: 1_200_000,
        teams: [
          { teamId: 100, gold: 50_000, xp: 5_000 },
          { teamId: 200, gold: 45_000, xp: 4_800 },
        ],
      },
    ],
    buildings: [
      {
        timestampMs: 500_000,
        teamId: 100,
        buildingType: 'TOWER_BUILDING',
        laneType: 'MID_LANE',
        towerType: 'OUTER_TURRET',
      },
    ],
  } as MatchTimeline;
  const text = buildAnalysisMessages(detail, () => '', timeline)
    .map((message) => message.content)
    .join('\n');
  assert.ok(text.includes('我的每条命时间线'), text);
  assert.ok(text.includes('第 1 条'), text);
  assert.ok(text.includes('被盲僧击杀'), text);
  assert.ok(text.includes('助攻 拉克丝'), text);
  assert.ok(text.includes('经济差 +0.5k → +5.0k'), text);
  assert.ok(text.includes('推塔 1:0'), text);
  assert.ok(text.includes('禁止编造'), '应明确禁止编造每条命伤害');
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

test('时间线证明一直在补刀或参战时撤销逃跑判定', () => {
  const player = {
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
  assert.equal(
    isAfkLikeRelative(
      { ...player, idleStreakSeconds: AFK_IDLE_VETO_SECONDS - 60 },
      [player, normal],
    ),
    false,
    '时间线证明最多 4 分钟没有补刀或参战，应撤销逃跑判定',
  );
  assert.equal(
    isAfkLikeRelative(
      { ...player, idleStreakSeconds: AFK_IDLE_VETO_SECONDS + 60 },
      [player, normal],
    ),
    true,
    '连续 6 分钟没有补刀或参战时，时间线不能排除逃跑',
  );
  assert.equal(
    isAfkLikeRelative({ ...player, idleStreakSeconds: 0 }, [player, normal]),
    false,
    '全程都有补刀或战斗参与时不应判逃跑',
  );
});

test('时间线显示长时间原地不动时判逃跑', () => {
  const active = {
    durationMin: 19,
    gold: 13000,
    damage: 30000,
    cs: 80,
    kills: 10,
    deaths: 8,
    assists: 20,
    visionScore: 20,
    position: 'MID' as Lane,
    killParticipation: 0.7,
    damageTaken: 25000,
    heal: 1000,
  };
  const normal = { ...active };
  assert.equal(
    isAfkLikeRelative(
      { ...active, stationaryStreakSeconds: AFK_STATIONARY_SECONDS - 1 },
      [active, normal],
    ),
    false,
    '原地不动不到 3 分钟时仍按原有规则判断',
  );
  assert.equal(
    isAfkLikeRelative(
      { ...active, stationaryStreakSeconds: AFK_STATIONARY_SECONDS },
      [active, normal],
    ),
    true,
    '原地不动满 3 分钟时即使前期有击杀助攻也判逃跑',
  );
});

test('时间线与存档 participantId 错位时按 puuid 判断逃跑', () => {
  const game: RawGame = {
    gameId: 999,
    queueId: 450,
    gameDuration: 1200,
    participants: [
      {
        participantId: 1,
        teamId: 100,
        championId: 103,
        stats: {
          win: true,
          kills: 5,
          deaths: 3,
          assists: 10,
          totalDamageDealtToChampions: 30000,
          totalDamageTaken: 25000,
          goldEarned: 13000,
          totalMinionsKilled: 150,
          visionScore: 20,
          totalHeal: 1000,
        },
      },
      {
        participantId: 2,
        teamId: 100,
        championId: 64,
        stats: {
          win: true,
          kills: 0,
          deaths: 0,
          assists: 0,
          totalDamageDealtToChampions: 500,
          totalDamageTaken: 800,
          goldEarned: 4000,
          totalMinionsKilled: 0,
          visionScore: 0,
          totalHeal: 0,
        },
      },
    ],
    participantIdentities: [
      { participantId: 1, player: { puuid: 'normal', gameName: '正常', tagLine: '0001' } },
      { participantId: 2, player: { puuid: 'afk', gameName: '挂机', tagLine: '0002' } },
    ],
  };
  const timeline: MatchTimeline = {
    gameId: 999,
    durationMs: 1_200_000,
    players: [
      {
        participantId: 1,
        puuid: 'afk',
        name: '挂机',
        championId: 64,
        teamId: 100,
        kills: 0,
        deaths: 0,
        assists: 0,
        damage: 500,
        damageTaken: 800,
        maxStationaryMs: 600_000,
        lives: [],
      },
      {
        participantId: 2,
        puuid: 'normal',
        name: '正常',
        championId: 103,
        teamId: 100,
        kills: 5,
        deaths: 3,
        assists: 10,
        damage: 30000,
        damageTaken: 25000,
        maxStationaryMs: 0,
        lives: [],
      },
    ],
  };
  assert.deepEqual(
    [...afkParticipantIds(game, new Map(), undefined, timeline)],
    [2],
    '应按 puuid 把挂机时长对应到参与者 2，而不是按错位的 participantId',
  );
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

test('时段统计按本地时间统计时段、星期、周、月、位置和类型', () => {
  const at = (month: number, day: number, hour: number, minute = 0) =>
    new Date(2026, month - 1, day, hour, minute).getTime();
  const summary = summarizeTimeStats([
    {
      gameCreation: at(1, 5, 0, 30),
      win: true,
      tags: [],
      position: 'TOP',
      championId: 103,
    },
    {
      gameCreation: at(1, 5, 1, 59),
      win: false,
      tags: ['队友很坑'],
      position: 'TOP',
      championId: 89,
    },
    {
      gameCreation: at(1, 5, 2, 10),
      win: true,
      tags: ['队友巨坑', '自己小坑'],
      position: 'JUNGLE',
      championId: 64,
    },
    {
      gameCreation: at(1, 11, 23, 10),
      win: false,
      tags: ['队友逃跑'],
      position: 'UTILITY',
      championId: 16,
    },
    {
      gameCreation: at(1, 12, 23, 50),
      win: true,
      tags: ['重开'],
      position: 'MID',
      championId: 103,
    },
    {
      gameCreation: at(2, 2, 20, 0),
      win: true,
      tags: [],
      position: 'MID',
      championId: 103,
    },
  ]);
  assert.equal(summary.totalGames, 5);
  assert.equal(summary.wins, 3);
  assert.equal(summary.winRate, 0.6);
  assert.equal(summary.dimensions.hour.length, 12);
  assert.equal(summary.dimensions.weekday.length, 7);

  const early = summary.dimensions.hour[0];
  assert.ok(early);
  assert.equal(early.label, '00:00-02:00');
  assert.equal(early.games, 2);
  assert.equal(early.wins, 1);
  assert.equal(early.losses, 1);
  assert.equal(early.teammateBadGames, 1);
  assert.equal(early.selfBadGames, 0);

  const morning = summary.dimensions.hour[1];
  assert.ok(morning);
  assert.equal(morning.games, 1);
  assert.equal(morning.wins, 1);
  assert.equal(morning.teammateBadGames, 1);
  assert.equal(morning.selfBadGames, 1);

  const late = summary.dimensions.hour[11];
  assert.ok(late);
  assert.equal(late.games, 1);
  assert.equal(late.wins, 0);
  assert.equal(late.teammateBadGames, 1);
  assert.equal(late.teammateBadRate, 1);

  const monday = summary.dimensions.weekday[0];
  assert.ok(monday);
  assert.equal(monday.label, '周一');
  assert.equal(monday.games, 4);
  assert.equal(monday.wins, 3);
  assert.equal(monday.teammateBadGames, 2);
  assert.equal(monday.selfBadGames, 1);

  const sunday = summary.dimensions.weekday[6];
  assert.ok(sunday);
  assert.equal(sunday.label, '周日');
  assert.equal(sunday.games, 1);
  assert.equal(sunday.wins, 0);

  const firstWeek = summary.dimensions.week.find((bucket) => bucket.key === '2026-01-05');
  assert.ok(firstWeek);
  assert.equal(firstWeek.label, '01/05-01/11');
  assert.equal(firstWeek.games, 4);
  assert.equal(firstWeek.wins, 2);
  assert.equal(firstWeek.teammateBadGames, 3);
  assert.equal(firstWeek.selfBadGames, 1);

  const secondWeek = summary.dimensions.week.find((bucket) => bucket.key === '2026-02-02');
  assert.ok(secondWeek);
  assert.equal(secondWeek.games, 1);
  assert.equal(secondWeek.wins, 1);

  const january = summary.dimensions.month.find((bucket) => bucket.key === '2026-01');
  assert.ok(january);
  assert.equal(january.games, 4);
  assert.equal(january.wins, 2);
  assert.equal(january.teammateBadGames, 3);
  assert.equal(january.selfBadGames, 1);

  const february = summary.dimensions.month.find((bucket) => bucket.key === '2026-02');
  assert.ok(february);
  assert.equal(february.games, 1);
  assert.equal(february.wins, 1);

  const top = summary.dimensions.position.find((bucket) => bucket.key === 'pos-top');
  assert.ok(top);
  assert.equal(top.label, '上单');
  assert.equal(top.games, 2);
  assert.equal(top.wins, 1);
  assert.equal(top.teammateBadGames, 1);

  const jungle = summary.dimensions.position.find((bucket) => bucket.key === 'pos-jungle');
  assert.ok(jungle);
  assert.equal(jungle.label, '打野');
  assert.equal(jungle.games, 1);
  assert.equal(jungle.wins, 1);
  assert.equal(jungle.selfBadGames, 1);

  const support = summary.dimensions.position.find((bucket) => bucket.key === 'pos-support');
  assert.ok(support);
  assert.equal(support.label, '辅助');
  assert.equal(support.games, 1);
  assert.equal(support.wins, 0);
  assert.equal(support.teammateBadGames, 1);

  const carry = summary.dimensions.type.find((bucket) => bucket.key === 'type-carry');
  assert.ok(carry);
  assert.equal(carry.label, '输出');
  assert.equal(carry.games, 2);
  assert.equal(carry.wins, 2);

  const tank = summary.dimensions.type.find((bucket) => bucket.key === 'type-tank');
  assert.ok(tank);
  assert.equal(tank.games, 1);
  assert.equal(tank.wins, 0);

  const fighter = summary.dimensions.type.find((bucket) => bucket.key === 'type-fighter');
  assert.ok(fighter);
  assert.equal(fighter.games, 1);
  assert.equal(fighter.wins, 1);
  assert.equal(fighter.selfBadGames, 1);
});

test('时段统计使用当前坑线重新判断结果', () => {
  const summary = summarizeTimeStats([
    {
      gameCreation: new Date(2026, 0, 5, 1, 0).getTime(),
      win: true,
      tags: [],
      teammateBad: true,
      selfBad: true,
    },
  ]);
  const early = summary.dimensions.hour[0];
  assert.ok(early);
  assert.equal(early.teammateBadGames, 1);
  assert.equal(early.selfBadGames, 1);
});

test('时段统计按各维度汇总平均评分并忽略缺失评分', () => {
  const at = (day: number, hour: number) => new Date(2026, 0, day, hour, 30).getTime();
  const summary = summarizeTimeStats([
    {
      gameCreation: at(5, 0),
      win: true,
      tags: [],
      position: 'TOP',
      championId: 103,
      score: 80,
    },
    {
      gameCreation: at(5, 1),
      win: false,
      tags: [],
      position: 'TOP',
      championId: 103,
      score: 60,
    },
    {
      gameCreation: at(5, 3),
      win: true,
      tags: [],
      position: 'JUNGLE',
      championId: 64,
      score: 55.5,
    },
    {
      gameCreation: at(5, 3),
      win: false,
      tags: [],
      position: 'JUNGLE',
      championId: 64,
    },
    {
      gameCreation: at(5, 0),
      win: true,
      tags: ['重开'],
      position: 'MID',
      championId: 103,
      score: 100,
    },
  ]);

  assert.equal(summary.totalGames, 4);
  assert.equal(summary.scoreGames, 3);
  assert.equal(summary.avgScore, 65.2);

  const early = summary.dimensions.hour[0];
  assert.ok(early);
  assert.equal(early.games, 2);
  assert.equal(early.scoreGames, 2);
  assert.equal(early.avgScore, 70);
  assert.equal(early.bestScore, 80);
  assert.equal(early.worstScore, 60);
  assert.equal(early.grade, 'A');

  const morning = summary.dimensions.hour[1];
  assert.ok(morning);
  assert.equal(morning.games, 2);
  assert.equal(morning.scoreGames, 1);
  assert.equal(morning.avgScore, 55.5);
  assert.equal(morning.grade, 'C');

  const noScore = summary.dimensions.hour[2];
  assert.ok(noScore);
  assert.equal(noScore.games, 0);
  assert.equal(noScore.scoreGames, 0);
  assert.equal(noScore.grade, undefined);

  const top = summary.dimensions.position.find((bucket) => bucket.key === 'pos-top');
  assert.ok(top);
  assert.equal(top.scoreGames, 2);
  assert.equal(top.avgScore, 70);

  const jungle = summary.dimensions.position.find((bucket) => bucket.key === 'pos-jungle');
  assert.ok(jungle);
  assert.equal(jungle.games, 2);
  assert.equal(jungle.scoreGames, 1);
  assert.equal(jungle.avgScore, 55.5);

  const remakeOnly = summary.dimensions.position.find((bucket) => bucket.key === 'pos-mid');
  assert.ok(remakeOnly);
  assert.equal(remakeOnly.games, 0);
  assert.equal(remakeOnly.scoreGames, 0);
});

test('英雄熟练度综合场次和表现并随样本增长', () => {
  const oneGame = championProficiency({
    games: 1,
    winRate: 1,
    avgScore: 80,
    bestScore: 80,
  });
  const tenGames = championProficiency({
    games: 10,
    winRate: 0.6,
    avgScore: 65,
    bestScore: 80,
  });
  const hundredGames = championProficiency({
    games: 100,
    winRate: 0.55,
    avgScore: 70,
    bestScore: 90,
  });

  assert.ok(oneGame > 0 && oneGame < 20, `oneGame=${oneGame}`);
  assert.ok(tenGames > 30 && tenGames < 55, `tenGames=${tenGames}`);
  assert.ok(hundredGames > 70 && hundredGames < 90, `hundredGames=${hundredGames}`);
  assert.ok(oneGame < tenGames && tenGames < hundredGames);
  assert.equal(
    championProficiency({ games: 0, winRate: 1, avgScore: 100, bestScore: 100 }),
    0,
  );
});

test('坑场次只统计 30 分以下，包含小坑、很坑和巨坑', () => {
  const summary = summarize([
    makeGame(1, 'MID', { score: 30 }),
    makeGame(2, 'MID', { score: 29.9 }),
    makeGame(3, 'MID', { score: 25 }),
    makeGame(4, 'MID', { score: 24.9 }),
    makeGame(5, 'MID', { score: 19.9 }),
    makeGame(6, 'MID', { score: 35 }),
  ]);
  assert.equal(summary.games, 6);
  assert.equal(summary.pitGames, 4);
});

test('识别同队共享 teamParticipantId 的开黑玩家', () => {
  const sizes = premadeSizesByPuuid([
    [
      { puuid: 'a', teamParticipantId: 1 },
      { puuid: 'b', teamParticipantId: 1 },
      { puuid: 'c', teamParticipantId: 2 },
    ],
    [
      { puuid: 'd', teamParticipantId: 1 },
      { puuid: 'e', teamParticipantId: 1 },
    ],
  ]);
  assert.equal(sizes.get('a'), 2);
  assert.equal(sizes.get('b'), 2);
  assert.equal(sizes.get('c'), undefined);
  assert.equal(sizes.get('d'), 2);
  assert.equal(sizes.get('e'), 2);
  assert.equal(sizes.size, 4);
});

test('历史对局按最近同队同局推断开黑分组', () => {
  const game = (gameId: number, teamId: number) => ({ gameId, teamId });
  const sizes = premadeSizesFromGames(
    [
      {
        puuid: 'duo-a',
        isEnemy: true,
        games: [game(1, 100), game(2, 100), game(3, 100), game(4, 100)],
      },
      {
        puuid: 'duo-b',
        isEnemy: true,
        games: [game(1, 100), game(2, 100), game(3, 100)],
      },
      {
        puuid: 'random-a',
        isEnemy: true,
        games: [game(1, 100), game(5, 100), game(6, 100)],
      },
      {
        puuid: 'random-b',
        isEnemy: true,
        games: [game(1, 100), game(5, 200), game(6, 200)],
      },
      {
        puuid: 'trio-a',
        isEnemy: false,
        games: [game(1, 200), game(7, 200), game(8, 200)],
      },
      {
        puuid: 'trio-b',
        isEnemy: false,
        games: [game(1, 200), game(7, 200), game(8, 200)],
      },
      {
        puuid: 'trio-c',
        isEnemy: false,
        games: [game(1, 200), game(7, 200), game(8, 200)],
      },
    ],
    1,
  );
  assert.equal(sizes.get('duo-a'), 2, '两场同队同局应识别为双排');
  assert.equal(sizes.get('duo-b'), 2);
  assert.equal(sizes.get('random-a'), undefined, '同局但不同队不应算开黑');
  assert.equal(sizes.get('random-b'), undefined);
  assert.equal(sizes.get('trio-a'), 3, '三人共同同队同局应识别为三排');
  assert.equal(sizes.get('trio-b'), 3);
  assert.equal(sizes.get('trio-c'), 3);
});

test('只有一场同队同局时不标开黑，避免随机重排误判', () => {
  const sizes = premadeSizesFromGames(
    [
      { puuid: 'a', isEnemy: true, games: [{ gameId: 10, teamId: 100 }] },
      { puuid: 'b', isEnemy: true, games: [{ gameId: 10, teamId: 100 }] },
    ],
    10,
  );
  assert.equal(sizes.size, 0);
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

test('客户端只给 1 场时用存档补齐到目标场次', () => {
  const fromClient = [makeGame(1, 'ARAM', { queueId: 450, gameCreation: 5_000 })];
  const archived = [
    makeGame(2, 'ARAM', { queueId: 450, gameCreation: 4_000 }),
    makeGame(3, 'ARAM', { queueId: 450, gameCreation: 3_000 }),
    makeGame(4, 'ARAM', { queueId: 450, gameCreation: 2_000 }),
  ];
  const merged = mergeIncrementalGames(fromClient, archived, 10);
  assert.deepEqual(
    merged.map((game) => game.gameId),
    [1001, 1002, 1003, 1004],
  );
});

console.log('eog');
test('结算数据可转换成可评分的对局', () => {
  const block = {
    gameId: 9_001,
    queueId: 450,
    gameMode: 'ARAM',
    gameLength: 1_200,
    teams: [
      {
        teamId: 100,
        isWinningTeam: true,
        players: [
          {
            championId: 103,
            summonerId: 11,
            summonerName: 'A',
            stats: { CHAMPIONS_KILLED: 10, NUM_DEATHS: 2, ASSISTS: 20 },
          },
          {
            championId: 22,
            summonerId: 12,
            summonerName: 'B',
            stats: { CHAMPIONS_KILLED: 3, NUM_DEATHS: 5, ASSISTS: 15 },
          },
        ],
      },
      {
        teamId: 200,
        isWinningTeam: false,
        players: [
          {
            championId: 1,
            summonerId: 21,
            summonerName: 'C',
            stats: { CHAMPIONS_KILLED: 2, NUM_DEATHS: 6, ASSISTS: 8 },
          },
          {
            championId: 2,
            summonerId: 22,
            summonerName: 'D',
            stats: { CHAMPIONS_KILLED: 1, NUM_DEATHS: 7, ASSISTS: 6 },
          },
        ],
      },
    ],
  };
  const game = endOfGameToRawGame(
    block,
    [{ puuid: 'p1' }, { puuid: 'p2' }, { puuid: 'p3' }, { puuid: 'p4' }],
    5_000_000,
  );
  assert.ok(game, '结算数据应能转换成对局');
  assert.equal(game.gameId, 9_001);
  assert.equal(game.gameCreation, 5_000_000 - 1_200_000);
  assert.equal(game.participants?.length, 4);
  assert.equal(game.participants?.[0]?.stats?.kills, 10);
  assert.equal(game.participants?.[0]?.stats?.win, true);
  assert.equal(game.participants?.[2]?.stats?.win, false);
  assert.equal(game.participantIdentities?.[0]?.player?.puuid, 'p1');
});

test('结算数据缺少 puuid 时不生成对局', () => {
  const block = {
    gameId: 9_002,
    queueId: 450,
    gameLength: 1_200,
    teams: [
      { teamId: 100, isWinningTeam: true, players: [{ championId: 1 }] },
      { teamId: 200, isWinningTeam: false, players: [{ championId: 2 }] },
    ],
  };
  assert.equal(endOfGameToRawGame(block, [{ puuid: '' }, { puuid: 'p2' }]), undefined);
});

test('结算数据只有 queueType 时也能识别队列', () => {
  const block = {
    gameId: 9_004,
    queueType: 'ARAM_UNRANKED_5x5',
    gameMode: 'ARAM',
    gameLength: 1_165,
    teams: [
      {
        teamId: 100,
        isWinningTeam: true,
        players: [{ championId: 113, summonerId: 11, stats: { WIN: 1 } }],
      },
      {
        teamId: 200,
        isWinningTeam: false,
        players: [{ championId: 1, summonerId: 22, stats: { WIN: 0 } }],
      },
    ],
  };
  const game = endOfGameToRawGame(
    block,
    [{ puuid: 'p1' }, { puuid: 'p2' }],
    5_000_000,
  );
  assert.equal(game?.queueId, 450, 'queueType 应映射成大乱斗队列');
  assert.equal(game?.gameMode, 'ARAM');
  assert.equal(game?.participants?.length, 2);
});

test('结算数据只有小写统计字段时也能解析', () => {
  const block = {
    gameId: 9_005,
    queueId: 420,
    gameLength: 1_800,
    teams: [
      {
        teamId: 100,
        isWinningTeam: true,
        players: [
          {
            championId: 1,
            summonerId: 11,
            stats: {
              WIN: 1,
              kills: 7,
              deaths: 3,
              assists: 9,
              goldEarned: 12_345,
              totalDamageDealtToChampions: 23_456,
              totalDamageTaken: 18_000,
              totalHeal: 1_500,
              visionScore: 21,
              totalMinionsKilled: 180,
              neutralMinionsKilled: 4,
              largestKillingSpree: 5,
              doubleKills: 1,
              tripleKills: 0,
              quadraKills: 0,
              pentaKills: 0,
              turretKills: 2,
              firstBloodKill: 1,
            },
          },
        ],
      },
      {
        teamId: 200,
        isWinningTeam: false,
        players: [{ championId: 2, summonerId: 22, stats: { WIN: 0 } }],
      },
    ],
  };
  const game = endOfGameToRawGame(block, [{ puuid: 'p1' }, { puuid: 'p2' }], 5_000_000);
  const stats = game?.participants?.[0]?.stats;
  assert.equal(stats?.kills, 7);
  assert.equal(stats?.deaths, 3);
  assert.equal(stats?.assists, 9);
  assert.equal(stats?.goldEarned, 12_345);
  assert.equal(stats?.totalDamageDealtToChampions, 23_456);
  assert.equal(stats?.visionScore, 21);
  assert.equal(stats?.firstBloodKill, true);
});

test('普通投降不会被当成重开', () => {
  const block = {
    gameId: 9_006,
    queueId: 450,
    gameMode: 'ARAM',
    gameLength: 792,
    teams: [
      {
        teamId: 100,
        isWinningTeam: true,
        players: [
          {
            championId: 1,
            stats: { WIN: 1, gameEndedInEarlySurrender: 0, gameEndedInSurrender: 1 },
          },
        ],
      },
      {
        teamId: 200,
        isWinningTeam: false,
        players: [
          {
            championId: 2,
            stats: { WIN: 0, gameEndedInEarlySurrender: 0, gameEndedInSurrender: 1 },
          },
        ],
      },
    ],
  };
  const game = endOfGameToRawGame(block, [{ puuid: 'p1' }, { puuid: 'p2' }], 5_000_000);
  assert.ok(game, '结算数据应能转换成对局');
  assert.equal(
    game.participants?.[0]?.stats?.gameEndedInEarlySurrender,
    false,
    '普通投降字段不应写进 early surrender',
  );
  assert.equal(isRemakeGame(game), false, '13 分钟的投降局不应标记为重开');
});

test('early surrender 仍然识别为重开', () => {
  const block = {
    gameId: 9_007,
    queueId: 420,
    gameLength: 240,
    teams: [
      {
        teamId: 100,
        isWinningTeam: true,
        players: [
          { championId: 1, stats: { WIN: 1, gameEndedInEarlySurrender: 1 } },
        ],
      },
      {
        teamId: 200,
        isWinningTeam: false,
        players: [
          { championId: 2, stats: { WIN: 0, gameEndedInEarlySurrender: 1 } },
        ],
      },
    ],
  };
  const game = endOfGameToRawGame(block, [{ puuid: 'p1' }, { puuid: 'p2' }], 5_000_000);
  assert.ok(game, '结算数据应能转换成对局');
  assert.equal(isRemakeGame(game), true, 'early surrender 应标记为重开');
});

console.log('finished-game');
test('对局 ID 比上一局小也算刚结束的新对局', () => {
  const endedAt = 1_794_500_000_000;
  assert.equal(
    isNewFinishedGame(9_077_410_005, 9_077_419_546, endedAt - 700_000, endedAt),
    true,
  );
});

test('战绩列表还停在上一局时不算刚结束的对局', () => {
  const endedAt = 1_794_500_000_000;
  assert.equal(
    isNewFinishedGame(9_077_419_546, 9_077_419_546, endedAt - 1_500_000, endedAt),
    false,
  );
});

test('没记录到上一局时按对局时间判断新旧', () => {
  const endedAt = 1_794_500_000_000;
  assert.equal(isNewFinishedGame(9_077_410_005, 0, endedAt - 600_000, endedAt), true);
  assert.equal(
    isNewFinishedGame(9_077_000_000, 0, endedAt - 5 * 60 * 60_000, endedAt),
    false,
  );
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

test('近期摘要计算平均评分排名，至少 3 场同人数样本', () => {
  const games = [1, 3, 5].map((rank, index) => ({
    ...makeGame(index, 'MID'),
    rank,
    rankTotal: 10,
  }));
  const summary = summarize(games);
  assert.equal(summary.avgRank, 3);
  assert.equal(summary.avgRankGames, 3);

  const onlyTwo = summarize([
    { ...makeGame(1, 'MID'), rank: 1, rankTotal: 10 },
    { ...makeGame(2, 'MID'), rank: 3, rankTotal: 10 },
  ]);
  assert.equal(onlyTwo.avgRank, undefined, '不足 3 场时不显示平均排名');
  assert.equal(onlyTwo.avgRankGames, undefined);

  const noRank = summarize([makeGame(9, 'MID')]);
  assert.equal(noRank.avgRank, undefined);
  assert.equal(noRank.avgRankGames, undefined);

  const mixedTotals = summarize([
    { ...makeGame(10, 'MID'), rank: 1, rankTotal: 10 },
    { ...makeGame(11, 'MID'), rank: 3, rankTotal: 10 },
    { ...makeGame(12, 'MID'), rank: 5, rankTotal: 10 },
    // 旧存档只有 7 人有评分：第 2/7 不能和第 2/10 一起平均
    { ...makeGame(13, 'MID'), rank: 2, rankTotal: 7 },
  ]);
  assert.equal(mixedTotals.avgRank, 3);
  assert.equal(mixedTotals.avgRankGames, 3);
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

test('实时时间线按死亡/复活切分每条命', () => {
  const timeline = buildLiveTimeline(
    [
      { t: 0, cs: 0, level: 1, dead: false },
      { t: 60, cs: 10, level: 3, dead: false },
      { t: 120, cs: 20, level: 4, dead: true },
      { t: 140, cs: 22, level: 4, dead: false },
      { t: 200, cs: 40, level: 6, dead: false },
    ],
    [
      {
        EventName: 'ChampionKill',
        EventTime: 100,
        KillerName: '敌人',
        VictimName: '我#0001',
      },
      {
        EventName: 'ChampionKill',
        EventTime: 90,
        KillerName: '我#0001',
        VictimName: '敌人',
        Assisters: ['队友#0002'],
      },
    ],
    { riotId: '我#0001', isDead: false },
    200,
  );
  assert.equal(timeline.lives.length, 2, '一次阵亡 + 当前存活应切出两条命');
  assert.equal(timeline.lives[0].startMs, 0);
  assert.equal(timeline.lives[0].endMs, 100_000);
  assert.equal(timeline.lives[0].kills, 1);
  assert.equal(timeline.lives[0].deaths, 1);
  assert.equal(timeline.lives[0].death?.killerName, '敌人');
  assert.equal(timeline.lives[1].startMs, 140_000, '复活后应从第一次存活采样开始');
  assert.equal(timeline.lives[1].respawnMs, 40_000);
  assert.equal(timeline.lives[1].cs, 18);
  assert.equal(timeline.lives[1].level, 6);
  assert.equal(timeline.lives[1].deaths, 0);

  const deadTimeline = buildLiveTimeline(
    [
      { t: 0, cs: 0, level: 1, dead: false },
      { t: 60, cs: 10, level: 3, dead: false },
      { t: 100, cs: 20, level: 4, dead: true },
    ],
    [
      {
        EventName: 'ChampionKill',
        EventTime: 100,
        KillerName: '敌人',
        VictimName: '我#0001',
      },
    ],
    { riotId: '我#0001', isDead: true, respawnTimer: 8 },
    100,
  );
  assert.equal(deadTimeline.dead, true);
  assert.equal(deadTimeline.respawnTimer, 8);
  assert.equal(deadTimeline.lives.length, 1, '阵亡时不应再生成当前存活段');
});

console.log('match timeline');
test('对局时间线按阵亡切分每条命并计算补刀/金币增量', () => {
  const game: RawGame = {
    gameId: 42,
    gameDuration: 300,
    participants: [
      {
        participantId: 1,
        teamId: 100,
        championId: 103,
        stats: {
          kills: 2,
          deaths: 2,
          assists: 0,
          totalDamageDealtToChampions: 20_000,
          totalDamageTaken: 15_000,
        },
      },
      {
        participantId: 2,
        teamId: 200,
        championId: 64,
        stats: {
          kills: 2,
          deaths: 2,
          assists: 0,
          totalDamageDealtToChampions: 18_000,
          totalDamageTaken: 22_000,
        },
      },
      {
        participantId: 3,
        teamId: 200,
        championId: 99,
        stats: { kills: 0, deaths: 1, assists: 0 },
      },
    ],
    participantIdentities: [
      { participantId: 1, player: { puuid: 'self', gameName: '我', tagLine: '0001' } },
      { participantId: 2, player: { puuid: 'enemy', gameName: '对手', tagLine: '0002' } },
      { participantId: 3, player: { puuid: 'enemy2', gameName: '对手二', tagLine: '0003' } },
    ],
  };
  const frame = (timestamp: number, cs: number, gold: number, level: number) => ({
    timestamp,
    participantFrames: {
      '1': {
        participantId: 1,
        minionsKilled: cs,
        jungleMinionsKilled: 0,
        totalGold: gold,
        level,
      },
    },
  });
  const raw = {
    frames: [
      frame(60_000, 10, 1_000, 3),
      frame(120_000, 20, 2_000, 4),
      frame(180_000, 30, 3_000, 5),
      frame(240_000, 40, 4_000, 6),
      {
        ...frame(300_000, 50, 5_000, 7),
        events: [
          { type: 'CHAMPION_KILL', timestamp: 70_000, killerId: 1, victimId: 2 },
          {
            type: 'CHAMPION_KILL',
            timestamp: 150_000,
            killerId: 2,
            victimId: 1,
            assistingParticipantIds: [3],
          },
          { type: 'CHAMPION_KILL', timestamp: 200_000, killerId: 1, victimId: 2 },
          {
            type: 'CHAMPION_KILL',
            timestamp: 220_000,
            killerId: 2,
            victimId: 3,
            assistingParticipantIds: [1],
          },
          {
            type: 'CHAMPION_KILL',
            timestamp: 250_000,
            killerId: 2,
            victimId: 1,
            assistingParticipantIds: [3],
          },
          // 同一事件在不同帧重复出现时只算一次
          {
            type: 'CHAMPION_KILL',
            timestamp: 150_000,
            killerId: 2,
            victimId: 1,
            assistingParticipantIds: [3],
          },
        ],
      },
    ],
  };

  const timeline = parseMatchTimeline(
    game,
    raw,
    new Map([
      [103, '九尾妖狐'],
      [64, '盲僧'],
      [99, '拉克丝'],
    ]),
  );
  const self = timeline.players.find((player) => player.puuid === 'self');
  assert.ok(self, '应该解析出自我的时间线');
  assert.equal(self.championName, '九尾妖狐');
  assert.equal(timeline.durationMs, 300_000);
  assert.equal(self.lives.length, 3, '两次阵亡应切出三条命');
  assert.deepEqual(
    self.lives.map((life) => [life.startMs, life.endMs]),
    [
      [0, 150_000],
      [162_000, 250_000],
      [266_000, 300_000],
    ],
  );
  assert.equal(self.lives[0].cs, 25);
  assert.equal(self.lives[0].gold, 2_500);
  assert.equal(self.lives[0].kills, 1);
  assert.equal(self.lives[0].level, 4);
  assert.equal(self.lives[0].death?.killerName, '对手#0002');
  assert.equal(self.lives[1].respawnMs, 12_000);
  assert.equal(self.lives[1].cs, 15);
  assert.equal(self.lives[1].gold, 1_467);
  assert.equal(self.lives[1].level, 6);
  assert.equal(self.lives[2].respawnMs, 16_000);
  assert.equal(self.lives[2].aliveMs, 34_000);
  assert.equal(self.lives[2].death, undefined);
  assert.deepEqual(
    self.lives[0].events?.map((event) => [
      event.type,
      event.timestampMs,
      event.championName,
    ]),
    [['kill', 70_000, '盲僧']],
  );
  assert.deepEqual(
    self.lives[1].events?.map((event) => [
      event.type,
      event.timestampMs,
      event.championName,
    ]),
    [
      ['kill', 200_000, '盲僧'],
      ['assist', 220_000, '拉克丝'],
    ],
  );
  assert.equal(self.lives[1].events?.[1]?.killerChampionName, '盲僧');
  assert.deepEqual(self.lives[1].events?.[1]?.assistParticipantIds, [1]);
  assert.deepEqual(self.lives[1].events?.[1]?.assistChampionNames, ['九尾妖狐']);
  assert.equal(self.damage, 20_000);
  assert.equal(self.damageTaken, 15_000);
  assert.deepEqual(self.killedBy, [
    { championId: 64, championName: '盲僧', count: 2 },
  ]);
  assert.deepEqual(self.assistedBy, [
    { championId: 99, championName: '拉克丝', count: 2 },
  ]);
  assert.deepEqual(self.killedChampions, [
    { championId: 64, championName: '盲僧', count: 2 },
  ]);
  assert.deepEqual(self.assistedChampions, [
    { championId: 99, championName: '拉克丝', count: 1 },
  ]);
});

test('没有阵亡时只生成一条存活到结束的时间线', () => {
  const game: RawGame = {
    gameId: 43,
    gameDuration: 120,
    participants: [
      {
        participantId: 1,
        teamId: 100,
        championId: 103,
        stats: { kills: 0, deaths: 0, assists: 2 },
      },
    ],
    participantIdentities: [
      { participantId: 1, player: { puuid: 'self', gameName: '我', tagLine: '0001' } },
    ],
  };
  const timeline = parseMatchTimeline(game, {
    frames: [
      {
        timestamp: 60_000,
        participantFrames: {
          '1': { participantId: 1, minionsKilled: 5, totalGold: 500, level: 2 },
        },
      },
      {
        timestamp: 120_000,
        participantFrames: {
          '1': { participantId: 1, minionsKilled: 10, totalGold: 1_000, level: 3 },
        },
      },
    ],
  });
  const self = timeline.players[0];
  assert.ok(self);
  assert.equal(self.lives.length, 1);
  assert.equal(self.lives[0].startMs, 0);
  assert.equal(self.lives[0].endMs, 120_000);
  assert.equal(self.lives[0].cs, 10);
  assert.equal(self.lives[0].gold, 1_000);
  assert.equal(self.lives[0].death, undefined);
});

test('时间线只统计存活期间无补刀和战斗的时间', () => {
  const game: RawGame = {
    gameId: 44,
    gameDuration: 480,
    participants: [
      {
        participantId: 1,
        teamId: 100,
        championId: 103,
        stats: { kills: 0, deaths: 0, assists: 0 },
      },
      {
        participantId: 2,
        teamId: 100,
        championId: 64,
        stats: { kills: 0, deaths: 0, assists: 0 },
      },
    ],
    participantIdentities: [
      { participantId: 1, player: { puuid: 'idle', gameName: '挂机', tagLine: '0001' } },
      { participantId: 2, player: { puuid: 'active', gameName: '活跃', tagLine: '0002' } },
    ],
  };
  const frame = (timestamp: number, minute: number) => ({
    timestamp,
    participantFrames: {
      '1': {
        participantId: 1,
        minionsKilled: minute <= 6 ? 0 : (minute - 6) * 5,
        totalGold: minute <= 6 ? 500 : 500 + (minute - 6) * 300,
        level: minute <= 6 ? 1 : 2,
        position:
          minute <= 6 ? { x: 1000, y: 1000 } : { x: 4000, y: 4000 },
      },
      '2': {
        participantId: 2,
        minionsKilled: minute * 5,
        totalGold: minute * 300,
        level: 1 + Math.floor(minute / 2),
        position: { x: minute * 1000, y: minute * 1000 },
      },
    },
  });
  const timeline = parseMatchTimeline(game, {
    frames: Array.from({ length: 8 }, (_, index) =>
      frame((index + 1) * 60_000, index + 1),
    ),
  });

  const idle = timeline.players.find((player) => player.puuid === 'idle');
  assert.ok(idle);
  assert.equal(idle.maxIdleMs, 360_000, '前 6 分钟没有补刀和战斗应算作连续空闲');
  assert.equal(idle.idleAliveMs, 360_000);
  assert.equal(idle.maxStationaryMs, 300_000, '原地不动应单独统计为挂机时长');
  assert.equal(idle.stationaryAliveMs, 300_000);

  const active = timeline.players.find((player) => player.puuid === 'active');
  assert.ok(active);
  assert.equal(active.maxIdleMs, 0, '每分钟都有补刀时不应出现空闲');
  assert.equal(active.idleAliveMs, 0);
  assert.equal(active.maxStationaryMs, 0, '一直在移动时不应出现原地不动');
  assert.equal(active.stationaryAliveMs, 0);
});

test('时间线空闲统计不包含阵亡和复活等待', () => {
  const game: RawGame = {
    gameId: 45,
    gameDuration: 300,
    participants: [
      {
        participantId: 1,
        teamId: 100,
        championId: 103,
        stats: { kills: 0, deaths: 1, assists: 0 },
      },
      {
        participantId: 2,
        teamId: 200,
        championId: 64,
        stats: { kills: 1, deaths: 0, assists: 0 },
      },
    ],
    participantIdentities: [
      { participantId: 1, player: { puuid: 'idle-dead', gameName: '挂机', tagLine: '0001' } },
      { participantId: 2, player: { puuid: 'killer', gameName: '击杀者', tagLine: '0002' } },
    ],
  };
  const frame = (timestamp: number) => ({
    timestamp,
    participantFrames: {
      '1': {
        participantId: 1,
        minionsKilled: 0,
        jungleMinionsKilled: 0,
        totalGold: 500 + timestamp / 1000,
        level: 1,
        position: { x: 1000, y: 1000 },
      },
      '2': {
        participantId: 2,
        minionsKilled: 0,
        jungleMinionsKilled: 0,
        totalGold: 500,
        level: 1,
        position: { x: 5000, y: 5000 },
      },
    },
  });
  const timeline = parseMatchTimeline(game, {
    frames: [
      {
        ...frame(60_000),
        events: [
          { type: 'CHAMPION_KILL', timestamp: 60_000, killerId: 2, victimId: 1 },
        ],
      },
      frame(120_000),
      frame(180_000),
      frame(240_000),
      frame(300_000),
    ],
  });

  const self = timeline.players.find((player) => player.puuid === 'idle-dead');
  assert.ok(self);
  assert.equal(self.lives.length, 2, '阵亡后应切出第二条命');
  assert.equal(self.lives[1]?.startMs, 70_000, '1 级复活等待 10 秒');
  assert.equal(
    self.maxIdleMs,
    230_000,
    '只统计 70-300 秒的存活时间，60-70 秒的阵亡等待不应计入',
  );
  assert.equal(self.idleAliveMs, 230_000);
  assert.equal(self.maxStationaryMs, 230_000);
  assert.equal(self.lives[0]?.death?.killerName, '击杀者#0002');
});

test('时间线支持毫秒格式的 gameDuration', () => {
  const game: RawGame = {
    gameId: 46,
    gameDuration: 300_000,
    participants: [
      {
        participantId: 1,
        teamId: 100,
        championId: 103,
        stats: { kills: 0, deaths: 0, assists: 0 },
      },
    ],
    participantIdentities: [
      { participantId: 1, player: { puuid: 'ms-duration', gameName: '毫秒', tagLine: '0001' } },
    ],
  };
  const timeline = parseMatchTimeline(game, {
    frames: [
      {
        timestamp: 60_000,
        participantFrames: {
          '1': { participantId: 1, minionsKilled: 5, totalGold: 500, level: 2 },
        },
      },
      {
        timestamp: 300_000,
        participantFrames: {
          '1': { participantId: 1, minionsKilled: 25, totalGold: 5_000, level: 9 },
        },
      },
    ],
  });
  assert.equal(timeline.durationMs, 300_000, '300000 应视为毫秒，而不是再乘 1000');
  assert.equal(timeline.players[0]?.lives[0]?.endMs, 300_000);
});

test('击杀事件也会重置空闲和原地不动计时', () => {
  const game: RawGame = {
    gameId: 47,
    gameDuration: 240,
    participants: [
      {
        participantId: 1,
        teamId: 100,
        championId: 103,
        stats: { kills: 1, deaths: 0, assists: 0 },
      },
      {
        participantId: 2,
        teamId: 200,
        championId: 64,
        stats: { kills: 0, deaths: 1, assists: 0 },
      },
    ],
    participantIdentities: [
      { participantId: 1, player: { puuid: 'fighter', gameName: '参战者', tagLine: '0001' } },
      { participantId: 2, player: { puuid: 'victim', gameName: '被击杀', tagLine: '0002' } },
    ],
  };
  const frame = (timestamp: number) => ({
    timestamp,
    participantFrames: {
      '1': {
        participantId: 1,
        minionsKilled: 0,
        jungleMinionsKilled: 0,
        totalGold: 500,
        level: 1,
        position: { x: 1000, y: 1000 },
      },
      '2': {
        participantId: 2,
        minionsKilled: 0,
        jungleMinionsKilled: 0,
        totalGold: 500,
        level: 1,
        position: { x: 5000, y: 5000 },
      },
    },
  });
  const timeline = parseMatchTimeline(game, {
    frames: [
      {
        ...frame(60_000),
        events: [
          { type: 'CHAMPION_KILL', timestamp: 120_000, killerId: 1, victimId: 2 },
        ],
      },
      frame(120_000),
      frame(180_000),
      frame(240_000),
    ],
  });

  const self = timeline.players.find((player) => player.puuid === 'fighter');
  assert.ok(self);
  assert.equal(self.idleAliveMs, 120_000, '击杀前后两段各算一次空闲');
  assert.equal(self.maxIdleMs, 60_000, '击杀应把连续空闲打断');
  assert.equal(self.maxStationaryMs, 60_000, '击杀也应重置原地不动计时');
});

test('时间线汇总双方经济/经验曲线和推塔事件', () => {
  const game: RawGame = {
    gameId: 48,
    gameDuration: 120,
    participants: [
      { participantId: 1, teamId: 100, championId: 103, stats: { kills: 0, deaths: 0, assists: 0 } },
      { participantId: 2, teamId: 100, championId: 64, stats: { kills: 0, deaths: 0, assists: 0 } },
      { participantId: 3, teamId: 200, championId: 99, stats: { kills: 0, deaths: 0, assists: 0 } },
      { participantId: 4, teamId: 200, championId: 1, stats: { kills: 0, deaths: 0, assists: 0 } },
    ],
    participantIdentities: [
      { participantId: 1, player: { puuid: 'a', gameName: 'A', tagLine: '0001' } },
      { participantId: 2, player: { puuid: 'b', gameName: 'B', tagLine: '0002' } },
      { participantId: 3, player: { puuid: 'c', gameName: 'C', tagLine: '0003' } },
      { participantId: 4, player: { puuid: 'd', gameName: 'D', tagLine: '0004' } },
    ],
  };
  const frame = (
    timestamp: number,
    golds: [number, number, number, number],
    xps: [number, number, number, number],
  ) => ({
    timestamp,
    participantFrames: {
      '1': { participantId: 1, totalGold: golds[0], xp: xps[0] },
      '2': { participantId: 2, totalGold: golds[1], xp: xps[1] },
      '3': { participantId: 3, totalGold: golds[2], xp: xps[2] },
      '4': { participantId: 4, totalGold: golds[3], xp: xps[3] },
    },
  });
  const building = {
    type: 'BUILDING_KILL',
    timestamp: 90_000,
    teamId: 100,
    buildingType: 'TOWER_BUILDING',
    laneType: 'MID_LANE',
    towerType: 'OUTER_TURRET',
    position: { x: 5000, y: 5000 },
  };
  const timeline = parseMatchTimeline(game, {
    frames: [
      { ...frame(60_000, [1000, 500, 800, 400], [100, 50, 80, 40]), events: [building] },
      // 同一事件在相邻帧重复出现时只保留一次
      { ...frame(120_000, [2500, 1000, 1800, 900], [250, 100, 180, 90]), events: [building] },
    ],
  });

  assert.equal(timeline.series?.length, 2);
  assert.deepEqual(timeline.series?.[0], {
    timestampMs: 60_000,
    teams: [
      { teamId: 100, gold: 1500, xp: 150 },
      { teamId: 200, gold: 1200, xp: 120 },
    ],
  });
  assert.deepEqual(timeline.series?.[1], {
    timestampMs: 120_000,
    teams: [
      { teamId: 100, gold: 3500, xp: 350 },
      { teamId: 200, gold: 2700, xp: 270 },
    ],
  });
  assert.equal(timeline.buildings?.length, 1);
  assert.deepEqual(timeline.buildings?.[0], {
    timestampMs: 90_000,
    teamId: 100,
    buildingType: 'TOWER_BUILDING',
    laneType: 'MID_LANE',
    towerType: 'OUTER_TURRET',
    position: { x: 5000, y: 5000 },
  });
});

test('复活等待按等级估算，并随游戏时间放大', () => {
  assert.equal(estimateRespawnMs(1, 60_000), 10_000);
  assert.equal(estimateRespawnMs(4, 150_000), 12_000);
  assert.ok(
    estimateRespawnMs(13, 1_800_000) > estimateRespawnMs(13, 600_000),
    '30 分钟后的复活等待应更长',
  );
});

console.log(`\n${passed} 项测试全部通过`);
