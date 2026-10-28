import type { Snapshot } from './types.js';

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
  getAsset(path: string): Promise<AssetResult | null>;
  stop(): void;
}
