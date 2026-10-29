import type { AnalyzedGame, PlayerReport, RankInfo, Snapshot } from './types.js';
import type { AssetResult, DataSource } from './source.js';
import { gameTags, performanceScore, summarize } from './stats/rating.js';
import { nowIso, round } from './util.js';

/* ---------------------------- 模拟数据 ---------------------------- */

interface ChampionRef {
  id: number;
  name: string;
}

type DemoPosition = 'top' | 'jungle' | 'middle' | 'bottom' | 'utility';

const CHAMPIONS: Record<DemoPosition, ChampionRef[]> = {
  top: [
    { id: 122, name: '诺克萨斯之手' },
    { id: 39, name: '刀锋舞者' },
    { id: 164, name: '青钢影' },
    { id: 266, name: '暗裔剑魔' },
    { id: 86, name: '德玛西亚之力' },
  ],
  jungle: [
    { id: 64, name: '盲僧' },
    { id: 121, name: '虚空掠夺者' },
    { id: 60, name: '蜘蛛女皇' },
    { id: 141, name: '影流之镰' },
    { id: 254, name: '蔚' },
  ],
  middle: [
    { id: 103, name: '九尾妖狐' },
    { id: 157, name: '疾风剑豪' },
    { id: 238, name: '影流之主' },
    { id: 134, name: '暗黑元首' },
    { id: 61, name: '发条魔灵' },
  ],
  bottom: [
    { id: 222, name: '暴走萝莉' },
    { id: 202, name: '戏命师' },
    { id: 145, name: '虚空之女' },
    { id: 81, name: '探险家' },
    { id: 51, name: '皮城女警' },
  ],
  utility: [
    { id: 412, name: '魂锁典狱长' },
    { id: 111, name: '深海泰坦' },
    { id: 89, name: '曙光女神' },
    { id: 117, name: '仙灵女巫' },
    { id: 555, name: '血港鬼影' },
  ],
};

interface DemoPlayer {
  name: string;
  tagLine: string;
  position: DemoPosition;
  level: number;
  /** 数据倾向：>1 表示更强 */
  kda: number;
  damage: number;
  kp: number;
  cs: number;
  vision: number;
  deaths: number;
  winRate: number;
  rank: RankInfo | null;
}

const DEMO_PLAYERS: DemoPlayer[] = [
  {
    name: '青钢影绝活哥',
    tagLine: 'TOP1',
    position: 'top',
    level: 486,
    kda: 1.25,
    damage: 1.2,
    kp: 1.05,
    cs: 1.1,
    vision: 1.0,
    deaths: 0.85,
    winRate: 0.7,
    rank: { queue: 'RANKED_SOLO_5x5', tier: 'DIAMOND', division: 'II', leaguePoints: 64, wins: 128, losses: 96 },
  },
  {
    name: '野区养爹人',
    tagLine: 'JG',
    position: 'jungle',
    level: 312,
    kda: 1.05,
    damage: 1.0,
    kp: 1.15,
    cs: 1.0,
    vision: 1.1,
    deaths: 1.0,
    winRate: 0.55,
    rank: { queue: 'RANKED_SOLO_5x5', tier: 'EMERALD', division: 'I', leaguePoints: 12, wins: 74, losses: 68 },
  },
  {
    name: 'Faker的小粉丝',
    tagLine: 'MID',
    position: 'middle',
    level: 733,
    kda: 1.1,
    damage: 1.15,
    kp: 1.0,
    cs: 1.05,
    vision: 0.95,
    deaths: 1.0,
    winRate: 0.5,
    rank: { queue: 'RANKED_SOLO_5x5', tier: 'PLATINUM', division: 'III', leaguePoints: 40, wins: 61, losses: 60 },
  },
  {
    name: '刚满级的新手',
    tagLine: 'NEW',
    position: 'bottom',
    level: 28,
    kda: 0.45,
    damage: 0.12,
    kp: 0.75,
    cs: 0.55,
    vision: 0.45,
    deaths: 1.9,
    winRate: 0.3,
    rank: null,
  },
  {
    name: '钩子准得离谱',
    tagLine: 'SUP',
    position: 'utility',
    level: 356,
    kda: 1.15,
    damage: 0.9,
    kp: 1.2,
    cs: 0.8,
    vision: 1.35,
    deaths: 0.9,
    winRate: 0.6,
    rank: { queue: 'RANKED_SOLO_5x5', tier: 'MASTER', division: '', leaguePoints: 214, wins: 89, losses: 70 },
  },
];

const ROLE_BASE = {
  top: { cs: 5.8, vision: 0.95, tank: 0.28 },
  jungle: { cs: 4.8, vision: 1.05, tank: 0.2 },
  middle: { cs: 6.2, vision: 0.85, tank: 0.16 },
  bottom: { cs: 7.0, vision: 0.7, tank: 0.13 },
  utility: { cs: 1.3, vision: 1.7, tank: 0.17 },
} as const;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateGames(player: DemoPlayer, seed: number): AnalyzedGame[] {
  const random = mulberry32(seed);
  const base = ROLE_BASE[player.position];
  const champions = CHAMPIONS[player.position] ?? [];
  const games: AnalyzedGame[] = [];
  const now = Date.now();

  for (let index = 0; index < 10; index += 1) {
    const durationMin = 24 + Math.floor(random() * 14);
    const teamKills = 16 + Math.floor(random() * 18);
    const participation = Math.min(0.85, (0.42 + random() * 0.22) * player.kp);
    const involvement = Math.max(3, Math.round(teamKills * participation));
    const kills = Math.max(0, Math.round(involvement * (0.3 + random() * 0.15)));
    const assists = Math.max(0, involvement - kills);
    const deaths = Math.max(0, Math.round((3 + random() * 4) * player.deaths));
    const kda = (kills + assists) / Math.max(1, deaths);
    const damageShare = Math.min(0.45, Math.max(0.05, 0.2 * player.damage + random() * 0.1));
    const tankShare = Math.min(0.42, Math.max(0.08, base.tank + (random() - 0.5) * 0.08));
    const csPerMin = Math.max(0.8, base.cs * player.cs * (0.85 + random() * 0.3));
    const visionPerMin = Math.max(0.2, base.vision * player.vision * (0.8 + random() * 0.4));
    const win = random() < player.winRate;
    const champion = champions[Math.floor(random() * champions.length)] ?? champions[0]!;
    const cs = Math.round(csPerMin * durationMin);
    const damage = Math.round(damageShare * 100_000);
    const damagePerMin = damage / durationMin;
    const lane =
      player.position === 'utility'
        ? 'SUPPORT'
        : player.position === 'bottom'
          ? 'ADC'
          : player.position === 'middle'
            ? 'MID'
            : player.position === 'jungle'
              ? 'JUNGLE'
              : 'TOP';
    const score = performanceScore(
      {
        kda,
        damageShare,
        damagePerMin,
        tankShare,
        killParticipation: participation,
        csPerMin,
        visionPerMin,
        win,
      },
      lane,
    );

    games.push({
      gameId: Math.round(now / 1000) - index * 1800,
      queueId: index % 4 === 3 ? 440 : 420,
      queueName: index % 4 === 3 ? '灵活排位' : '单双排',
      gameCreation: now - index * 3_600_000 - Math.floor(random() * 900_000),
      durationMin,
      championId: champion.id,
      championName: champion.name,
      win,
      kills,
      deaths,
      assists,
      kda: round(kda, 2),
      cs,
      csPerMin: round(csPerMin, 1),
      gold: Math.round(300 + durationMin * (320 + random() * 120)),
      damage,
      damageShare: round(damageShare, 3),
      damagePerMin: Math.round(damagePerMin),
      tankShare: round(tankShare, 3),
      killParticipation: round(participation, 3),
      visionScore: Math.round(visionPerMin * durationMin),
      visionPerMin: round(visionPerMin, 2),
      position: lane,
      score,
      tags: gameTags({
        win,
        score,
        kills,
        deaths,
        assists,
        kda,
        damageShare,
        damagePerMin,
        tankShare,
        killParticipation: participation,
        csPerMin,
        durationMin,
        position: lane,
      }),
    });
  }

  return games;
}

function buildReports(seed: number): PlayerReport[] {
  return DEMO_PLAYERS.map((player, index) => {
    const games = generateGames(player, seed + index * 7919);
    const summary = summarize(games, { level: player.level });
    const champion = CHAMPIONS[player.position]?.[0];
    return {
      summonerId: 1000 + index,
      puuid: `demo-${index}`,
      displayName: player.name,
      tagLine: player.tagLine,
      level: player.level,
      position: player.position,
      championId: champion?.id,
      championName: champion?.name,
      rank: player.rank,
      recent: summary,
      games: games.slice(0, 10),
      rating: summary.rating,
      grade: summary.grade,
      labels: summary.labels,
      loading: false,
    } satisfies PlayerReport;
  });
}

export class DemoSource implements DataSource {
  readonly mode = 'demo' as const;
  private snapshot: Snapshot;
  private readonly listeners = new Set<(snapshot: Snapshot) => void>();
  private timer?: NodeJS.Timeout;

  constructor() {
    this.snapshot = this.buildSnapshot(Date.now());
    this.timer = setInterval(() => this.regenerate(), 20_000);
    this.timer.unref?.();
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    this.regenerate();
  }

  clearCache(): void {
    // 演示模式没有真实缓存
  }

  async getAsset(): Promise<AssetResult | null> {
    return null;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private regenerate(): void {
    this.snapshot = this.buildSnapshot(Date.now());
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private buildSnapshot(seed: number): Snapshot {
    const players = buildReports(seed);
    const local = players[0];
    return {
      mode: 'demo',
      phase: 'ChampSelect',
      inChampSelect: true,
      collecting: false,
      updatedAt: nowIso(),
      message: '这是演示数据：运行 `npm run once` 或直接启动即可读取真实客户端数据',
      localPlayer: local
        ? {
            summonerId: local.summonerId,
            displayName: local.displayName,
            cellId: 0,
            championId: local.championId ?? 0,
            championName: local.championName,
          }
        : undefined,
      players,
    };
  }
}
