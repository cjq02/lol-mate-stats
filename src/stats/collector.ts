import type {
  AnalyzedGame,
  ChampSelectMember,
  ChampSelectSession,
  GameContext,
  LiveGamePlayer,
  LiveMember,
  LiveStats,
  PlayerReport,
  RankInfo,
  RawGame,
  SummonerInfo,
} from '../types.js';
import { mapLimit, round, toNumber, truncate } from '../util.js';
import type { ChampionSummary, LcuApi } from '../lcu/api.js';
import { analyzeGame } from './analyze.js';
import { currentQueueGroup, gameQueueGroup, queueGroupName } from './constants.js';
import { summarize } from './rating.js';

export interface CollectorOptions {
  /** 拉取最近多少场对局，默认 10 */
  recent: number;
  /** 报告缓存时长，默认 5 分钟 */
  ttlMs: number;
  /** 对局详情缓存时长，默认 30 分钟 */
  gameTtlMs: number;
  /** 单个玩家的拉取并发 */
  concurrency: number;
}

const DEFAULT_OPTIONS: CollectorOptions = {
  recent: 10,
  ttlMs: 5 * 60_000,
  gameTtlMs: 30 * 60_000,
  concurrency: 3,
};

interface CachedReport {
  at: number;
  report: PlayerReport;
}

/**
 * 根据选人阶段成员，读取召唤师信息 + 最近战绩 + 段位，产出评分报告。
 * 所有数据都来自本地客户端的 LCU 接口，不需要 Riot API Key。
 */
export class ReportCollector {
  private readonly options: CollectorOptions;
  private readonly summonerCache = new Map<number, { at: number; info: SummonerInfo | null }>();
  private readonly summonerByNameCache = new Map<
    string,
    { at: number; info: SummonerInfo | null }
  >();
  private readonly reportCache = new Map<string, CachedReport>();
  private readonly gameCache = new Map<number, { at: number; game: RawGame | null }>();
  private readonly rankCache = new Map<string, { at: number; rank: RankInfo | null }>();
  private championMap: Map<number, ChampionSummary> | null = null;
  private championMapAt = 0;

  constructor(
    private readonly api: LcuApi,
    options: Partial<CollectorOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  clearCache(): void {
    this.reportCache.clear();
    this.summonerCache.clear();
    this.summonerByNameCache.clear();
    this.rankCache.clear();
  }

  championName(championId: number | undefined): string | undefined {
    if (!championId) return undefined;
    return this.championMap?.get(championId)?.name;
  }

  /** 用 Live Client Data 的英雄名反查 championId（图标用） */
  championIdFor(rawChampionName?: string, championName?: string): number | undefined {
    const map = this.championMap;
    if (!map) return undefined;
    const alias = rawChampionName?.split('_').pop()?.toLowerCase();
    if (alias) {
      for (const [id, champion] of map) {
        if (champion.alias.toLowerCase() === alias) return id;
      }
    }
    if (championName) {
      for (const [id, champion] of map) {
        if (champion.name === championName) return id;
      }
    }
    return undefined;
  }

  async collect(
    session: ChampSelectSession,
    onProgress?: (players: PlayerReport[]) => void,
    context?: GameContext,
  ): Promise<PlayerReport[]> {
    const members = [...(session.myTeam ?? [])].sort((a, b) => a.cellId - b.cellId);
    if (!members.length) return [];

    const championMap = await this.getChampionMap();

    // 第一步：先把名字等基础信息填上，界面可以立即显示占位卡片
    const bases = await mapLimit(members, 5, async (member) => {
      const info = await this.getSummoner(member.summonerId);
      return this.buildBaseReport(member, info, championMap, context);
    });
    onProgress?.(bases);

    // 第二步：并发拉取战绩；每完成一个就推送一次，避免长时间空白
    const reports = [...bases];
    await mapLimit(members, this.options.concurrency, async (member, index) => {
      const base = bases[index] as PlayerReport;
      const report = await this.buildFullReport(member, base, championMap, context);
      reports[index] = report;
      onProgress?.([...reports]);
    });

    return reports;
  }

  /**
   * 游戏进行中：用 Live Client Data 的玩家列表构建报告。
   * 召唤师信息通过名字查询 LCU，战绩接口仍然可用。
   */
  async collectLive(
    players: LiveMember[],
    onProgress?: (players: PlayerReport[]) => void,
    context?: GameContext,
  ): Promise<PlayerReport[]> {
    if (!players.length) return [];

    const championMap = await this.getChampionMap();
    const bases = await mapLimit(players, 5, async (player) => {
      const info = await this.getSummonerByName(liveName(player));
      return this.buildLiveBase(player, info, championMap, context);
    });
    onProgress?.(bases);

    const reports = [...bases];
    await mapLimit(players, this.options.concurrency, async (player, index) => {
      const base = bases[index] as PlayerReport;
      const report = await this.buildLiveFullReport(player, base, championMap, context);
      reports[index] = report;
      onProgress?.([...reports]);
    });

    return reports;
  }

  private async buildLiveFullReport(
    player: LiveMember,
    base: PlayerReport,
    championMap: Map<number, ChampionSummary>,
    context?: GameContext,
  ): Promise<PlayerReport> {
    if (player.isBot) return { ...base, loading: false, rating: null };
    if (!base.summonerId || !base.puuid) return { ...base, loading: false };

    const cacheKey = reportCacheKey(base.summonerId, context);
    const cached = this.reportCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.options.ttlMs) {
      return this.withLiveData(cached.report, base);
    }

    const summoner: SummonerInfo = {
      summonerId: base.summonerId,
      puuid: base.puuid,
      accountId: base.accountId,
      gameName: base.displayName,
      tagLine: base.tagLine,
      summonerLevel: base.level,
    };

    try {
      const [rank, games] = await Promise.all([
        this.getRank(base.puuid),
        this.loadRecentGames(summoner, context),
      ]);

      const analyzed = games
        .map((game) =>
          analyzeGame(
            game,
            { puuid: summoner.puuid, summonerId: summoner.summonerId, accountId: summoner.accountId },
            championMap,
          ),
        )
        .filter((game): game is NonNullable<typeof game> => game !== null)
        .sort((a, b) => b.gameCreation - a.gameCreation);
      const filtered = filterByContext(analyzed, context);

      if (!filtered.length) {
        const label = contextLabel(context);
        const report: PlayerReport = {
          ...base,
          rank,
          recent: undefined,
          games: [],
          rating: null,
          labels: [],
          loading: false,
          error: analyzed.length
            ? `最近 ${games.length} 场没有${label}记录`
            : '近期的对局无法解析（可能隐藏了战绩）',
        };
        this.reportCache.set(cacheKey, { at: Date.now(), report });
        return report;
      }

      const summary = summarize(filtered.slice(0, this.options.recent), { level: base.level });
      const report: PlayerReport = {
        ...base,
        rank,
        recent: summary,
        games: filtered.slice(0, this.options.recent),
        rating: summary.rating,
        grade: summary.grade,
        labels: summary.labels,
        loading: false,
        error: undefined,
      };
      this.reportCache.set(cacheKey, { at: Date.now(), report });
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        loading: false,
        rating: null,
        labels: [],
        error: `读取战绩失败：${truncate(message, 120)}`,
      };
    }
  }

  private buildLiveBase(
    player: LiveMember,
    info: SummonerInfo | null,
    championMap: Map<number, ChampionSummary>,
    context?: GameContext,
  ): PlayerReport {
    const championId = this.championIdFor(player.rawChampionName, player.championName);
    const name = liveName(player);
    const displayName =
      info?.gameName ||
      info?.displayName ||
      player.riotIdGameName ||
      stripTag(name) ||
      '未知召唤师';
    const position =
      player.position && player.position.toUpperCase() !== 'NONE'
        ? player.position.toLowerCase()
        : undefined;
    const cached = info
      ? this.reportCache.get(reportCacheKey(info.summonerId, context))?.report
      : undefined;

    const base: PlayerReport = {
      summonerId: info?.summonerId ?? 0,
      puuid: info?.puuid,
      accountId: info?.accountId,
      displayName,
      tagLine: info?.tagLine || player.riotIdTagLine,
      level: info?.summonerLevel,
      profileIconId: info?.profileIconId,
      position,
      championId,
      championName: player.championName ?? championMap.get(championId ?? 0)?.name,
      rating: cached?.rating ?? null,
      grade: cached?.grade,
      labels: player.isBot ? ['人机'] : (cached?.labels ?? []),
      recent: cached?.recent,
      games: cached?.games,
      rank: cached?.rank,
      isBot: Boolean(player.isBot),
      isEnemy: Boolean(player.isEnemy),
      live: liveStats(player),
      loading: !player.isBot && !cached,
    };

    if (!info && !player.isBot) base.error = '无法读取召唤师信息';
    return base;
  }

  /** 复用缓存时只覆盖本局会变化的部分（英雄、实时数据） */
  private withLiveData(report: PlayerReport, base: PlayerReport): PlayerReport {
    return {
      ...report,
      summonerId: base.summonerId,
      puuid: base.puuid,
      displayName: base.displayName,
      tagLine: base.tagLine,
      level: base.level,
      profileIconId: base.profileIconId,
      position: base.position ?? report.position,
      championId: base.championId,
      championName: base.championName,
      isBot: base.isBot,
      isEnemy: base.isEnemy,
      live: base.live,
      loading: false,
    };
  }

  private async buildFullReport(
    member: ChampSelectMember,
    base: PlayerReport,
    championMap: Map<number, ChampionSummary>,
    context?: GameContext,
  ): Promise<PlayerReport> {
    const cacheKey = reportCacheKey(member.summonerId, context);
    const cached = this.reportCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.options.ttlMs) {
      return this.withSessionData(cached.report, member, base, championMap);
    }

    if (!base.summonerId || base.error) return base;

    const summoner = await this.getSummoner(member.summonerId);
    if (!summoner) {
      return { ...base, error: '无法读取召唤师信息', rating: null };
    }

    try {
      const [rank, games] = await Promise.all([
        summoner.puuid ? this.getRank(summoner.puuid) : Promise.resolve(null),
        this.loadRecentGames(summoner, context),
      ]);

      const analyzed = games
        .map((game) =>
          analyzeGame(
            game,
            {
              puuid: summoner.puuid,
              summonerId: summoner.summonerId,
              accountId: summoner.accountId,
            },
            championMap,
          ),
        )
        .filter((game): game is NonNullable<typeof game> => game !== null)
        .sort((a, b) => b.gameCreation - a.gameCreation);
      const filtered = filterByContext(analyzed, context);

      if (!filtered.length) {
        const label = contextLabel(context);
        const report: PlayerReport = {
          ...base,
          rank,
          recent: undefined,
          games: [],
          rating: null,
          labels: [],
          error: analyzed.length
            ? `最近 ${games.length} 场没有${label}记录`
            : '近期的对局无法解析（可能隐藏了战绩）',
        };
        this.reportCache.set(cacheKey, { at: Date.now(), report });
        return report;
      }

      const summary = summarize(filtered.slice(0, this.options.recent), {
        level: summoner.summonerLevel,
      });
      const report: PlayerReport = {
        ...base,
        rank,
        recent: summary,
        games: filtered.slice(0, this.options.recent),
        rating: summary.rating,
        grade: summary.grade,
        labels: summary.labels,
        error: undefined,
      };
      this.reportCache.set(cacheKey, { at: Date.now(), report });
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        rating: null,
        labels: [],
        error: `读取战绩失败：${truncate(message, 120)}`,
      };
    }
  }

  /** 复用缓存时，用当前选人阶段的信息（位置/英雄）覆盖旧值 */
  private withSessionData(
    report: PlayerReport,
    member: ChampSelectMember,
    base: PlayerReport,
    championMap: Map<number, ChampionSummary>,
  ): PlayerReport {
    const championId = effectiveChampionId(member);
    return {
      ...report,
      position: base.position,
      championId: championId || undefined,
      championName: championMap.get(championId)?.name,
      loading: false,
      error: report.error,
    };
  }

  private buildBaseReport(
    member: ChampSelectMember,
    info: SummonerInfo | null,
    championMap: Map<number, ChampionSummary>,
    context?: GameContext,
  ): PlayerReport {
    const championId = effectiveChampionId(member);
    const cached = this.reportCache.get(reportCacheKey(member.summonerId, context))?.report;
    const displayName =
      info?.displayName ??
      (info?.gameName
        ? `${info.gameName}${info.tagLine ? `#${info.tagLine}` : ''}`
        : `召唤师 ${member.summonerId}`);

    const base: PlayerReport = {
      summonerId: member.summonerId,
      puuid: info?.puuid ?? member.puuid,
      accountId: info?.accountId,
      displayName,
      tagLine: info?.tagLine,
      level: info?.summonerLevel,
      profileIconId: info?.profileIconId,
      position: member.assignedPosition,
      championId: championId || undefined,
      championName: championMap.get(championId)?.name,
      rating: cached?.rating ?? null,
      grade: cached?.grade,
      labels: cached?.labels ?? [],
      recent: cached?.recent,
      games: cached?.games,
      rank: cached?.rank,
      loading: true,
    };

    if (!info) {
      base.error = '无法读取召唤师信息';
      base.loading = false;
    }
    return base;
  }

  private async getSummoner(summonerId: number): Promise<SummonerInfo | null> {
    const cached = this.summonerCache.get(summonerId);
    if (cached && Date.now() - cached.at < 30 * 60_000) return cached.info;

    let info: SummonerInfo | null = null;
    try {
      info = await this.api.getSummonerById(summonerId);
    } catch {
      info = null;
    }
    this.summonerCache.set(summonerId, { at: Date.now(), info });
    return info;
  }

  /** 游戏内只有 Riot ID，通过名字查询召唤师信息（含 puuid） */
  private async getSummonerByName(name: string): Promise<SummonerInfo | null> {
    if (!name) return null;
    const cached = this.summonerByNameCache.get(name);
    if (cached && Date.now() - cached.at < 30 * 60_000) return cached.info;

    let info: SummonerInfo | null = null;
    try {
      info = await this.api.getSummonerByName(name);
    } catch {
      info = null;
    }
    this.summonerByNameCache.set(name, { at: Date.now(), info });
    return info;
  }

  private async getRank(puuid: string): Promise<RankInfo | null> {
    const cached = this.rankCache.get(puuid);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.rank;
    const rank = await this.api.getRankedStats(puuid);
    this.rankCache.set(puuid, { at: Date.now(), rank });
    return rank;
  }

  private async loadRecentGames(
    summoner: SummonerInfo,
    context?: GameContext,
  ): Promise<RawGame[]> {
    // 需要按当前模式过滤时，多取一些候选场次，避免只剩两三场
    const count = context
      ? Math.min(30, Math.max(this.options.recent * 3, this.options.recent))
      : this.options.recent;
    let games: RawGame[] = [];
    let lastError: unknown = null;

    if (summoner.puuid) {
      try {
        games = await this.api.getMatchListByPuuid(summoner.puuid, count);
      } catch (error) {
        lastError = error;
      }
    }

    if (!games.length && summoner.accountId) {
      try {
        games = await this.api.getMatchListByAccount(summoner.accountId, count);
      } catch (error) {
        lastError = error;
      }
    }

    if (!games.length) {
      if (lastError) throw lastError;
      throw new Error('没有读取到对局记录（可能隐藏了战绩，或为新号）');
    }

    games = games.slice(0, count);

    // v3 matchlist 只给概要，需要再拉详情；v1 product 一般已包含详情
    const detailed = await mapLimit(games, 4, async (game) => {
      if (hasGameDetail(game)) return game;
      const gameId = toNumber(game.gameId);
      if (!gameId) return null;
      return this.getGameDetail(gameId);
    });

    return detailed.filter((game): game is RawGame => game !== null);
  }

  private async getGameDetail(gameId: number): Promise<RawGame | null> {
    const cached = this.gameCache.get(gameId);
    if (cached && Date.now() - cached.at < this.options.gameTtlMs) return cached.game;

    let game: RawGame | null = null;
    try {
      game = await this.api.getGame(gameId);
    } catch {
      game = null;
    }
    this.gameCache.set(gameId, { at: Date.now(), game });
    if (this.gameCache.size > 400) {
      const oldest = [...this.gameCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.gameCache.delete(oldest[0]);
    }
    return game;
  }

  private async getChampionMap(): Promise<Map<number, ChampionSummary>> {
    if (this.championMap && Date.now() - this.championMapAt < 60 * 60_000) {
      return this.championMap;
    }
    try {
      this.championMap = await this.api.getChampionMap();
      this.championMapAt = Date.now();
    } catch {
      this.championMap ??= new Map();
    }
    return this.championMap;
  }
}

function effectiveChampionId(member: ChampSelectMember): number {
  return member.championId || member.championPickIntent || 0;
}

function reportCacheKey(summonerId: number, context?: GameContext): string {
  const group = context ? currentQueueGroup(context.queueId, context.mode) : 'all';
  return `${summonerId}:${group}`;
}

function contextLabel(context?: GameContext): string {
  if (!context) return '近期对局';
  return queueGroupName(currentQueueGroup(context.queueId, context.mode), context.queueId);
}

/** 只保留当前队列/模式的历史对局 */
function filterByContext(games: AnalyzedGame[], context?: GameContext): AnalyzedGame[] {
  if (!context || (context.queueId === undefined && !context.mode)) return games;
  const group = currentQueueGroup(context.queueId, context.mode);
  return games.filter((game) => gameQueueGroup(game.queueId, game.position) === group);
}

function hasGameDetail(game: RawGame): boolean {
  const participants = game.participants;
  const identities = game.participantIdentities;
  // 战绩列表接口只返回“当前玩家”的概况（1 人），不能用来算伤害占比/参团
  if (!Array.isArray(participants) || participants.length < 2) return false;
  if (!Array.isArray(identities) || identities.length < 2) return false;
  return participants.some((participant) => participant.stats && 'kills' in participant.stats);
}

function liveName(player: LiveGamePlayer): string {
  return player.riotId || player.summonerName || '';
}

function stripTag(name: string): string {
  return name.split('#')[0]?.trim() ?? '';
}

function liveStats(player: LiveGamePlayer): LiveStats {
  return {
    kills: toNumber(player.scores?.kills),
    deaths: toNumber(player.scores?.deaths),
    assists: toNumber(player.scores?.assists),
    cs: toNumber(player.scores?.creepScore),
    wardScore: player.scores?.wardScore,
    championLevel: player.level,
    isDead: player.isDead,
  };
}

export function percentage(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '-';
  return `${round(value * 100, 0)}%`;
}
