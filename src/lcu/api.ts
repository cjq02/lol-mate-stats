import type {
  ChampSelectSession,
  GameflowSession,
  LcuConnection,
  RankInfo,
  RawGame,
  SummonerInfo,
} from '../types.js';
import { LcuError, LcuHttp } from './http.js';

export interface ChampionSummary {
  id: number;
  name: string;
  alias: string;
}

export interface GameflowPhaseResponse {
  phase?: string;
}

export class LcuApi {
  readonly http: LcuHttp;
  private championMapPromise?: Promise<Map<number, ChampionSummary>>;

  constructor(readonly conn: LcuConnection) {
    this.http = new LcuHttp(conn);
  }

  /* ----------------------------- 基础信息 ----------------------------- */

  getGameflowPhase(): Promise<string> {
    return this.http
      .get<GameflowPhaseResponse | string>('/lol-gameflow/v1/gameflow-phase', 8_000)
      .then((data) =>
        typeof data === 'string' ? data : (data?.phase ?? 'None'),
      );
  }

  getChampSelectSession(): Promise<ChampSelectSession | null> {
    return this.http.getOrNull<ChampSelectSession>('/lol-champ-select/v1/session', 8_000);
  }

  /** 当前对局信息（队列 ID、模式），选人阶段也能拿到 */
  getGameflowSession(): Promise<GameflowSession | null> {
    return this.http.getOrNull<GameflowSession>('/lol-gameflow/v1/session', 8_000);
  }

  getCurrentSummoner(): Promise<SummonerInfo> {
    return this.http.get<SummonerInfo>('/lol-summoner/v1/current-summoner', 10_000);
  }

  getSummonerById(summonerId: number): Promise<SummonerInfo> {
    return this.http.get<SummonerInfo>(`/lol-summoner/v1/summoners/${summonerId}`, 10_000);
  }

  async getSummonerByName(name: string): Promise<SummonerInfo | null> {
    const query = encodeURIComponent(name);
    const result = await this.http.getOrNull<SummonerInfo | null>(
      `/lol-summoner/v1/summoners?name=${query}`,
    );
    if (!result) return null;
    if (Array.isArray(result)) {
      const first = result[0] as SummonerInfo | undefined;
      return first ?? null;
    }
    if (typeof result === 'object' && 'summonerId' in result) return result;
    return null;
  }

  async getRegion(): Promise<string | undefined> {
    try {
      const region = await this.http.get<{ region?: string; webRegion?: string }>(
        '/riotclient/region-locale',
        5_000,
      );
      return region?.region ?? region?.webRegion;
    } catch {
      return undefined;
    }
  }

  /* ----------------------------- 战绩 ----------------------------- */

  /** 最近对局（LCU 会代理到当前大区，无需 Riot API Key） */
  async getMatchListByPuuid(puuid: string, count: number): Promise<RawGame[]> {
    const payload = await this.http.get<unknown>(
      `/lol-match-history/v1/products/lol/${encodeURIComponent(puuid)}/matches?begIndex=0&endIndex=${Math.max(0, count - 1)}`,
      10_000,
    );
    return unwrapGames(payload);
  }

  async getMatchListByAccount(accountId: number, count: number): Promise<RawGame[]> {
    const payload = await this.http.get<unknown>(
      `/lol-match-history/v3/matchlist/account/${accountId}?begIndex=0&endIndex=${Math.max(0, count - 1)}`,
      10_000,
    );
    return unwrapGames(payload);
  }

  getGame(gameId: number): Promise<RawGame> {
    return this.http.get<RawGame>(`/lol-match-history/v1/games/${gameId}`, 20_000);
  }

  /* ----------------------------- 段位 ----------------------------- */

  async getRankedStats(puuid: string): Promise<RankInfo | null> {
    try {
      const payload = await this.http.getOrNull<{
        queueMap?: Record<string, Record<string, unknown>>;
      }>(`/lol-ranked/v1/ranked-stats/${encodeURIComponent(puuid)}`, 8_000);
      if (!payload?.queueMap) return null;

      const queues: Array<'RANKED_SOLO_5x5' | 'RANKED_FLEX_SR'> = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'];
      for (const queue of queues) {
        const entry = payload.queueMap[queue];
        const tier = String(entry?.tier ?? '').toUpperCase();
        if (!entry || !tier || tier === 'NONE' || tier === 'UNRANKED') continue;
        return {
          queue,
          tier,
          division: String(entry.division ?? ''),
          leaguePoints: Number(entry.leaguePoints ?? 0),
          wins: Number(entry.wins ?? 0),
          losses: Number(entry.losses ?? 0),
        };
      }
      return null;
    } catch (error) {
      if (error instanceof LcuError) return null;
      return null;
    }
  }

  /* ----------------------------- 资源 ----------------------------- */

  async getChampionMap(): Promise<Map<number, ChampionSummary>> {
    if (!this.championMapPromise) {
      this.championMapPromise = this.loadChampionMap().catch((error) => {
        this.championMapPromise = undefined;
        throw error;
      });
    }
    return this.championMapPromise;
  }

  private async loadChampionMap(): Promise<Map<number, ChampionSummary>> {
    const list = await this.http.get<ChampionSummary[]>(
      '/lol-game-data/assets/v1/champion-summary.json',
      20_000,
    );
    const map = new Map<number, ChampionSummary>();
    for (const champion of list ?? []) {
      if (champion && typeof champion.id === 'number' && champion.id > 0) {
        map.set(champion.id, champion);
      }
    }
    return map;
  }

  async getAsset(path: string): Promise<{ body: Buffer; contentType: string } | null> {
    if (!path.startsWith('/lol-game-data/assets/') || path.includes('..')) return null;
    try {
      const response = await this.http.raw('GET', path, undefined, 15_000);
      return {
        body: response.body,
        contentType: String(response.headers['content-type'] ?? 'image/png'),
      };
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.http.destroy();
  }
}

/** 兼容不同 LCU 版本返回结构：{games:{games:[]}} / {games:[]} / [] */
export function unwrapGames(payload: unknown): RawGame[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as RawGame[];
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const games = record.games;
    if (Array.isArray(games)) return games as RawGame[];
    if (games && typeof games === 'object') {
      const nested = (games as Record<string, unknown>).games;
      if (Array.isArray(nested)) return nested as RawGame[];
    }
    if (Array.isArray(record.matches)) return record.matches as RawGame[];
  }
  return [];
}
