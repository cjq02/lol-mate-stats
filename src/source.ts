import type { MatchDetail, MatchSummary, PlayerReport, Snapshot, SummonerInfo } from './types.js';

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
  /** 首页“我的战绩”：当前账号最近对局列表 */
  getMyMatches?(recent: number): Promise<{ summoner: SummonerInfo; games: MatchSummary[] }>;
  /** 某场对局里 10 名玩家的近期战绩卡片 */
  getMatchDetail?(
    gameId: number,
    recent: number,
    onProgress?: (done: number, total: number, name: string) => void,
  ): Promise<MatchDetail>;
  stop(): void;
}
