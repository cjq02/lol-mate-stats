import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import { LcuError } from '../lcu/http.js';
import { analyzeGame } from './analyze.js';
import { currentQueueGroup, gameQueueGroup, queueGroupName } from './constants.js';
import { summarize } from './rating.js';

export interface CollectorOptions {
  /** 拉取最近多少场对局，默认 10 */
  recent: number;
  /** 玩家报告缓存时长，默认 24 小时；自己的报告不读缓存 */
  ttlMs: number;
  /** 对局详情缓存时长，默认 24 小时（对局数据不会变） */
  gameTtlMs: number;
  /** 单个玩家的拉取并发 */
  concurrency: number;
}

const DEFAULT_OPTIONS: CollectorOptions = {
  recent: 10,
  ttlMs: 24 * 60 * 60_000,
  gameTtlMs: 24 * 60 * 60_000,
  concurrency: 3,
};

interface CachedReport {
  at: number;
  report: PlayerReport;
}

const DAY_MS = 24 * 60 * 60_000;
const CACHE_VERSION = 1;
const CACHE_DB =
  process.env.LOL_MATE_CACHE?.trim() || join(homedir(), '.lol-mate-stats', 'cache.db');
/** 缓存数据库路径，启动日志里会打印 */
export const CACHE_DB_PATH = CACHE_DB;
const CACHE_SAVE_DELAY = 2_000;
/** 单类缓存最多落盘多少条，避免数据库无限增长 */
const MAX_PERSISTED = 500;

interface PersistedCache {
  version: number;
  savedAt: number;
  reports: Array<[string, CachedReport]>;
  summoners: Array<[number, { at: number; info: SummonerInfo | null }]>;
  summonersByName: Array<[string, { at: number; info: SummonerInfo | null }]>;
  ranks: Array<[string, { at: number; rank: RankInfo | null }]>;
  championMap?: { at: number; entries: Array<[number, ChampionSummary]> };
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
  /** 战绩服务 5xx 时的退避截止时间（指数增长），避免每 3 秒重复轰炸 */
  private historyRetryAt = 0;
  private historyBackoffMs = 0;
  /** 当前登录账号的 puuid：命中时不读报告缓存，保证自己的战绩实时 */
  private selfPuuid?: string;
  private selfRetryAt = 0;
  /** 磁盘缓存写盘防抖，避免采集过程中频繁写库 */
  private saveTimer?: NodeJS.Timeout;
  /** 串行写库，避免多个缓存同时更新时互相覆盖 */
  private saveQueue: Promise<void> = Promise.resolve();
  /** SQLite 连接，懒加载；失败后本次进程不再重试 */
  private db?: DatabaseSync;
  private dbFailed = false;

  constructor(
    private readonly api: LcuApi,
    options: Partial<CollectorOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.restoreCache();
  }

  clearCache(): void {
    this.reportCache.clear();
    this.summonerCache.clear();
    this.summonerByNameCache.clear();
    this.rankCache.clear();
    this.gameCache.clear();
    this.championMap = null;
    this.championMapAt = 0;
    this.historyRetryAt = 0;
    this.historyBackoffMs = 0;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const db = this.openDb();
    if (db) {
      try {
        db.exec(
          'DELETE FROM reports; DELETE FROM summoners; DELETE FROM summoners_by_name;' +
            ' DELETE FROM ranks; DELETE FROM champion_map; DELETE FROM meta;',
        );
      } catch {
        /* 清缓存失败不影响主流程 */
      }
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        /* WAL 回收失败不影响主流程 */
      }
    }
  }

  /** 立即把缓存写盘；退出前调用，避免防抖计时器被 unref 后丢失最后一次写入 */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.queueSave();
  }

  /** 启动时恢复报告/召唤师/段位/英雄缓存；对局原始详情不落盘，避免数据库过大 */
  private restoreCache(): void {
    const db = this.openDb();
    if (!db) return;

    const now = Date.now();
    const fresh = (at: number, ttl: number): boolean =>
      Number.isFinite(at) && now - at >= 0 && now - at < ttl;

    try {
      const version = db
        .prepare('SELECT v FROM meta WHERE k = ?')
        .get('version') as unknown as { v?: string } | undefined;
      if (version?.v !== String(CACHE_VERSION)) return;

      const reports = db
        .prepare('SELECT cache_key, at, payload FROM reports')
        .all() as unknown as Array<{ cache_key: string; at: number; payload: string }>;
      for (const row of reports) {
        if (!fresh(row.at, this.options.ttlMs)) continue;
        try {
          const report = JSON.parse(row.payload) as PlayerReport;
          if (report) this.reportCache.set(row.cache_key, { at: row.at, report });
        } catch {
          /* 单条损坏不影响其它缓存 */
        }
      }

      const summoners = db
        .prepare('SELECT summoner_id, at, payload FROM summoners')
        .all() as unknown as Array<{ summoner_id: number; at: number; payload: string }>;
      for (const row of summoners) {
        if (!fresh(row.at, DAY_MS)) continue;
        try {
          this.summonerCache.set(row.summoner_id, {
            at: row.at,
            info: JSON.parse(row.payload) as SummonerInfo | null,
          });
        } catch {
          /* 忽略损坏行 */
        }
      }

      const summonersByName = db
        .prepare('SELECT name, at, payload FROM summoners_by_name')
        .all() as unknown as Array<{ name: string; at: number; payload: string }>;
      for (const row of summonersByName) {
        if (!fresh(row.at, DAY_MS)) continue;
        try {
          this.summonerByNameCache.set(row.name, {
            at: row.at,
            info: JSON.parse(row.payload) as SummonerInfo | null,
          });
        } catch {
          /* 忽略损坏行 */
        }
      }

      const ranks = db
        .prepare('SELECT puuid, at, payload FROM ranks')
        .all() as unknown as Array<{ puuid: string; at: number; payload: string }>;
      for (const row of ranks) {
        if (!fresh(row.at, DAY_MS)) continue;
        try {
          this.rankCache.set(row.puuid, {
            at: row.at,
            rank: JSON.parse(row.payload) as RankInfo | null,
          });
        } catch {
          /* 忽略损坏行 */
        }
      }

      const champion = db
        .prepare('SELECT at, payload FROM champion_map WHERE id = 1')
        .get() as unknown as { at: number; payload: string } | undefined;
      if (champion && fresh(champion.at, DAY_MS)) {
        const entries = JSON.parse(champion.payload) as unknown;
        if (Array.isArray(entries) && entries.length) {
          this.championMap = new Map(entries as Array<[number, ChampionSummary]>);
          this.championMapAt = champion.at;
        }
      }
    } catch {
      /* 缓存读取失败不影响主流程 */
    }
  }

  private openDb(): DatabaseSync | undefined {
    if (this.db) return this.db;
    if (this.dbFailed) return undefined;
    try {
      mkdirSync(dirname(CACHE_DB), { recursive: true });
      const db = new DatabaseSync(CACHE_DB);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reports (
          cache_key TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reports_at ON reports(at);
        CREATE TABLE IF NOT EXISTS summoners (
          summoner_id INTEGER PRIMARY KEY,
          at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_summoners_at ON summoners(at);
        CREATE TABLE IF NOT EXISTS summoners_by_name (
          name TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_summoners_by_name_at ON summoners_by_name(at);
        CREATE TABLE IF NOT EXISTS ranks (
          puuid TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ranks_at ON ranks(at);
        CREATE TABLE IF NOT EXISTS champion_map (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
      `);
      this.db = db;
      return db;
    } catch {
      this.dbFailed = true;
      return undefined;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.queueSave();
    }, CACHE_SAVE_DELAY);
    this.saveTimer.unref?.();
  }

  private queueSave(): Promise<void> {
    this.saveQueue = this.saveQueue
      .then(() => this.writeCache())
      .catch(() => undefined);
    return this.saveQueue;
  }

  private serializeCache(): PersistedCache {
    const now = Date.now();
    const fresh = (at: number, ttl: number): boolean => now - at >= 0 && now - at < ttl;
    const byNewest = <K, T extends { at: number }>(a: [K, T], b: [K, T]): number =>
      b[1].at - a[1].at;

    const reports = [...this.reportCache.entries()]
      .filter(([, entry]) => fresh(entry.at, this.options.ttlMs))
      .sort(byNewest)
      .slice(0, MAX_PERSISTED);
    const summoners = [...this.summonerCache.entries()]
      .filter(([, entry]) => fresh(entry.at, DAY_MS))
      .sort(byNewest)
      .slice(0, MAX_PERSISTED);
    const summonersByName = [...this.summonerByNameCache.entries()]
      .filter(([, entry]) => fresh(entry.at, DAY_MS))
      .sort(byNewest)
      .slice(0, MAX_PERSISTED);
    const ranks = [...this.rankCache.entries()]
      .filter(([, entry]) => fresh(entry.at, DAY_MS))
      .sort(byNewest)
      .slice(0, MAX_PERSISTED);
    const championMap =
      this.championMap && fresh(this.championMapAt, DAY_MS)
        ? { at: this.championMapAt, entries: [...this.championMap.entries()] }
        : undefined;

    return {
      version: CACHE_VERSION,
      savedAt: now,
      reports,
      summoners,
      summonersByName,
      ranks,
      championMap,
    };
  }

  private writeCache(): void {
    const db = this.openDb();
    if (!db) return;

    const data = this.serializeCache();
    const cutoff = Date.now() - Math.max(this.options.ttlMs, DAY_MS);

    try {
      db.exec('BEGIN IMMEDIATE');

      db.prepare('DELETE FROM reports WHERE at < ?').run(cutoff);
      const insertReport = db.prepare(
        `INSERT INTO reports (cache_key, at, payload) VALUES (?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET at = excluded.at, payload = excluded.payload`,
      );
      for (const [key, entry] of data.reports) {
        insertReport.run(key, entry.at, JSON.stringify(entry.report));
      }
      db.prepare(
        `DELETE FROM reports WHERE cache_key NOT IN
         (SELECT cache_key FROM reports ORDER BY at DESC LIMIT ?)`,
      ).run(MAX_PERSISTED);

      db.prepare('DELETE FROM summoners WHERE at < ?').run(cutoff);
      const insertSummoner = db.prepare(
        `INSERT INTO summoners (summoner_id, at, payload) VALUES (?, ?, ?)
         ON CONFLICT(summoner_id) DO UPDATE SET at = excluded.at, payload = excluded.payload`,
      );
      for (const [summonerId, entry] of data.summoners) {
        insertSummoner.run(summonerId, entry.at, JSON.stringify(entry.info));
      }
      db.prepare(
        `DELETE FROM summoners WHERE summoner_id NOT IN
         (SELECT summoner_id FROM summoners ORDER BY at DESC LIMIT ?)`,
      ).run(MAX_PERSISTED);

      db.prepare('DELETE FROM summoners_by_name WHERE at < ?').run(cutoff);
      const insertSummonerByName = db.prepare(
        `INSERT INTO summoners_by_name (name, at, payload) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET at = excluded.at, payload = excluded.payload`,
      );
      for (const [name, entry] of data.summonersByName) {
        insertSummonerByName.run(name, entry.at, JSON.stringify(entry.info));
      }
      db.prepare(
        `DELETE FROM summoners_by_name WHERE name NOT IN
         (SELECT name FROM summoners_by_name ORDER BY at DESC LIMIT ?)`,
      ).run(MAX_PERSISTED);

      db.prepare('DELETE FROM ranks WHERE at < ?').run(cutoff);
      const insertRank = db.prepare(
        `INSERT INTO ranks (puuid, at, payload) VALUES (?, ?, ?)
         ON CONFLICT(puuid) DO UPDATE SET at = excluded.at, payload = excluded.payload`,
      );
      for (const [puuid, entry] of data.ranks) {
        insertRank.run(puuid, entry.at, JSON.stringify(entry.rank));
      }
      db.prepare(
        `DELETE FROM ranks WHERE puuid NOT IN
         (SELECT puuid FROM ranks ORDER BY at DESC LIMIT ?)`,
      ).run(MAX_PERSISTED);

      if (data.championMap) {
        db.prepare(
          `INSERT INTO champion_map (id, at, payload) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET at = excluded.at, payload = excluded.payload`,
        ).run(data.championMap.at, JSON.stringify(data.championMap.entries));
      } else {
        db.prepare('DELETE FROM champion_map WHERE id = 1').run();
      }

      const setMeta = db.prepare(
        'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      );
      setMeta.run('version', String(CACHE_VERSION));
      setMeta.run('savedAt', String(Date.now()));

      db.exec('COMMIT');
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败时忽略 */
      }
    }
  }

  /** 记录当前登录账号的 puuid；自己的报告不读缓存，保证实时 */
  setSelfPuuid(puuid?: string): void {
    if (!puuid) return;
    this.selfPuuid = puuid;
    this.selfRetryAt = 0;
  }

  /** 判断是否当前登录账号；未知时按需读一次 LCU */
  private async isSelf(puuid?: string): Promise<boolean> {
    if (!puuid) return false;
    if (this.selfPuuid) return puuid === this.selfPuuid;
    if (Date.now() < this.selfRetryAt) return false;
    try {
      const summoner = await this.api.getCurrentSummoner();
      this.selfPuuid = summoner?.puuid;
    } catch {
      this.selfPuuid = undefined;
    }
    if (!this.selfPuuid) {
      this.selfRetryAt = Date.now() + 60_000;
      return false;
    }
    return puuid === this.selfPuuid;
  }

  private isKnownSelf(puuid?: string): boolean {
    return Boolean(puuid && this.selfPuuid && puuid === this.selfPuuid);
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
   * 某场历史对局：把 10 名参与者都转成选人阶段一样的报告。
   * 用于首页“我的战绩”里点开某场比赛查看双方卡片。
   */
  async collectMatch(
    game: RawGame,
    selfPuuid: string,
    context?: GameContext,
    onProgress?: (done: number, total: number, name: string) => void,
  ): Promise<PlayerReport[]> {
    const participants = game.participants ?? [];
    const identities = game.participantIdentities ?? [];
    if (!participants.length) return [];

    const championMap = await this.getChampionMap();
    const entries = participants
      .map((participant, index) => {
        const identity = identities.find(
          (item) => toNumber(item.participantId) === toNumber(participant.participantId),
        );
        const player = identity?.player;
        const lane = String(participant.timeline?.lane ?? '').toUpperCase();
        const role = String(participant.timeline?.role ?? '').toUpperCase();
        const validLane = lane && lane !== 'NONE' ? lane : '';
        const position =
          validLane === 'BOTTOM'
            ? role === 'DUO_SUPPORT'
              ? 'utility'
              : 'bottom'
            : validLane === 'MIDDLE'
              ? 'middle'
              : validLane
                ? validLane.toLowerCase()
                : undefined;
        const name = player?.gameName
          ? `${player.gameName}${player.tagLine ? `#${player.tagLine}` : ''}`
          : String(player?.summonerName ?? '');
        return {
          participant,
          summonerId: toNumber(player?.summonerId),
          puuid: typeof player?.puuid === 'string' ? player.puuid : undefined,
          name,
          position,
          championId: toNumber(participant.championId),
          team: toNumber(participant.teamId),
          cellId: index,
        };
      })
      .filter((entry) => entry.summonerId > 0 || entry.puuid);

    const self = entries.find((entry) => selfPuuid && entry.puuid === selfPuuid) ?? entries[0];
    const selfTeam = self?.team;

    const prepared = await mapLimit(entries, 5, async (entry) => {
      const isBot =
        !entry.summonerId ||
        /(^|\s)bot$/i.test(entry.name) ||
        /^0{32}$/.test((entry.puuid ?? '').replace(/-/g, ''));

      let info: SummonerInfo | null = null;
      if (!isBot && entry.summonerId) info = await this.getSummoner(entry.summonerId);
      if (!isBot && !info && entry.name) info = await this.getSummonerByName(entry.name);

      const member: ChampSelectMember = {
        cellId: entry.cellId,
        summonerId: info?.summonerId ?? entry.summonerId,
        puuid: info?.puuid ?? entry.puuid,
        championId: entry.championId,
        championPickIntent: 0,
        assignedPosition: entry.position,
        team: entry.team,
      };
      const base = this.buildBaseReport(member, info, championMap, context);
      if (isBot) {
        base.displayName = entry.name || '人机';
        base.isBot = true;
        base.labels = ['人机'];
        base.loading = false;
        base.error = undefined;
      }
      return { member, base, isEnemy: entry.team !== selfTeam, isBot };
    });

    let done = 0;
    const reports = await mapLimit(prepared, 3, async ({ member, base, isEnemy, isBot }) => {
      const report = isBot ? base : await this.buildFullReport(member, base, championMap, context);
      done += 1;
      onProgress?.(done, prepared.length, report.displayName);
      return { ...report, isEnemy, isBot };
    });

    // 己方在前，敌方在后
    return reports.sort(
      (a, b) => Number(Boolean(a.isEnemy)) - Number(Boolean(b.isEnemy)),
    );
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

    const cacheKey = reportCacheKey(base.summonerId, context, this.options.recent);
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
        this.scheduleSave();
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
      this.scheduleSave();
      return report;
    } catch (error) {
      return {
        ...base,
        loading: false,
        rating: null,
        labels: [],
        error: historyErrorMessage(error),
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
    const cached =
      info && !this.isKnownSelf(info.puuid)
        ? this.reportCache.get(reportCacheKey(info.summonerId, context, this.options.recent))
            ?.report
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
    const cacheKey = reportCacheKey(member.summonerId, context, this.options.recent);
    const self = await this.isSelf(base.puuid ?? member.puuid);
    const cached = self ? undefined : this.reportCache.get(cacheKey);
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
        this.scheduleSave();
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
      this.scheduleSave();
      return report;
    } catch (error) {
      return {
        ...base,
        rating: null,
        labels: [],
        error: historyErrorMessage(error),
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
      // 复用的缓存可能来自上一局/敌方阵营，清掉只在当时有效的字段
      live: undefined,
      isEnemy: base.isEnemy,
      isBot: base.isBot,
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
    const puuid = info?.puuid ?? member.puuid;
    const cached = this.isKnownSelf(puuid)
      ? undefined
      : this.reportCache.get(
          reportCacheKey(member.summonerId, context, this.options.recent),
        )?.report;
    // 国服 LCU 的 displayName 常常是空字符串，真实名字只在 gameName 里
    const displayName =
      info?.displayName?.trim() ||
      info?.gameName ||
      `召唤师 ${member.summonerId}`;

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
    if (cached && Date.now() - cached.at < 24 * 60 * 60_000) return cached.info;

    let info: SummonerInfo | null = null;
    try {
      info = await this.api.getSummonerById(summonerId);
    } catch {
      info = null;
    }
    this.summonerCache.set(summonerId, { at: Date.now(), info });
    this.scheduleSave();
    return info;
  }

  /** 游戏内只有 Riot ID，通过名字查询召唤师信息（含 puuid） */
  private async getSummonerByName(name: string): Promise<SummonerInfo | null> {
    if (!name) return null;
    const cached = this.summonerByNameCache.get(name);
    if (cached && Date.now() - cached.at < 24 * 60 * 60_000) return cached.info;

    let info: SummonerInfo | null = null;
    try {
      info = await this.api.getSummonerByName(name);
    } catch {
      info = null;
    }
    this.summonerByNameCache.set(name, { at: Date.now(), info });
    this.scheduleSave();
    return info;
  }

  private async getRank(puuid: string): Promise<RankInfo | null> {
    const cached = this.rankCache.get(puuid);
    if (cached && Date.now() - cached.at < 24 * 60 * 60_000) return cached.rank;
    const rank = await this.api.getRankedStats(puuid);
    this.rankCache.set(puuid, { at: Date.now(), rank });
    this.scheduleSave();
    return rank;
  }

  private async loadRecentGames(
    summoner: SummonerInfo,
    context?: GameContext,
  ): Promise<RawGame[]> {
    const waitMs = this.historyRetryAt - Date.now();
    if (waitMs > 0) {
      throw new HistoryUnavailableError(
        `战绩服务暂时不可用，约 ${Math.ceil(waitMs / 1000)} 秒后自动重试`,
      );
    }

    const target = this.options.recent;
    const group = context ? currentQueueGroup(context.queueId, context.mode) : undefined;

    // 只拉摘要的列表接口很轻，详情才是大头；先取一个窗口，同模式不够再扩窗
    const MAX_CANDIDATES = 100;
    let windowSize = Math.min(
      MAX_CANDIDATES,
      context ? Math.max(target * 2, target) : target,
    );
    let games: RawGame[] = [];

    // 国服只有 v1 products 一个可用入口，v3/account 路由会直接 404
    const fetchGames = async (count: number): Promise<RawGame[]> => {
      if (!summoner.puuid) return [];
      try {
        return await this.api.getMatchListByPuuid(summoner.puuid, count);
      } catch (error) {
        if (isHistoryBusy(error)) this.coolDownHistory();
        throw error;
      }
    };

    games = await fetchGames(windowSize);
    if (!games.length) {
      throw new Error('没有读取到对局记录（可能隐藏了战绩，或为新号）');
    }
    this.historyBackoffMs = 0;
    this.historyRetryAt = 0;

    // 先按队列筛掉其它模式，避免为了 10 场大乱斗去请求几十场对局详情
    const sameMode = (list: RawGame[]): RawGame[] =>
      group
        ? list.filter((game) => gameQueueGroup(toNumber(game.queueId), 'UNKNOWN') === group)
        : list;

    let filtered = sameMode(games);
    // “最近 N 场同模式”而不是“最近 N 场里恰好有几场同模式”：
    // 不足时继续往前翻，只增加摘要请求，详情请求仍然最多 target 次
    while (
      group &&
      filtered.length < target &&
      games.length >= windowSize &&
      windowSize < MAX_CANDIDATES
    ) {
      const next = Math.min(MAX_CANDIDATES, windowSize * 3);
      let wider: RawGame[];
      try {
        wider = await fetchGames(next);
      } catch {
        // 扩窗失败时保留已经取到的同模式对局
        break;
      }
      if (wider.length <= games.length) break; // 没有更多历史
      games = wider;
      windowSize = next;
      filtered = sameMode(games);
    }

    games = filtered.slice(0, target);
    if (!games.length) return [];

    // 列表接口只给概要时（没有 10 人详情），再按 gameId 拉一次详情
    const detailed = await mapLimit(games, 4, async (game) => {
      if (hasGameDetail(game)) return game;
      const gameId = toNumber(game.gameId);
      if (!gameId) return null;
      return this.getGameDetail(gameId);
    });

    return detailed.filter((game): game is RawGame => game !== null);
  }

  /** 战绩服务异常时指数退避：60s → 120s → 240s，封顶 5 分钟 */
  private coolDownHistory(): void {
    const now = Date.now();
    // 同一轮里多个玩家并发失败时只提升一次退避，避免直接跳到上限
    if (now < this.historyRetryAt) return;
    this.historyBackoffMs = this.historyBackoffMs
      ? Math.min(5 * 60_000, this.historyBackoffMs * 2)
      : 60_000;
    this.historyRetryAt = now + this.historyBackoffMs;
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
    if (this.gameCache.size > 1200) {
      const oldest = [...this.gameCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.gameCache.delete(oldest[0]);
    }
    return game;
  }

  private async getChampionMap(): Promise<Map<number, ChampionSummary>> {
    if (this.championMap && Date.now() - this.championMapAt < 24 * 60 * 60_000) {
      return this.championMap;
    }
    try {
      this.championMap = await this.api.getChampionMap();
      this.championMapAt = Date.now();
      this.scheduleSave();
    } catch {
      this.championMap ??= new Map();
    }
    return this.championMap;
  }
}

function effectiveChampionId(member: ChampSelectMember): number {
  return member.championId || member.championPickIntent || 0;
}

function reportCacheKey(
  summonerId: number,
  context: GameContext | undefined,
  recent: number,
): string {
  const group = context ? currentQueueGroup(context.queueId, context.mode) : 'all';
  return `${summonerId}:${group}:${recent}`;
}

function contextLabel(context?: GameContext): string {
  if (!context) return '近期对局';
  return queueGroupName(currentQueueGroup(context.queueId, context.mode), context.queueId);
}

/** 战绩服务整体不可用：可能是真实 5xx，也可能正处于退避期 */
class HistoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryUnavailableError';
  }
}

function isHistoryBusy(error: unknown): boolean {
  if (error instanceof HistoryUnavailableError) return true;
  return (
    error instanceof LcuError &&
    [429, 500, 502, 503, 504].includes(error.status)
  );
}

function historyErrorMessage(error: unknown): string {
  if (!isHistoryBusy(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return `读取战绩失败：${truncate(message, 120)}`;
  }
  if (error instanceof HistoryUnavailableError) return error.message;
  const status = (error as LcuError).status;
  return `战绩服务暂时不可用（HTTP ${status}，腾讯侧超时），稍后自动重试`;
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
