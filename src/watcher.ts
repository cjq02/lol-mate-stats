import { randomUUID } from 'node:crypto';
import type {
  ArchiveCursor,
  AramChampionOption,
  ChampSelectMember,
  ChampSelectSession,
  EndOfGameStatsBlock,
  GameContext,
  GameModeKey,
  LcuConnection,
  LiveEvent,
  MatchDetail,
  MatchSummary,
  PlayerReport,
  RawGame,
  RawParticipant,
  RawStats,
  Snapshot,
  SummonerInfo,
} from './types.js';
import type { AssetResult, DataSource } from './source.js';
import { LcuApi } from './lcu/api.js';
import type { ChampionSummary } from './lcu/api.js';
import { ClientNotFoundError, discoverConnection } from './lcu/discover.js';
import { fetchEdgeMatchHistory, findEdgeUrl } from './lcu/edge.js';
import { openEventStream } from './lcu/events.js';
import { fetchLiveGame, liveMembersOf, sameLiveName } from './lcu/live.js';
import { analyzeParticipant, computeMatchScores, detectLane, matchBestTags } from './stats/analyze.js';
import { ReportCollector } from './stats/collector.js';
import { analyzeGame } from './stats/analyze.js';
import {
  archiveGames,
  countPlayerMatches,
  getChampionModeRecords,
  getPlayerChampionScores,
  getPlayerMatchTags,
  getPlayerMatches,
  getPlayerScores,
  getPlayerTimeStats,
  getPlayerWinRecord,
  getSavedSelfPuuid,
  saveSelfPuuid,
  type ArchivedMatch,
  type ChampionModeRecord,
  type PlayerMatchFilter,
} from './stats/archive.js';
import { currentQueueGroup, modeFromQueue, queueGroupName, queueName } from './stats/constants.js';
import { endOfGameEntries, endOfGameToRawGame, type EndOfGameIdentity } from './stats/eog.js';
import {
  afkParticipantIds,
  badLevelLabel,
  badLevelOfScore,
  gameFlagTags,
  gameFlags,
  isRemakeGame,
} from './stats/flags.js';
import { gradeOf } from './stats/rating.js';
import { premadeSizesByPuuid } from './stats/premade.js';
import { summarizeMatchSummaries, type TimeStatsSummary } from './stats/time-stats.js';
import { linkLiveAnalysisToGameByTime, getSavedMatchDetail, saveMatchDetail } from './stats/store.js';
import { nowIso, logTag, mapLimit, sleep, toNumber } from './util.js';

export interface LiveSourceOptions {
  recent?: number;
  pollMs?: number;
  /** 同一批队友在选人阶段的最长复用时间 */
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
  private readonly collectors = new Map<number, ReportCollector>();
  private connection?: LcuConnection;
  private edgeUrl?: string;
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
  /** 本局开黑分组：puuid -> 队伍人数 */
  private premadeSessionId = '';
  private premadeSizes = new Map<string, number>();
  /** 本局开始时记录的最新一局，用于赛后识别刚结束的对局 */
  private inGameSession?: {
    sessionId: string;
    puuid: string;
    previousLatestGameId: number;
  };
  /** 离开对局后等待预热的对局（战绩列表可能有延迟，需要重试） */
  private postGame?: {
    puuid: string;
    previousLatestGameId: number;
    createdAt: number;
    nextAttemptAt: number;
  };
  /** 刚结束、战绩列表还没同步的对局：由结算数据生成，可立即展示 */
  private readonly provisionalGames = new Map<number, { game: RawGame; at: number }>();
  private eogCaptureInFlight = false;
  private eogCapturedGameId = 0;
  /** 本局开始前的最新对局 ID，用来过滤结算接口里上一局的旧数据 */
  private gameEndBaseline = 0;
  private prewarmInFlight = false;
  private prewarmedGameId = 0;
  private lastPhase = 'None';
  /** 记录“本局之前最新一局”的重试时间，避免对局开始时阻塞界面 */
  private inGameRecordAt = 0;
  /** 大乱斗可选英雄的缓存键，避免每轮 tick 都查数据库 */
  private aramOptionsKey = '';
  private aramRefreshInFlight = false;

  constructor(options: LiveSourceOptions = {}) {
    this.options = {
      recent: options.recent ?? 10,
      pollMs: options.pollMs ?? 3_000,
      ttlMs: options.ttlMs ?? 24 * 60 * 60_000,
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
    for (const collector of this.collectors.values()) collector.clearCache();
    const api = this.api;
    const session = api ? await api.getChampSelectSession().catch(() => null) : null;
    if (api && session?.myTeam?.length) {
      const context = await this.resolveContext(api);
      await this.collect(api, session, context);
    } else {
      await this.tick('event');
    }
  }

  /** 手动清空所有缓存；下次读取会重新拉取 */
  clearCache(): void {
    for (const collector of this.collectors.values()) collector.clearCache();
    this.lastMembersKey = '';
    this.lastCollectAt = 0;
    logTag('match', '已清空战绩缓存');
  }

  async getAsset(path: string): Promise<AssetResult | null> {
    if (!this.api) return null;
    return this.api.getAsset(path);
  }

  /** 页面上的“查询玩家”入口：按名字查任意玩家的近期战绩 */
  async scanPlayer(name: string, recent: number): Promise<PlayerReport[]> {
    const api = await this.ensureApi();
    if (!api) throw new ClientNotFoundError('未检测到正在运行的英雄联盟客户端');

    const summoner = await api.getSummonerByName(name);
    if (!summoner) throw new Error(`未找到召唤师：${name}`);

    const session: ChampSelectSession = {
      localPlayerCellId: 0,
      myTeam: [
        {
          cellId: 0,
          summonerId: summoner.summonerId,
          puuid: summoner.puuid,
          championId: 0,
          team: 1,
        },
      ],
    };
    const collector = this.ensureCollector(api, recent);
    return collector.collect(session);
  }

  /** 强制更新单个玩家的报告缓存，用于战绩列表里的「更新」按钮 */
  async refreshPlayer(
    summonerId: number,
    options: { recent?: number; context?: GameContext } = {},
  ): Promise<PlayerReport> {
    const api = await this.ensureApi();
    if (!api) throw new ClientNotFoundError('未检测到正在运行的英雄联盟客户端');

    const summoner = await api.getSummonerById(summonerId);
    if (!summoner?.summonerId) throw new Error(`未找到召唤师：${summonerId}`);

    const rawRecent = options.recent ?? this.options.recent;
    const recent = Math.min(30, Math.max(1, Math.trunc(rawRecent)));
    // 所有 recent 值对应不同 collector，内存缓存都要失效，避免换个入口又读到旧数据
    for (const collector of this.collectors.values()) {
      collector.invalidateReport(summoner.summonerId);
    }

    const session: ChampSelectSession = {
      localPlayerCellId: 0,
      myTeam: [
        {
          cellId: 0,
          summonerId: summoner.summonerId,
          puuid: summoner.puuid,
          championId: 0,
          team: 1,
        },
      ],
    };
    const collector = this.ensureCollector(api, recent);
    const reports = await collector.collect(session, undefined, options.context, {
      force: true,
    });
    const report = reports[0];
    if (!report) {
      throw new Error(
        `未读取到 ${summoner.gameName ?? summoner.displayName ?? summonerId} 的战绩`,
      );
    }
    logTag('match', `已更新玩家战绩：${report.displayName}（最近 ${recent} 场）`);
    return report;
  }

  /** 当前账号最近对局列表；offset 用于继续往前翻页 */
  async getMyMatches(
    recent: number,
    offset = 0,
  ): Promise<{ summoner: SummonerInfo; games: MatchSummary[] }> {
    const started = Date.now();
    const api = await this.ensureApi();
    if (!api) throw new ClientNotFoundError('未检测到正在运行的英雄联盟客户端');

    const summoner = await api.getCurrentSummoner();
    const puuid = summoner.puuid;
    if (!puuid) throw new Error('无法读取当前账号的 puuid');
    await saveSelfPuuid(puuid);

    logTag(
      'match',
      offset > 0
        ? `读取我的战绩第 ${offset + 1}-${offset + recent} 场…`
        : `读取我的最近 ${recent} 场战绩…`,
    );
    let rawGames: RawGame[] | undefined;
    if (offset > 0) {
      try {
        rawGames = await this.getMyMatchPageFromEdge(api, puuid, offset, recent);
      } catch (error) {
        this.edgeUrl = undefined;
        logTag(
          'match',
          `战绩 edge 翻页失败，回退客户端接口：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (!rawGames) {
      try {
        rawGames = await api.getMatchListByPuuid(puuid, recent, offset);
      } catch (error) {
        logTag(
          'match',
          `读取我的战绩失败：${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }
    // 刚结束的对局：客户端战绩列表可能还没同步，先用结算数据补在最前面
    if (offset === 0) {
      const provisional = this.takeProvisionalGame(rawGames);
      if (provisional) {
        rawGames = [...rawGames, provisional].sort(
          (a, b) => toNumber(b.gameCreation) - toNumber(a.gameCreation),
        );
      }
    }
    const championMap = await api.getChampionMap().catch(() => new Map());
    const games = rawGames
      .map((game) => {
        const participant = participantOf(game, puuid);
        const stats = statsOf(participant);
        const championId = toNumber(participant?.championId);
        const rawDuration = toNumber(game.gameDuration);
        const flags = gameFlags(
          game,
          participant ? toNumber(participant.participantId) : undefined,
          championMap,
        );
        return {
          gameId: toNumber(game.gameId),
          queueId: toNumber(game.queueId),
          queueName: queueName(toNumber(game.queueId)),
          gameMode: typeof game.gameMode === 'string' ? game.gameMode : undefined,
          gameCreation: toNumber(game.gameCreation),
          gameDuration: rawDuration > 100_000 ? Math.round(rawDuration / 1000) : rawDuration,
          championId,
          championName: championMap.get(championId)?.name,
          position: participant ? detectLane(game, participant) : undefined,
          win: stats.win === true || stats.win === 1,
          kills: toNumber(stats.kills),
          deaths: toNumber(stats.deaths),
          assists: toNumber(stats.assists),
          tags: gameFlagTags(flags),
        };
      })
      .filter((game) => game.gameId > 0);

    // 读取/补算每场评分；还没归档的对局会顺便写入历史存档。
    // 客户端列表接口通常只返回自己这一行，队友/对手的坑和逃跑标记必须用完整对局补算。
    const { scores, tags: detailTags } = await this.fillMissingScores(
      api,
      games,
      championMap,
      summoner,
    );
    const archivedTags = await getPlayerMatchTags(
      puuid,
      games.map((game) => game.gameId),
    );
    const scored = games.map((game) => ({
      ...game,
      score: scores.get(game.gameId),
      tags: archivedTags.get(game.gameId) ?? detailTags.get(game.gameId) ?? game.tags,
    }));

    logTag(
      'match',
      `我的战绩读取完成：${scored.length} 场（含评分），用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    return { summoner, games: scored };
  }

  /** 从 Player Platform Edge 读取“我的战绩”的下一页（LCU 的 products 接口不认分页参数） */
  private async getMyMatchPageFromEdge(
    api: LcuApi,
    puuid: string,
    offset: number,
    count: number,
  ): Promise<RawGame[] | undefined> {
    if (!this.edgeUrl) {
      this.edgeUrl = await findEdgeUrl(this.connection);
      if (this.edgeUrl) logTag('match', `战绩翻页使用 edge：${this.edgeUrl}`);
    }
    if (!this.edgeUrl) return undefined;

    const authorization = await api.http.get<{ token?: string }>(
      '/lol-rso-auth/v1/authorization/access-token',
      8_000,
    );
    const token = authorization?.token;
    if (!token) return undefined;
    return fetchEdgeMatchHistory(this.edgeUrl, token, puuid, offset, count);
  }

  /** 某场对局里 10 名玩家的近期战绩 */
  async getMatchDetail(
    gameId: number,
    recent: number,
    onProgress?: (done: number, total: number, name: string) => void,
    options: { force?: boolean; onScoreboard?: (detail: MatchDetail) => void } = {},
  ): Promise<MatchDetail> {
    const started = Date.now();
    if (!options.force) {
      const cached = await getSavedMatchDetail(gameId);
      if (cached) {
        logTag('match', `[${gameId}] 命中对局详情缓存，直接返回`);
        options.onScoreboard?.(cached);
        return cached;
      }
    }
    const api = await this.ensureApi();
    if (!api) throw new ClientNotFoundError('未检测到正在运行的英雄联盟客户端');

    logTag('match', `[${gameId}] 开始读取对局详情（每人最近 ${recent} 场）`);
    const summoner = await api.getCurrentSummoner();
    await saveSelfPuuid(summoner.puuid ?? '');
    let game;
    try {
      game = await api.getGame(gameId);
    } catch (error) {
      // 战绩列表/详情服务还没同步时，用刚才结算数据生成的对局兜底
      const provisional = this.provisionalGames.get(gameId)?.game;
      if (!provisional) {
        logTag(
          'match',
          `[${gameId}] 读取对局失败：${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      logTag('match', `[${gameId}] 战绩详情尚未同步，改用结算数据打开`);
      game = provisional;
    }

    const queueId = toNumber(game.queueId);
    const gameMode = modeFromQueue(queueId, game.gameMode);
    const participants = game.participants?.length ?? 0;
    const rawGameDuration = toNumber(game.gameDuration);
    const durationSeconds =
      rawGameDuration > 100_000 ? Math.round(rawGameDuration / 1000) : rawGameDuration;
    const gameCreation = toNumber(game.gameCreation);
    // 进行中的 AI 分析不知道 gameId，赛后按对局时间窗口补做关联
    if (gameCreation > 0) {
      await linkLiveAnalysisToGameByTime(gameId, gameCreation, durationSeconds);
    }
    logTag(
      'match',
      `[${gameId}] ${queueName(queueId)}，${participants} 名玩家，开始并发读取战绩`,
    );

    const championMap = await api.getChampionMap().catch(() => new Map());
    const identities = game.participantIdentities ?? [];
    const selfIdentity = identities.find((item) => item.player?.puuid === summoner.puuid);
    const selfParticipant = (game.participants ?? []).find(
      (item) => toNumber(item.participantId) === toNumber(selfIdentity?.participantId),
    );
    const allyTeam =
      toNumber(selfParticipant?.teamId) || toNumber((game.participants ?? [])[0]?.teamId);
    const selfParticipantId = selfParticipant
      ? toNumber(selfParticipant.participantId)
      : undefined;
    const scoreMap = computeMatchScores(game, championMap);
    const afkIds = afkParticipantIds(game, championMap, scoreMap);
    const remake = isRemakeGame(game);
    const bestTags = remake ? new Map<number, string>() : matchBestTags(game, scoreMap);

    const scoreboard = (game.participants ?? [])
      .map((participant) => {
        const identity = identities.find(
          (item) => toNumber(item.participantId) === toNumber(participant.participantId),
        );
        const player = identity?.player;
        const stats = participant.stats ?? {};
        const championId = toNumber(participant.championId);
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
        const cs =
          toNumber(stats.totalMinionsKilled) + toNumber(stats.neutralMinionsKilled) ||
          toNumber(stats.minionsKilled);
        const name = player?.gameName
          ? `${player.gameName}${player.tagLine ? `#${player.tagLine}` : ''}`
          : String(player?.summonerName ?? `玩家 ${participant.participantId}`);
        const analyzed = analyzeParticipant(game, participant, championMap, scoreMap);
        const rawDuration = toNumber(game.gameDuration);
        const durationSeconds = rawDuration > 100_000 ? rawDuration / 1000 : rawDuration;
        const durationMin =
          analyzed?.durationMin || (durationSeconds > 0 ? Math.round(durationSeconds / 60) : 0);
        const perMin = (value: number): number =>
          durationMin > 0 ? Math.round(value / durationMin) : 0;
        const participantId = toNumber(participant.participantId);
        const afk = participantId !== selfParticipantId && afkIds.has(participantId);
        const badLevel =
          !afk && !remake && participantId !== selfParticipantId
            ? badLevelOfScore(analyzed?.score)
            : undefined;
        const tags = afk
          ? ['逃跑', ...(analyzed?.tags ?? [])]
          : badLevel
            ? [badLevelLabel(badLevel), ...(analyzed?.tags ?? [])]
            : analyzed?.tags;
        const bestTag = bestTags.get(participantId);
        const finalTags = bestTag
          ? [
              bestTag,
              ...(tags ?? []).filter((tag) => tag !== 'MVP' && tag !== 'SVP'),
            ]
          : tags;

        return {
          puuid: typeof player?.puuid === 'string' ? player.puuid : undefined,
          name,
          championId,
          championName: championMap.get(championId)?.name,
          teamId: toNumber(participant.teamId),
          isEnemy: toNumber(participant.teamId) !== allyTeam,
          position,
          kills: toNumber(stats.kills),
          deaths: toNumber(stats.deaths),
          assists: toNumber(stats.assists),
          cs,
          gold: toNumber(stats.goldEarned),
          damage: toNumber(stats.totalDamageDealtToChampions),
          damageTaken: toNumber(stats.totalDamageTaken),
          heal: toNumber(stats.totalHeal),
          vision: toNumber(stats.visionScore),
          win: stats.win === true || stats.win === 1,
          items: [
            stats.item0,
            stats.item1,
            stats.item2,
            stats.item3,
            stats.item4,
            stats.item5,
            stats.item6,
          ]
            .map((item) => toNumber(item))
            .filter((item) => item > 0),
          durationMin,
          score: analyzed?.score,
          grade: analyzed ? gradeOf(analyzed.score) : undefined,
          damageShare: analyzed?.damageShare,
          tankShare: analyzed?.tankShare,
          killParticipation: analyzed?.killParticipation,
          csPerMin: analyzed?.csPerMin,
          goldPerMin: perMin(toNumber(stats.goldEarned)),
          damagePerMin: analyzed?.damagePerMin,
          damageTakenPerMin: perMin(toNumber(stats.totalDamageTaken)),
          visionPerMin: analyzed?.visionPerMin,
          badLevel,
          tags: finalTags,
          timeline: analyzed?.timeline,
        };
      })
      .filter((player) => player.championId > 0)
      .sort((a, b) => Number(a.isEnemy) - Number(b.isEnemy));

    const afkPlayers = scoreboard
      .filter((player) => player.tags?.includes('逃跑'))
      .map((player) => ({
        puuid: player.puuid,
        name: player.name,
        championId: player.championId,
        championName: player.championName,
        teamId: player.teamId,
        isEnemy: player.isEnemy,
        position: player.position,
      }));
    const badPlayers = scoreboard
      .filter((player) => player.badLevel)
      .map((player) => ({
        puuid: player.puuid,
        name: player.name,
        championId: player.championId,
        championName: player.championName,
        teamId: player.teamId,
        isEnemy: player.isEnemy,
        position: player.position,
        badLevel: player.badLevel,
        score: player.score,
      }));

    const collector = this.ensureCollector(api, recent);
    collector.setSelfPuuid(summoner.puuid);
    const flags = gameFlags(
      game,
      selfParticipant ? toNumber(selfParticipant.participantId) : undefined,
      championMap,
      scoreMap,
    );
    const rawDuration = toNumber(game.gameDuration);
    const normalizedDuration =
      rawDuration > 100_000 ? Math.round(rawDuration / 1000) : rawDuration;
    const baseDetail: MatchDetail = {
      gameId,
      queueId,
      queueName: queueName(queueId),
      gameMode,
      gameCreation: toNumber(game.gameCreation),
      gameDuration: normalizedDuration,
      selfPuuid: summoner.puuid,
      players: [],
      scoreboard,
      tags: gameFlagTags(flags),
      afkPlayers,
      badPlayers,
    };

    // 先返回本局双方数据，让前端立刻渲染；近期战绩继续在后台读取
    options.onScoreboard?.(baseDetail);
    onProgress?.(0, participants, '');
    try {
      const players = await collector.collectMatch(
        game,
        summoner.puuid ?? '',
        { queueId, mode: gameMode },
        (done, total, name) => {
          logTag('match', `[${gameId}] ${done}/${total} ${name} 完成`);
          onProgress?.(done, total, name);
        },
        { force: options.force },
      );
      logTag(
        'match',
        `[${gameId}] 全部完成：${players.length} 人，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );

      const detail: MatchDetail = { ...baseDetail, players };
      await saveMatchDetail(detail);
      return detail;
    } catch (error) {
      logTag(
        'match',
        `[${gameId}] 读取失败（已用时 ${((Date.now() - started) / 1000).toFixed(1)}s）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  /** 读取或补算“我的战绩”每场的评分，并用完整对局补算坑/逃跑标记 */
  private async fillMissingScores(
    api: LcuApi,
    games: MatchSummary[],
    championMap: Map<number, ChampionSummary>,
    summoner: SummonerInfo,
  ): Promise<{ scores: Map<number, number>; tags: Map<number, string[]> }> {
    const scores = await getPlayerScores(
      summoner.puuid ?? '',
      games.map((game) => game.gameId),
    );
    const tags = new Map<number, string[]>();
    const missing = games.filter((game) => game.gameId > 0 && !scores.has(game.gameId));
    if (!missing.length) return { scores, tags };

    logTag('archive', `正在计算 ${missing.length} 场对局的评分…`);
    let done = 0;
    await mapLimit(missing, 3, async (game) => {
      const detail = await api.getGame(game.gameId).catch(() => null);
      if (detail) {
        await archiveGames([detail], championMap);
        const scoreMap = computeMatchScores(detail, championMap);
        const bestTags = isRemakeGame(detail)
          ? new Map<number, string>()
          : matchBestTags(detail, scoreMap);
        const analyzed = analyzeGame(
          detail,
          {
            puuid: summoner.puuid,
            summonerId: summoner.summonerId,
            accountId: summoner.accountId,
          },
          championMap,
          scoreMap,
        );
        if (analyzed) scores.set(game.gameId, analyzed.score);
        const selfParticipant = participantOf(detail, summoner.puuid ?? '');
        const selfParticipantId = selfParticipant
          ? toNumber(selfParticipant.participantId)
          : undefined;
        const flags = gameFlags(
          detail,
          selfParticipantId,
          championMap,
          scoreMap,
        );
        const bestTag =
          selfParticipantId === undefined ? undefined : bestTags.get(selfParticipantId);
        tags.set(game.gameId, [
          ...(bestTag ? [bestTag] : []),
          ...gameFlagTags(flags),
        ]);
      }
      done += 1;
      if (done === missing.length) logTag('archive', `评分计算完成：${done} 场`);
    });
    return { scores, tags };
  }

  /** 长期存档：查询某个玩家（默认自己）的历史对局 */
  async getArchivedMatches(
    limit: number,
    offset: number,
    puuid?: string,
    filter: PlayerMatchFilter = {},
  ): Promise<{
    puuid: string;
    total: number;
    games: ArchivedMatch[];
    nextCursor?: ArchiveCursor;
  }> {
    const id = await this.resolveArchivePuuid(puuid);
    if (!id) return { puuid: '', total: 0, games: [] };
    const total = await countPlayerMatches(id, filter);
    const page = await getPlayerMatches(id, limit, offset, filter);
    return { puuid: id, total, games: page.games, nextCursor: page.nextCursor };
  }

  /** 长期存档：某个玩家（默认自己）各英雄的平均单场评分排名 */
  async getArchivedChampionScores(
    puuid?: string,
    minGames = 1,
    mode?: GameModeKey,
  ): Promise<{
    puuid: string;
    champions: Awaited<ReturnType<typeof getPlayerChampionScores>>;
  }> {
    const id = await this.resolveArchivePuuid(puuid);
    if (!id) return { puuid: '', champions: [] };
    return { puuid: id, champions: await getPlayerChampionScores(id, minGames, mode) };
  }

  /** 长期存档：某个玩家（默认自己）在指定模式/队列组或指定英雄的总胜负 */
  async getArchivedWinRecord(
    puuid: string | undefined,
    queueId: number | undefined,
    mode: GameModeKey | undefined,
    championId?: number,
  ): Promise<{
    puuid: string;
    group: string;
    groupName: string;
    record: Awaited<ReturnType<typeof getPlayerWinRecord>>;
  }> {
    const id = await this.resolveArchivePuuid(puuid);
    const hasContext = queueId !== undefined || mode !== undefined;
    const group = hasContext ? currentQueueGroup(queueId, mode) : undefined;
    const groupName = !group
      ? '全部模式'
      : group === 'sr'
        ? '召唤师峡谷'
        : queueGroupName(group, queueId);
    const record = id
      ? await getPlayerWinRecord(id, group, championId)
      : { games: 0, wins: 0, losses: 0, winRate: 0 };
    return { puuid: id, group: group ?? 'all', groupName, record };
  }

  /** 长期存档：某个玩家（默认自己）按一天内时段统计的胜率与坑率 */
  async getArchivedTimeStats(
    puuid?: string,
    mode?: GameModeKey,
  ): Promise<{
    puuid: string;
    source: 'archive' | 'recent' | 'none';
    stats: TimeStatsSummary;
  }> {
    const id = await this.resolveArchivePuuid(puuid);
    if (id) {
      const stats = await getPlayerTimeStats(id, mode);
      if (stats.totalGames > 0) return { puuid: id, source: 'archive', stats };
    }

    // 没有历史存档时退回客户端最近 100 场，保证新环境也能看到时段分布
    if (!puuid) {
      try {
        const recent = await this.getMyMatches(100, 0);
        const stats = summarizeMatchSummaries(recent.games, mode);
        return {
          puuid: recent.summoner.puuid ?? id,
          source: stats.totalGames ? 'recent' : 'none',
          stats,
        };
      } catch {
        /* 客户端不可用时保持空结果 */
      }
    }
    return { puuid: id, source: 'none', stats: await getPlayerTimeStats('', mode) };
  }

  private async resolveArchivePuuid(puuid?: string): Promise<string> {
    let id = puuid?.trim() || (await getSavedSelfPuuid()) || '';
    if (!id) {
      const api = await this.ensureApi();
      const summoner = await api?.getCurrentSummoner().catch(() => null);
      id = summoner?.puuid ?? '';
      if (id) await saveSelfPuuid(id);
    }
    return id;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventStream?.close();
    this.eventStream = undefined;
    const collectors = [...this.collectors.values()];
    this.collectors.clear();
    await Promise.all(collectors.map((collector) => collector.flush()));
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
        this.lastPhase = 'None';
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

      const previousPhase = this.lastPhase;
      this.lastPhase = phase;
      if (previousPhase === 'InProgress' && phase !== 'InProgress') {
        this.schedulePostGamePrewarm();
      }
      // 结算界面数据比战绩列表更新快；拿到后可以立刻显示刚结束的对局
      if (phase === 'WaitingForStats' || phase === 'PreEndOfGame' || phase === 'EndOfGame') {
        void this.captureEndOfGame(api);
      }
      // 赛后预热不阻塞阶段切换，战绩列表没更新时下一轮继续重试
      if (this.postGame) void this.maybePrewarmFinishedGame(api);

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
        void this.refreshAramChampions(api, session);
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
        gameTime: undefined,
        liveSessionId: undefined,
        liveEvents: undefined,
        aramChampions: undefined,
        error: undefined,
      },
      false,
    );
    this.aramOptionsKey = '';
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
    const liveSessionId = this.snapshot.liveSessionId ?? randomUUID();

    const game = await fetchLiveGame();
    if (!game) {
      // 还在加载界面时 2999 端口尚未就绪
      this.patch({
        phase: 'InProgress',
        inChampSelect: false,
        inGame: true,
        liveSessionId,
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
    if (self && game.activePlayer) self.active = game.activePlayer;
    if (!members.length) {
      this.patch({
        phase: 'InProgress',
        inChampSelect: false,
        inGame: true,
        liveSessionId,
        collecting: false,
        message: '游戏进行中，等待对局数据…',
      });
      return;
    }

    const queueId = game.gameData?.queue?.id ?? this.snapshot.queueId;
    const gameMode =
      modeFromQueue(queueId, game.gameData?.gameMode) ?? this.snapshot.gameMode;
    const gameTime = toNumber(game.gameData?.gameTime) || undefined;
    const context: GameContext | undefined =
      queueId !== undefined || gameMode !== undefined ? { queueId, mode: gameMode } : undefined;
    const initialCollection = this.snapshot.players.length === 0;
    if (initialCollection) this.postGame = undefined;
    // 记录“这局之前的最新一局”，赛后用它识别刚结束的对局；
    // 放到后台执行，读不到时 10 秒后重试，不阻塞本局数据
    if (!this.inGameSession || this.inGameSession.sessionId !== liveSessionId) {
      if (Date.now() >= this.inGameRecordAt) {
        this.inGameRecordAt = Date.now() + 10_000;
        void this.recordInGameSession(api, liveSessionId);
      }
    }
    let loggedLoaded = 0;

    this.busy = true;
    this.patch({
      phase: 'InProgress',
      inChampSelect: false,
      inGame: true,
      liveSessionId,
      queueId,
      gameMode,
      gameTime,
      liveEvents: liveEventList(game.events?.Events),
      collecting: this.snapshot.players.length === 0,
      message: this.snapshot.players.length ? undefined : '正在读取本局 10 名玩家的战绩…',
      error: undefined,
    });
    if (initialCollection) {
      logTag(
        'match',
        `本局开始读取 ${members.length} 名玩家（每人最近 ${this.options.recent} 场）…`,
      );
    }

    try {
      const collector = this.ensureCollector(api);
      // 开黑分组在一局内不会变化，按对局会话缓存；拿不到时下个 tick 再试
      if (this.premadeSessionId !== liveSessionId) {
        const flow = await api.getGameflowSession().catch(() => null);
        if (flow?.gameData) {
          this.premadeSizes = premadeSizesByPuuid([
            flow.gameData.teamOne,
            flow.gameData.teamTwo,
          ]);
          this.premadeSessionId = liveSessionId;
        }
      }
      const applyPremade = (list: PlayerReport[]) => {
        for (const report of list) {
          const size = report.puuid ? this.premadeSizes.get(report.puuid) : undefined;
          if (size && size >= 2) report.premadeSize = size;
          else delete report.premadeSize;
        }
      };
      const reports = await collector.collectLive(
        members,
        (partial) => {
          applyPremade(partial);
          const loaded = partial.filter((player) => !player.loading).length;
          if (initialCollection && loaded > loggedLoaded) {
            loggedLoaded = loaded;
            logTag('match', `本局 ${loaded}/${partial.length} 名玩家完成`);
          }
          this.patch({ players: partial, collecting: partial.some((player) => player.loading) });
        },
        context,
        gameTime,
      );

      applyPremade(reports);
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
      if (initialCollection) {
        logTag('match', `本局数据完成：${reports.length} 名玩家`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTag('match', `本局数据读取失败：${message}`);
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
    let loggedLoaded = 0;
    logTag(
      'match',
      `选人阶段开始读取 ${session.myTeam.length} 名队友（每人最近 ${this.options.recent} 场）…`,
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
    // 大乱斗替补席随时可能刷新，放到后台读取，不阻塞队友卡片
    void this.refreshAramChampions(api, session, context);

    try {
      const collector = this.ensureCollector(api);
      collector.setSelfPuuid(localMember?.puuid);
      // 选人阶段用大厅成员识别开黑；对局中大厅接口会失效，改用 gameflow 分组
      const lobbyMembers = await api.getLobbyMembers().catch(() => null);
      const partySize = Array.isArray(lobbyMembers) ? lobbyMembers.length : 0;
      const partyPuuids = new Set(
        (lobbyMembers ?? []).map((member) => member.puuid).filter(Boolean),
      );
      const partySummonerIds = new Set(
        (lobbyMembers ?? [])
          .map((member) => Number(member.summonerId))
          .filter((id) => Number.isFinite(id) && id > 0),
      );
      const applyPremade = (list: PlayerReport[]) => {
        for (const report of list) {
          const inParty =
            partySize >= 2 &&
            Boolean(
              (report.puuid && partyPuuids.has(report.puuid)) ||
                (report.summonerId && partySummonerIds.has(report.summonerId)),
            );
          if (inParty) report.premadeSize = partySize;
          else delete report.premadeSize;
        }
      };
      const reports = await collector.collect(
        session,
        (partial) => {
          applyPremade(partial);
          const loaded = partial.filter((player) => !player.loading).length;
          if (loaded > loggedLoaded) {
            loggedLoaded = loaded;
            logTag('match', `选人阶段 ${loaded}/${partial.length} 名队友完成`);
          }
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

      applyPremade(reports);
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
      logTag('match', `选人阶段读取完成：${reports.length} 名队友`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTag('match', `选人阶段读取失败：${message}`);
      this.patch({ collecting: false, error: `读取队友战绩失败：${message}` });
    } finally {
      this.busy = false;
    }
  }

  /**
   * 大乱斗选人阶段：列出当前英雄 + 替补席英雄，并补上
   * “本地存档整体胜率”和“我的胜率 / 场次”。
   */
  private async refreshAramChampions(
    api: LcuApi,
    session: ChampSelectSession,
    context?: GameContext,
  ): Promise<void> {
    if (this.aramRefreshInFlight) return;
    const mode = context?.mode ?? this.snapshot.gameMode;
    if (mode !== 'ARAM' || !this.snapshot.inChampSelect) {
      if (this.snapshot.aramChampions) this.patch({ aramChampions: undefined });
      this.aramOptionsKey = '';
      return;
    }

    const localMember = session.myTeam?.find(
      (member) => member.cellId === session.localPlayerCellId,
    );
    const currentId = toNumber(localMember?.championId) || toNumber(localMember?.championPickIntent);
    const bench = Array.isArray(session.benchChampions) ? session.benchChampions : [];
    const benchIds = bench
      .map((entry) => toNumber(entry.championId))
      .filter((id) => id > 0);
    const ids = [...new Set([currentId, ...benchIds].filter((id) => id > 0))];
    if (!ids.length) {
      if (this.snapshot.aramChampions) this.patch({ aramChampions: undefined });
      return;
    }

    const key = `${localMember?.puuid ?? ''}:${currentId}:${[...ids]
      .sort((a, b) => a - b)
      .join(',')}`;
    if (key === this.aramOptionsKey && this.snapshot.aramChampions?.length) return;

    this.aramRefreshInFlight = true;
    try {
      const [mine, overall, championMap] = await Promise.all([
        localMember?.puuid
          ? getChampionModeRecords(ids, 'ARAM', localMember.puuid)
          : Promise.resolve(new Map<number, ChampionModeRecord>()),
        getChampionModeRecords(ids, 'ARAM'),
        api.getChampionMap().catch(() => new Map()),
      ]);

      const priority = new Set(
        bench
          .filter((entry) => entry.isPriority)
          .map((entry) => toNumber(entry.championId)),
      );
      const options: AramChampionOption[] = ids.map((championId) => {
        const personal = mine.get(championId);
        const global = overall.get(championId);
        return {
          championId,
          championName: championMap.get(championId)?.name ?? `英雄 ${championId}`,
          isCurrent: championId === currentId,
          isPriority: priority.has(championId) || undefined,
          games: personal?.games ?? 0,
          wins: personal?.wins ?? 0,
          winRate: personal?.winRate ?? 0,
          avgScore: personal?.avgScore ?? 0,
          globalGames: global?.games ?? 0,
          globalWinRate: global?.winRate ?? 0,
        };
      });
      // 当前英雄排最前，其余保持替补席顺序
      options.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));

      this.aramOptionsKey = key;
      this.patch({ aramChampions: options });
      logTag('match', `大乱斗可选英雄已更新：${options.length} 个`);
    } catch {
      // 读取失败时保留上一份数据，下次 tick 重试
    } finally {
      this.aramRefreshInFlight = false;
    }
  }

  private updateSessionChampions(session: ChampSelectSession): void {
    if (!this.snapshot.players.length) return;
    const bySummoner = new Map<number, ChampSelectMember>(
      session.myTeam.map((member) => [member.summonerId, member]),
    );
    let changed = false;
    const collector = this.collectors.get(this.options.recent);
    const players = this.snapshot.players.map((player) => {
      const member = bySummoner.get(player.summonerId);
      if (!member) return player;
      const championId = member.championId || member.championPickIntent || 0;
      if (player.championId !== (championId || undefined)) {
        changed = true;
        return {
          ...player,
          championId: championId || undefined,
          championName: collector?.championName(championId) ?? player.championName,
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

  /**
   * 对局开始时记录“这局之前的最新一局”。
   * 赛后战绩列表出现新 ID 时，就能准确识别刚结束的对局，而不是盲目预热第一场。
   */
  private async recordInGameSession(api: LcuApi, sessionId: string): Promise<void> {
    if (this.inGameSession?.sessionId === sessionId) return;
    try {
      const summoner = await api.getCurrentSummoner();
      if (!summoner.puuid) return;
      let previousLatestGameId = 0;
      try {
        const games = await api.getMatchListByPuuid(summoner.puuid, 1);
        previousLatestGameId = toNumber(games[0]?.gameId) || 0;
      } catch {
        // 记不到旧 ID 时记为 0，赛后仍可按对局时间兜底
      }
      // 读取期间可能已经离开对局，避免把上一局的信息写到下一局
      if (this.snapshot.liveSessionId !== sessionId) return;
      if (this.inGameSession?.sessionId !== sessionId) {
        this.inGameSession = {
          sessionId,
          puuid: summoner.puuid,
          previousLatestGameId,
        };
      }
    } catch {
      // 读不到当前账号时跳过赛后预热，不影响对局中数据
    }
  }

  private schedulePostGamePrewarm(): void {
    const session = this.inGameSession;
    this.inGameSession = undefined;
    if (!session) return;
    this.gameEndBaseline = session.previousLatestGameId;
    this.postGame = {
      puuid: session.puuid,
      previousLatestGameId: session.previousLatestGameId,
      createdAt: Date.now(),
      nextAttemptAt: Date.now(),
    };
  }

  /**
   * 赛后预热：等战绩列表出现刚结束的对局后，主动生成并保存对局详情。
   * 用户回到大厅再点开这局时会直接命中 match_details 缓存。
   */
  private async maybePrewarmFinishedGame(api: LcuApi): Promise<void> {
    const pending = this.postGame;
    if (!pending || this.prewarmInFlight) return;
    if (Date.now() - pending.createdAt > 3 * 60_000) {
      this.postGame = undefined;
      return;
    }
    if (Date.now() < pending.nextAttemptAt) return;

    this.prewarmInFlight = true;
    try {
      const games = await api.getMatchListByPuuid(pending.puuid, 1).catch(() => []);
      const newest = games[0];
      const gameId = toNumber(newest?.gameId) || 0;
      if (!gameId) {
        // 战绩列表还没更新，过几秒再试
        pending.nextAttemptAt = Date.now() + 5_000;
        return;
      }

      const created = toNumber(newest?.gameCreation) || 0;
      const isNewGame =
        pending.previousLatestGameId > 0
          ? gameId > pending.previousLatestGameId
          : created > pending.createdAt - 3 * 60 * 60_000;
      if (!isNewGame) {
        pending.nextAttemptAt = Date.now() + 5_000;
        return;
      }

      if (gameId === this.prewarmedGameId || (await getSavedMatchDetail(gameId))) {
        this.prewarmedGameId = gameId;
        this.postGame = undefined;
        return;
      }

      logTag('match', `[${gameId}] 赛后自动预热对局详情…`);
      await this.getMatchDetail(gameId, this.options.recent);
      this.prewarmedGameId = gameId;
      this.postGame = undefined;
      logTag('match', `[${gameId}] 赛后预热完成`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTag('match', `赛后预热失败，稍后重试：${message}`);
      pending.nextAttemptAt = Date.now() + 10_000;
    } finally {
      this.prewarmInFlight = false;
    }
  }

  /**
   * 本局刚结束时抢先读取结算数据，写入存档并暂存起来。
   * 这样客户端战绩列表还没同步时，「我的战绩」和「最近一局」也能立刻看到这局。
   */
  private async captureEndOfGame(api: LcuApi): Promise<void> {
    if (this.eogCaptureInFlight || this.stopped) return;
    this.eogCaptureInFlight = true;
    try {
      const deadline = Date.now() + 45_000;
      while (!this.stopped && Date.now() < deadline) {
        const block = await api.getEndOfGameStats().catch(() => null);
        const blockGameId = toNumber(block?.gameId);
        // 已经处理过本局，或结算接口还停留在上一局时，等待下一轮
        if (blockGameId && blockGameId === this.eogCapturedGameId) return;
        if (blockGameId && this.gameEndBaseline > 0 && blockGameId <= this.gameEndBaseline) {
          await sleep(2_000);
          continue;
        }
        const game = await this.eogToRawGame(api, block);
        if (game) {
          const gameId = toNumber(game.gameId);
          if (gameId) {
            this.eogCapturedGameId = gameId;
            this.provisionalGames.set(gameId, { game, at: Date.now() });
            this.pruneProvisionalGames();
            const championMap = await api.getChampionMap().catch(() => new Map());
            await archiveGames([game], championMap);
            logTag('match', `[${gameId}] 已用结算数据提前写入战绩`);
          }
          return;
        }
        await sleep(2_000);
      }
    } finally {
      this.eogCaptureInFlight = false;
    }
  }

  /** 结算数据里的玩家没有 puuid 时，按 summonerId 补齐后才能写入存档 */
  private async eogToRawGame(
    api: LcuApi,
    block: EndOfGameStatsBlock | null,
  ): Promise<RawGame | undefined> {
    if (!block) return undefined;
    const entries = endOfGameEntries(block);
    if (entries.length < 2) return undefined;

    const resolved = await mapLimit(
      entries,
      5,
      async (entry): Promise<EndOfGameIdentity | undefined> => {
        const knownPuuid = typeof entry.player.puuid === 'string' ? entry.player.puuid : '';
        if (knownPuuid) {
          return {
            puuid: knownPuuid,
            summonerId: toNumber(entry.player.summonerId) || undefined,
            accountId: toNumber(entry.player.accountId) || undefined,
            gameName: entry.player.summonerName,
          };
        }
        const summonerId = toNumber(entry.player.summonerId);
        if (!summonerId) return undefined;
        const info = await api.getSummonerById(summonerId).catch(() => null);
        if (!info?.puuid) return undefined;
        return {
          puuid: info.puuid,
          summonerId: info.summonerId || summonerId,
          accountId: info.accountId,
          gameName: info.gameName,
          tagLine: info.tagLine,
        };
      },
    );
    const identities = resolved.filter(
      (item): item is EndOfGameIdentity => item !== undefined,
    );
    if (identities.length !== entries.length) return undefined;
    return endOfGameToRawGame(block, identities);
  }

  /** 取一局结算数据已就绪、但客户端列表还没同步的对局；列表出现后顺手清理 */
  private takeProvisionalGame(games: RawGame[]): RawGame | undefined {
    this.pruneProvisionalGames();
    const known = new Set(games.map((game) => toNumber(game.gameId)));
    let latest: { game: RawGame; at: number } | undefined;
    for (const [gameId, entry] of this.provisionalGames) {
      if (known.has(gameId)) {
        this.provisionalGames.delete(gameId);
        continue;
      }
      if (!latest || entry.at > latest.at) latest = entry;
    }
    return latest?.game;
  }

  private pruneProvisionalGames(): void {
    const cutoff = Date.now() - 6 * 60 * 60_000;
    for (const [gameId, entry] of this.provisionalGames) {
      if (entry.at < cutoff) this.provisionalGames.delete(gameId);
    }
  }

  private disconnect(): void {
    this.eventStream?.close();
    this.eventStream = undefined;
    this.api?.destroy();
    this.api = undefined;
    for (const collector of this.collectors.values()) void collector.flush();
    this.collectors.clear();
    this.connection = undefined;
    this.edgeUrl = undefined;
    this.lastMembersKey = '';
    this.nextDiscoveryAt = 0;
    this.lastPhase = 'None';
    this.inGameSession = undefined;
    this.postGame = undefined;
    this.provisionalGames.clear();
    this.eogCapturedGameId = 0;
    this.gameEndBaseline = 0;
    this.inGameRecordAt = 0;
  }

  /** 按场次复用同一个 collector，让 24 小时缓存真正跨请求生效 */
  private ensureCollector(api: LcuApi, recent = this.options.recent): ReportCollector {
    const existing = this.collectors.get(recent);
    if (existing) return existing;
    const collector = new ReportCollector(api, { recent });
    this.collectors.set(recent, collector);
    return collector;
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

/** 只保留 AI 需要的事件字段，避免 snapshot 过大 */
function liveEventList(events?: LiveEvent[]): LiveEvent[] | undefined {
  if (!Array.isArray(events) || !events.length) return undefined;
  return events
    .filter((event) => event && typeof event.EventName === 'string')
    .slice(-30)
    .map((event) => ({
      EventName: event.EventName,
      EventTime: Number(event.EventTime) || 0,
      KillerName: event.KillerName,
      VictimName: event.VictimName,
      Assisters: Array.isArray(event.Assisters) ? event.Assisters.slice(0, 5) : undefined,
      TurretKilled: event.TurretKilled,
      InhibKilled: event.InhibKilled,
      DragonType: event.DragonType,
      MonsterType: event.MonsterType,
      Stolen: event.Stolen,
    }));
}

/** 在一场完整对局里找到指定 puuid 的参与者（edge 返回的是原始对局，participants 顺序不固定） */
function participantOf(game: RawGame, puuid: string): RawParticipant | undefined {
  const participants = game.participants ?? [];
  if (puuid) {
    // edge 的 SUMMARY 直接把 puuid 放在参与者上
    const direct = participants.find((item) => item.puuid === puuid);
    if (direct) return direct;

    const identity = (game.participantIdentities ?? []).find(
      (item) => item.player?.puuid === puuid,
    );
    if (identity) {
      const participantId = toNumber(identity.participantId);
      const match = participants.find(
        (item) => toNumber(item.participantId) === participantId,
      );
      if (match) return match;
    }
  }
  return participants[0];
}

/** LCU 的完整对局把数据放在 stats 下，edge 的 SUMMARY 则直接平铺在参与者上 */
function statsOf(participant: RawParticipant | undefined): RawStats {
  if (!participant) return {};
  const nested = participant.stats;
  if (nested && Object.keys(nested).length) return nested;
  return participant as RawStats;
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
