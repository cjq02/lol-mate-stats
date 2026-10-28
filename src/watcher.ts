import type {
  ChampSelectMember,
  ChampSelectSession,
  GameContext,
  LcuConnection,
  PlayerReport,
  Snapshot,
} from './types.js';
import type { AssetResult, DataSource } from './source.js';
import { LcuApi } from './lcu/api.js';
import { ClientNotFoundError, discoverConnection } from './lcu/discover.js';
import { openEventStream } from './lcu/events.js';
import { fetchLiveGame, liveMembersOf, sameLiveName } from './lcu/live.js';
import { ReportCollector } from './stats/collector.js';
import { modeFromQueue } from './stats/constants.js';
import { nowIso, logTag, sleep } from './util.js';

export interface LiveSourceOptions {
  recent?: number;
  pollMs?: number;
  /** 战绩缓存时长 */
  ttlMs?: number;
  quiet?: boolean;
}

export function phaseMessage(phase: string): string {
  switch (phase) {
    case 'ChampSelect':
      return '正在读取队友战绩…';
    case 'Matchmaking':
      return '正在匹配，进入选人阶段后自动分析';
    case 'ReadyCheck':
      return '已找到对局，等待接受…';
    case 'InProgress':
      return '游戏进行中，显示双方 10 名玩家的战绩';
    case 'WaitingForStats':
      return '对局结算中…';
    case 'EndOfGame':
      return '对局已结束，等待下一局';
    case 'Lobby':
      return '已在大厅，进入选人阶段后自动分析';
    case 'Reconnect':
      return '客户端正在重连…';
    default:
      return '等待进入选人阶段…';
  }
}

export class LiveSource implements DataSource {
  readonly mode = 'live' as const;

  private snapshot: Snapshot = {
    mode: 'live',
    phase: 'None',
    inChampSelect: false,
    collecting: false,
    updatedAt: nowIso(),
    message: '正在连接英雄联盟客户端…',
    players: [],
  };

  private readonly listeners = new Set<(snapshot: Snapshot) => void>();
  private readonly options: Required<LiveSourceOptions>;

  private api?: LcuApi;
  private collector?: ReportCollector;
  private connection?: LcuConnection;
  private eventStream?: { close(): void };
  private pollTimer?: NodeJS.Timeout;
  private eventTimer?: NodeJS.Timeout;
  private nextDiscoveryAt = 0;
  private lastMembersKey = '';
  private lastCollectAt = 0;
  private lastSerialized = '';
  private busy = false;
  private stopped = false;
  private tickRunning = false;

  constructor(options: LiveSourceOptions = {}) {
    this.options = {
      recent: options.recent ?? 10,
      pollMs: options.pollMs ?? 3_000,
      ttlMs: options.ttlMs ?? 10 * 60_000,
      quiet: options.quiet ?? false,
    };
  }

  start(): void {
    if (this.stopped) return;
    void this.tick('start');
    this.pollTimer = setInterval(() => void this.tick('poll'), this.options.pollMs);
    this.pollTimer.unref?.();
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    this.lastMembersKey = '';
    this.lastCollectAt = 0;
    this.collector?.clearCache();
    const api = this.api;
    const session = api ? await api.getChampSelectSession().catch(() => null) : null;
    if (api && session?.myTeam?.length) {
      const context = await this.resolveContext(api);
      await this.collect(api, session, context);
    } else {
      await this.tick('event');
    }
  }

  async getAsset(path: string): Promise<AssetResult | null> {
    if (!this.api) return null;
    return this.api.getAsset(path);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventStream?.close();
    this.eventStream = undefined;
    this.api?.destroy();
    this.api = undefined;
  }

  /* ------------------------------------------------------------------ */

  private log(message: string): void {
    if (!this.options.quiet) logTag('lcu', message);
  }

  private async tick(reason: string): Promise<void> {
    if (this.stopped || this.tickRunning) return;
    this.tickRunning = true;
    try {
      const api = await this.ensureApi();
      if (!api) return;

      let phase = 'None';
      try {
        phase = await api.getGameflowPhase();
      } catch {
        // 客户端关闭或端口失效，下次重新发现
        this.disconnect();
        this.patch({
          phase: 'None',
          inChampSelect: false,
          collecting: false,
          players: [],
          message: '与客户端的连接已断开，正在等待客户端…',
          error: undefined,
        });
        return;
      }

      if (phase === 'InProgress') {
        await this.collectInGame(api);
        return;
      }

      if (phase !== 'ChampSelect') {
        this.resetForPhase(phase);
        return;
      }

      const session = await api.getChampSelectSession().catch(() => null);
      if (!session?.myTeam?.length) {
        this.patch({
          phase,
          inChampSelect: false,
          collecting: false,
          message: '正在进入选人阶段…',
        });
        return;
      }

      if (this.busy) return;

      const membersKey = session.myTeam
        .map((member) => member.summonerId)
        .sort((a, b) => a - b)
        .join(',');
      const cacheExpired = Date.now() - this.lastCollectAt > this.options.ttlMs;

      if (membersKey === this.lastMembersKey && !cacheExpired) {
        this.updateSessionChampions(session);
        return;
      }

      if (reason !== 'poll') this.log('进入选人阶段，开始读取队友战绩');
      const context = await this.resolveContext(api);
      await this.collect(api, session, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof ClientNotFoundError)) {
        this.patch({ error: message });
      }
    } finally {
      this.tickRunning = false;
    }
  }

  private resetForPhase(phase: string): void {
    const changed = this.snapshot.phase !== phase || this.snapshot.inChampSelect;
    this.lastMembersKey = '';
    this.patch(
      {
        phase,
        inChampSelect: false,
        inGame: false,
        collecting: false,
        players: changed ? [] : this.snapshot.players,
        message: phaseMessage(phase),
        localPlayer: undefined,
        queueId: undefined,
        gameMode: undefined,
        error: undefined,
      },
      false,
    );
  }

  /** 读取当前队列（选人阶段也能拿到），用于只统计同模式战绩 */
  private async resolveContext(api: LcuApi): Promise<GameContext | undefined> {
    if (this.snapshot.queueId !== undefined || this.snapshot.gameMode !== undefined) {
      return { queueId: this.snapshot.queueId, mode: this.snapshot.gameMode };
    }
    try {
      const session = await api.getGameflowSession();
      const queueId = session?.gameData?.queue?.id;
      const mode = modeFromQueue(queueId, session?.gameData?.gameMode);
      if (queueId !== undefined || mode !== undefined) {
        this.patch({ queueId, gameMode: mode }, false);
      }
      return queueId !== undefined || mode !== undefined ? { queueId, mode } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 游戏进行中：从 Live Client Data API 读取本局 10 名玩家，
   * 再结合 LCU 的历史战绩给出同样的评分卡片。
   */
  private async collectInGame(api: LcuApi): Promise<void> {
    if (this.busy) return;

    const game = await fetchLiveGame();
    if (!game) {
      // 还在加载界面时 2999 端口尚未就绪
      this.patch({
        phase: 'InProgress',
        inChampSelect: false,
        inGame: true,
        collecting: false,
        message: '游戏进行中，等待对局数据…',
        error: undefined,
      });
      return;
    }

    const all = game.allPlayers ?? [];
    const activeName = game.activePlayer?.riotId ?? game.activePlayer?.summonerName ?? '';
    const members = liveMembersOf(all, game.activePlayer);
    const self = members.find(
      (player) => !player.isEnemy && sameLiveName(player, activeName),
    );
    if (!members.length) {
      this.patch({
        phase: 'InProgress',
        inChampSelect: false,
        inGame: true,
        collecting: false,
        message: '游戏进行中，等待对局数据…',
      });
      return;
    }

    const queueId = game.gameData?.queue?.id ?? this.snapshot.queueId;
    const gameMode =
      modeFromQueue(queueId, game.gameData?.gameMode) ?? this.snapshot.gameMode;
    const context: GameContext | undefined =
      queueId !== undefined || gameMode !== undefined ? { queueId, mode: gameMode } : undefined;

    this.busy = true;
    this.patch({
      phase: 'InProgress',
      inChampSelect: false,
      inGame: true,
      queueId,
      gameMode,
      collecting: this.snapshot.players.length === 0,
      message: this.snapshot.players.length ? undefined : '正在读取本局 10 名玩家的战绩…',
      error: undefined,
    });

    try {
      const collector = this.ensureCollector(api);
      const reports = await collector.collectLive(
        members,
        (partial) => {
          this.patch({ players: partial, collecting: partial.some((player) => player.loading) });
        },
        context,
      );

      const selfIndex = self ? members.indexOf(self) : -1;
      const selfReport = selfIndex >= 0 ? reports[selfIndex] : undefined;
      this.patch({
        players: reports,
        collecting: false,
        inGame: true,
        message: undefined,
        localPlayer: selfReport
          ? {
              summonerId: selfReport.summonerId,
              displayName: selfReport.displayName,
              cellId: 0,
              championId: selfReport.championId ?? 0,
              championName: selfReport.championName,
            }
          : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ collecting: false, error: `读取本局数据失败：${message}` });
    } finally {
      this.busy = false;
    }
  }

  private async collect(
    api: LcuApi,
    session: ChampSelectSession,
    context?: GameContext,
  ): Promise<void> {
    this.busy = true;
    this.lastMembersKey = session.myTeam
      .map((member) => member.summonerId)
      .sort((a, b) => a - b)
      .join(',');

    const localMember = session.myTeam.find(
      (member) => member.cellId === session.localPlayerCellId,
    );

    this.patch(
      {
        phase: 'ChampSelect',
        inChampSelect: true,
        collecting: true,
        message: '正在读取队友战绩…',
        error: undefined,
        localPlayer: localMember
          ? {
              summonerId: localMember.summonerId,
              displayName: '你',
              cellId: localMember.cellId,
              championId: localMember.championId,
            }
          : undefined,
      },
      true,
    );

    try {
      const collector = this.ensureCollector(api);
      const reports = await collector.collect(
        session,
        (partial) => {
          this.patch(
            {
              players: partial,
              collecting: partial.some((player) => player.loading),
              localPlayer: this.localPlayerFrom(session, partial),
            },
            true,
          );
        },
        context,
      );

      this.lastCollectAt = Date.now();
      this.patch(
        {
          players: reports,
          collecting: false,
          message: undefined,
          localPlayer: this.localPlayerFrom(session, reports),
        },
        true,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ collecting: false, error: `读取队友战绩失败：${message}` });
    } finally {
      this.busy = false;
    }
  }

  private updateSessionChampions(session: ChampSelectSession): void {
    if (!this.snapshot.players.length) return;
    const bySummoner = new Map<number, ChampSelectMember>(
      session.myTeam.map((member) => [member.summonerId, member]),
    );
    let changed = false;
    const players = this.snapshot.players.map((player) => {
      const member = bySummoner.get(player.summonerId);
      if (!member) return player;
      const championId = member.championId || member.championPickIntent || 0;
      if (player.championId !== (championId || undefined)) {
        changed = true;
        return {
          ...player,
          championId: championId || undefined,
          championName: this.collector?.championName(championId) ?? player.championName,
        };
      }
      return player;
    });
    if (changed) this.patch({ players, localPlayer: this.localPlayerFrom(session, players) });
  }

  private localPlayerFrom(
    session: ChampSelectSession,
    players: PlayerReport[],
  ): Snapshot['localPlayer'] {
    const member = session.myTeam?.find((item) => item.cellId === session.localPlayerCellId);
    if (!member) return undefined;
    const report = players.find((player) => player.summonerId === member.summonerId);
    return {
      summonerId: member.summonerId,
      displayName: report?.displayName?.trim() || '你',
      cellId: member.cellId,
      championId: member.championId,
      championName: report?.championName,
    };
  }

  private async ensureApi(): Promise<LcuApi | undefined> {
    if (this.api) return this.api;
    if (Date.now() < this.nextDiscoveryAt) return undefined;

    try {
      const connection = await discoverConnection();
      this.connection = connection;
      const api = new LcuApi(connection);
      this.api = api;
      this.collector = new ReportCollector(api, {
        recent: this.options.recent,
        ttlMs: this.options.ttlMs,
      });
      this.log(`已连接客户端（端口 ${connection.port}，来源：${connection.source}）`);
      this.patch(
        {
          error: undefined,
          message: '已连接客户端，等待进入选人阶段…',
          phase: 'None',
        },
        true,
      );
      this.attachEvents(connection);
      void api
        .getRegion()
        .then((region) => {
          if (region) this.patch({ region });
        })
        .catch(() => undefined);
      return api;
    } catch (error) {
      this.nextDiscoveryAt = Date.now() + 5_000;
      const message =
        error instanceof ClientNotFoundError
          ? '未检测到英雄联盟客户端，启动客户端后会自动连接'
          : `连接客户端失败：${error instanceof Error ? error.message : String(error)}`;
      this.patch({
        error: undefined,
        message,
        phase: 'None',
        inChampSelect: false,
        collecting: false,
        players: [],
      });
      return undefined;
    }
  }

  private attachEvents(connection: LcuConnection): void {
    this.eventStream?.close();
    this.eventStream = openEventStream(connection, {
      onEvent: (event) => {
        if (event.uri.includes('champ-select') || event.uri.includes('gameflow-phase')) {
          this.scheduleEventTick();
        }
      },
      onOpen: () => this.log('事件订阅已连接（进入选人阶段将立即刷新）'),
      onClose: (reason) => this.log(`事件订阅断开：${reason}`),
    });
  }

  private scheduleEventTick(): void {
    if (this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      void this.tick('event');
    }, 400);
  }

  private disconnect(): void {
    this.eventStream?.close();
    this.eventStream = undefined;
    this.api?.destroy();
    this.api = undefined;
    this.collector = undefined;
    this.connection = undefined;
    this.lastMembersKey = '';
    this.nextDiscoveryAt = 0;
  }

  private ensureCollector(api: LcuApi): ReportCollector {
    if (!this.collector) {
      this.collector = new ReportCollector(api, {
        recent: this.options.recent,
        ttlMs: this.options.ttlMs,
      });
    }
    return this.collector;
  }

  private patch(partial: Partial<Snapshot>, force = false): void {
    this.snapshot = { ...this.snapshot, ...partial, updatedAt: nowIso() };
    this.emit(force);
  }

  private emit(force: boolean): void {
    const fingerprint = JSON.stringify({ ...this.snapshot, updatedAt: undefined });
    if (!force && fingerprint === this.lastSerialized) return;
    this.lastSerialized = fingerprint;
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        /* 单个订阅者异常不影响其它订阅者 */
      }
    }
  }
}

export async function waitForClient(options: LiveSourceOptions = {}): Promise<LiveSource> {
  const source = new LiveSource(options);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await discoverConnection();
      break;
    } catch {
      await sleep(500);
    }
  }
  source.start();
  return source;
}
