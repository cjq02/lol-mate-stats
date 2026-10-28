import type {
  ChampSelectMember,
  ChampSelectSession,
  PlayerReport,
  RankInfo,
  RawGame,
  SummonerInfo,
} from '../types.js';
import { mapLimit, round, toNumber, truncate } from '../util.js';
import type { ChampionSummary, LcuApi } from '../lcu/api.js';
import { analyzeGame } from './analyze.js';
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
  private readonly reportCache = new Map<number, CachedReport>();
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
    this.rankCache.clear();
  }

  championName(championId: number | undefined): string | undefined {
    if (!championId) return undefined;
    return this.championMap?.get(championId)?.name;
  }

  async collect(
    session: ChampSelectSession,
    onProgress?: (players: PlayerReport[]) => void,
  ): Promise<PlayerReport[]> {
    const members = [...(session.myTeam ?? [])].sort((a, b) => a.cellId - b.cellId);
    if (!members.length) return [];

    const championMap = await this.getChampionMap();

    // 第一步：先把名字等基础信息填上，界面可以立即显示占位卡片
    const bases = await mapLimit(members, 5, async (member) => {
      const info = await this.getSummoner(member.summonerId);
      return this.buildBaseReport(member, info, championMap);
    });
    onProgress?.(bases);

    // 第二步：并发拉取战绩；每完成一个就推送一次，避免长时间空白
    const reports = [...bases];
    await mapLimit(members, this.options.concurrency, async (member, index) => {
      const base = bases[index] as PlayerReport;
      const report = await this.buildFullReport(member, base, championMap);
      reports[index] = report;
      onProgress?.([...reports]);
    });

    return reports;
  }

  private async buildFullReport(
    member: ChampSelectMember,
    base: PlayerReport,
    championMap: Map<number, ChampionSummary>,
  ): Promise<PlayerReport> {
    const cached = this.reportCache.get(member.summonerId);
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
        this.loadRecentGames(summoner),
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

      if (!analyzed.length) {
        const report: PlayerReport = {
          ...base,
          rank,
          recent: undefined,
          games: [],
          rating: null,
          labels: [],
          error: '近期的对局无法解析（可能隐藏了战绩）',
        };
        this.reportCache.set(member.summonerId, { at: Date.now(), report });
        return report;
      }

      const summary = summarize(analyzed, { level: summoner.summonerLevel });
      const report: PlayerReport = {
        ...base,
        rank,
        recent: summary,
        games: analyzed.slice(0, this.options.recent),
        rating: summary.rating,
        grade: summary.grade,
        labels: summary.labels,
        error: undefined,
      };
      this.reportCache.set(member.summonerId, { at: Date.now(), report });
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
  ): PlayerReport {
    const championId = effectiveChampionId(member);
    const cached = this.reportCache.get(member.summonerId);
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
      rating: cached?.report.rating ?? null,
      grade: cached?.report.grade,
      labels: cached?.report.labels ?? [],
      recent: cached?.report.recent,
      games: cached?.report.games,
      rank: cached?.report.rank,
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

  private async getRank(puuid: string): Promise<RankInfo | null> {
    const cached = this.rankCache.get(puuid);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.rank;
    const rank = await this.api.getRankedStats(puuid);
    this.rankCache.set(puuid, { at: Date.now(), rank });
    return rank;
  }

  private async loadRecentGames(summoner: SummonerInfo): Promise<RawGame[]> {
    const count = this.options.recent;
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

function hasGameDetail(game: RawGame): boolean {
  const participants = game.participants;
  const identities = game.participantIdentities;
  if (!Array.isArray(participants) || !participants.length) return false;
  if (!Array.isArray(identities) || !identities.length) return false;
  return participants.some((participant) => participant.stats && 'kills' in participant.stats);
}

export function percentage(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '-';
  return `${round(value * 100, 0)}%`;
}
