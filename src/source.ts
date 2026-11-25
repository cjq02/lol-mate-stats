import type {
  ArchiveCursor,
  GameContext,
  GameModeKey,
  MatchDetail,
  MatchSummary,
  MatchTimeline,
  PlayerReport,
  Snapshot,
  SummonerInfo,
} from './types.js';
import type {
  ArchivedMatch,
  ChampionRadarOptions,
  ChampionScoreSummary,
  PlayerMatchFilter,
  PlayerWinRecord,
} from './stats/archive.js';
import type { TimeStatsSummary, TypeRadarEntry, ChampionRadarEntry } from './stats/time-stats.js';

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
  ): Promise<{
    puuid: string;
    total: number;
    games: ArchivedMatch[];
    nextCursor?: ArchiveCursor;
  }>;
  /** 长期存档：某个玩家（默认自己）各英雄的平均单场评分排名 */
  getArchivedChampionScores?(
    puuid?: string,
    minGames?: number,
    mode?: GameModeKey,
    showAll?: boolean,
    range?: number,
    allRange?: number,
  ): Promise<{ puuid: string; champions: ChampionScoreSummary[]; totalGames: number }>;
  /** 长期存档：某个玩家（默认自己）在指定模式/队列组或指定英雄的总胜负 */
  getArchivedWinRecord?(
    puuid: string | undefined,
    queueId: number | undefined,
    mode: GameModeKey | undefined,
    championId?: number,
    group?: string,
  ): Promise<{
    puuid: string;
    group: string;
    groupName: string;
    record: PlayerWinRecord;
  }>;
  /** 长期存档：某个玩家（默认自己）按一天内时段统计的胜率与坑率 */
  getArchivedTimeStats?(
    puuid?: string,
    mode?: GameModeKey,
  ): Promise<{
    puuid: string;
    source: 'archive' | 'recent' | 'none';
    stats: TimeStatsSummary;
  }>;
  /** 长期存档：按英雄类型对比我和所有玩家的六项指标 */
  getArchivedTypeRadar?(
    puuid?: string,
    mode?: GameModeKey,
  ): Promise<{ puuid: string; types: TypeRadarEntry[] }>;
  /** 长期存档：单个英雄对比我和所有玩家的六项指标 */
  getArchivedChampionRadar?(
    puuid: string | undefined,
    championId: number,
    mode?: GameModeKey,
    options?: ChampionRadarOptions,
  ): Promise<{ puuid: string; radar: ChampionRadarEntry | null }>;
  /** 某场对局里 10 名玩家的近期战绩卡片 */
  getMatchDetail?(
    gameId: number,
    recent: number,
    onProgress?: (done: number, total: number, name: string) => void,
    options?: { force?: boolean; onScoreboard?: (detail: MatchDetail) => void },
  ): Promise<MatchDetail>;
  /** 本局时间线：按阵亡切分每条命；第一次读客户端，之后走 MySQL 存档 */
  getMatchTimeline?(
    gameId: number,
  ): Promise<{ timeline: MatchTimeline; cached: boolean }>;
  stop(): void | Promise<void>;
}
