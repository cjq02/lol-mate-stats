import { randomUUID } from 'node:crypto';
import type {
  ChampSelectMember,
  ChampSelectSession,
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
import { analyzeParticipant, computeMatchScores, matchBestTags } from './stats/analyze.js';
import { ReportCollector } from './stats/collector.js';
import { analyzeGame } from './stats/analyze.js';
import {
  archiveGames,
  countPlayerMatches,
  getPlayerChampionScores,
  getPlayerMatchTags,
  getPlayerMatches,
  getPlayerScores,
  getPlayerWinRecord,
  getSavedSelfPuuid,
  saveSelfPuuid,
  type ArchivedMatch,
} from './stats/archive.js';
import { currentQueueGroup, modeFromQueue, queueGroupName, queueName } from './stats/constants.js';
import {
  afkParticipantIds,
  badLevelLabel,
  badLevelOfScore,
  gameFlagTags,
  gameFlags,
  isRemakeGame,
} from './stats/flags.js';
import { gradeOf } from './stats/rating.js';
import { linkLiveAnalysisToGameByTime } from './stats/store.js';
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
          gameCreation: toNumber(game.gameCreation),
          gameDuration: rawDuration > 100_000 ? Math.round(rawDuration / 1000) : rawDuration,
          championId,
          championName: championMap.get(championId)?.name,
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
    options: { force?: boolean } = {},
  ): Promise<MatchDetail> {
    const started = Date.now();
    const api = await this.ensureApi();
    if (!api) throw new ClientNotFoundError('未检测到正在运行的英雄联盟客户端');

    logTag('match', `[${gameId}] 开始读取对局详情（每人最近 ${recent} 场）`);
    const summoner = await api.getCurrentSummoner();
    await saveSelfPuuid(summoner.puuid ?? '');
    let game;
    try {
      game = await api.getGame(gameId);
    } catch (error) {
      logTag(
        'match',
        `[${gameId}] 读取对局失败：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
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
      const rawDuration = toNumber(game.gameDuration);
      const flags = gameFlags(
        game,
        selfParticipant ? toNumber(selfParticipant.participantId) : undefined,
        championMap,
        scoreMap,
      );
      logTag(
        'match',
        `[${gameId}] 全部完成：${players.length} 人，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );

      return {
        gameId,
        queueId,
        queueName: queueName(queueId),
        gameMode,
        gameCreation: toNumber(game.gameCreation),
        gameDuration: rawDuration > 100_000 ? Math.round(rawDuration / 1000) : rawDuration,
        selfPuuid: summoner.puuid,
        players,
        scoreboard,
        tags: gameFlagTags(flags),
        afkPlayers,
        badPlayers,
      };
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
  ): Promise<{ puuid: string; total: number; games: ArchivedMatch[] }> {
    const id = await this.resolveArchivePuuid(puuid);
    if (!id) return { puuid: '', total: 0, games: [] };
    const total = await countPlayerMatches(id);
    return { puuid: id, total, games: await getPlayerMatches(id, limit, offset) };
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
    const hasContext = !championId && (queueId !== undefined || mode !== undefined);
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
        gameTime: undefined,
        liveSessionId: undefined,
        liveEvents: undefined,
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
      const reports = await collector.collectLive(
        members,
        (partial) => {
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

    try {
      const collector = this.ensureCollector(api);
      collector.setSelfPuuid(localMember?.puuid);
      const reports = await collector.collect(
        session,
        (partial) => {
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
