import type {
  GameContext,
  GameModeKey,
  MatchDetail,
  MatchSummary,
  PlayerReport,
  Snapshot,
  SummonerInfo,
} from './types.js';
import type {
  ArchivedMatch,
  ChampionScoreSummary,
  PlayerMatchFilter,
  PlayerWinRecord,
} from './stats/archive.js';

export interface AssetResult {
  body: Buffer;
  contentType: string;
}

/** 数据源抽象：live 来自 LCU，demo 为本地模拟数据 */
export interface DataSource {
  readonly mode: 'live' | 'demo';
  getSnapshot(): Snapshot;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  refresh(): Promise<void>;
  /** 手动清空缓存（可选） */
  clearCache?(): void;
  getAsset(path: string): Promise<AssetResult | null>;
  /** 按名字查询任意玩家的近期战绩（可选，demo 模式不支持） */
  scanPlayer?(name: string, recent: number): Promise<PlayerReport[]>;
  /** 强制更新单个玩家的近期战绩（绕过报告缓存） */
  refreshPlayer?(
    summonerId: number,
    options?: { recent?: number; context?: GameContext },
  ): Promise<PlayerReport>;
  /** 首页“我的战绩”：当前账号最近对局列表；offset 用于继续往前翻页 */
  getMyMatches?(
    recent: number,
    offset?: number,
  ): Promise<{ summoner: SummonerInfo; games: MatchSummary[] }>;
  /** 长期存档：某个玩家（默认自己）的历史对局 */
  getArchivedMatches?(
    limit: number,
    offset: number,
    puuid?: string,
    filter?: PlayerMatchFilter,
  ): Promise<{ puuid: string; total: number; games: ArchivedMatch[] }>;
  /** 长期存档：某个玩家（默认自己）各英雄的平均单场评分排名 */
  getArchivedChampionScores?(
    puuid?: string,
    minGames?: number,
    mode?: GameModeKey,
  ): Promise<{ puuid: string; champions: ChampionScoreSummary[] }>;
  /** 长期存档：某个玩家（默认自己）在指定模式/队列组或指定英雄的总胜负 */
  getArchivedWinRecord?(
    puuid: string | undefined,
    queueId: number | undefined,
    mode: GameModeKey | undefined,
    championId?: number,
  ): Promise<{
    puuid: string;
    group: string;
    groupName: string;
    record: PlayerWinRecord;
  }>;
  /** 某场对局里 10 名玩家的近期战绩卡片 */
  getMatchDetail?(
    gameId: number,
    recent: number,
    onProgress?: (done: number, total: number, name: string) => void,
    options?: { force?: boolean },
  ): Promise<MatchDetail>;
  stop(): void | Promise<void>;
}
