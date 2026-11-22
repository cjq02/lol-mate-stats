import type { BadLevel, Lane, MatchTimeline, RawGame } from '../types.js';
import type { ChampionSummary } from '../lcu/api.js';
import { toNumber } from '../util.js';
import { analyzeParticipant, computeMatchScores } from './analyze.js';
import {
  BAD_GAME_SCORE,
  isAfkLikeRelative,
  MILD_BAD_GAME_SCORE,
  SEVERE_BAD_GAME_SCORE,
  type AfkRelativeStats,
} from './rating.js';

export { BAD_GAME_SCORE, MILD_BAD_GAME_SCORE, SEVERE_BAD_GAME_SCORE };

const BAD_LEVEL_RANK: Record<BadLevel, number> = { mild: 1, bad: 2, severe: 3 };

/** 把单场表现分换算成“坑”的程度；undefined 表示不算坑 */
export function badLevelOfScore(score: number | undefined): BadLevel | undefined {
  if (score === undefined || !Number.isFinite(score)) return undefined;
  if (score < SEVERE_BAD_GAME_SCORE) return 'severe';
  if (score < BAD_GAME_SCORE) return 'bad';
  if (score < MILD_BAD_GAME_SCORE) return 'mild';
  return undefined;
}

/** 两个程度取更严重的那个 */
export function worseBadLevel(
  a: BadLevel | undefined,
  b: BadLevel | undefined,
): BadLevel | undefined {
  if (!a) return b;
  if (!b) return a;
  return BAD_LEVEL_RANK[a] >= BAD_LEVEL_RANK[b] ? a : b;
}

export function badLevelLabel(level: BadLevel): string {
  if (level === 'severe') return '巨坑';
  if (level === 'mild') return '小坑';
  return '很坑';
}

export interface GameFlags {
  /** 对局是否在 5 分钟内重开 */
  remake: boolean;
  /** 是否有队友表现出明显的挂机/逃跑特征（数据推断） */
  teammateAfk: boolean;
  /** 是否有对手表现出明显的挂机/逃跑特征（数据推断） */
  opponentAfk: boolean;
  /** 自己是否被推断为挂机/逃跑 */
  selfAfk?: boolean;
  /** 自己这局“坑”的程度 */
  selfBad?: BadLevel;
  /** 队友里最严重的“坑”程度 */
  teammateBad?: BadLevel;
  /** 对手里最严重的“坑”程度 */
  opponentBad?: BadLevel;
}

function durationSeconds(game: RawGame): number {
  const raw = toNumber(game.gameDuration);
  return raw > 100_000 ? Math.round(raw / 1000) : raw;
}

export function isRemakeMeta(duration: number): boolean {
  return duration > 0 && duration <= 300;
}

/** 官方没有直接的重开标记，用 early surrender 字段或极短时长推断 */
export function isRemakeGame(game: RawGame): boolean {
  for (const participant of game.participants ?? []) {
    const flag = participant.stats?.gameEndedInEarlySurrender;
    if (flag === true || flag === 1) return true;
  }
  return isRemakeMeta(durationSeconds(game));
}

/**
 * 找出本局被推断为挂机/逃跑的参与者 ID（包含队友和对手）。
 */
export function afkParticipantIds(
  game: RawGame,
  championMap: Map<number, ChampionSummary>,
  scores?: Map<number, number>,
  timeline?: MatchTimeline,
): Set<number> {
  const participants = game.participants ?? [];
  const timelineById = new Map(
    (timeline?.players ?? []).map((player) => [Number(player.participantId), player]),
  );
  const timelineByPuuid = new Map(
    (timeline?.players ?? [])
      .filter((player) => Boolean(player.puuid))
      .map((player) => [player.puuid as string, player] as const),
  );
  const puuidByParticipantId = new Map<number, string>();
  for (const identity of game.participantIdentities ?? []) {
    const participantId = toNumber(identity.participantId);
    const puuid = identity.player?.puuid;
    if (participantId > 0 && typeof puuid === 'string' && puuid) {
      puuidByParticipantId.set(participantId, puuid);
    }
  }
  const afkStatsByIndex: Array<AfkRelativeStats | undefined> = participants.map(
    (participant) => {
      const analyzed = analyzeParticipant(game, participant, championMap, scores);
      if (!analyzed) return undefined;
      const stats = participant.stats ?? {};
      const participantId = toNumber(participant.participantId);
      const puuid = puuidByParticipantId.get(participantId);
      // 结算数据和 game-timelines 的 participantId 偶尔会错位，优先按 puuid 找
      const timelinePlayer =
        (puuid ? timelineByPuuid.get(puuid) : undefined) ??
        timelineById.get(participantId);
      return {
        durationMin: analyzed.durationMin,
        gold: analyzed.gold,
        damage: analyzed.damage,
        cs: analyzed.cs,
        kills: analyzed.kills,
        deaths: analyzed.deaths,
        assists: analyzed.assists,
        visionScore: analyzed.visionScore,
        position: analyzed.position,
        killParticipation: analyzed.killParticipation,
        damageTaken: toNumber(stats.totalDamageTaken),
        heal: analyzed.heal,
        idleMinutes: analyzed.timeline?.idleMinutes,
        idleStreakSeconds:
          timelinePlayer?.maxIdleMs === undefined
            ? undefined
            : Math.round(timelinePlayer.maxIdleMs / 1000),
        idleAliveSeconds:
          timelinePlayer?.idleAliveMs === undefined
            ? undefined
            : Math.round(timelinePlayer.idleAliveMs / 1000),
        stationaryStreakSeconds:
          timelinePlayer?.maxStationaryMs === undefined
            ? undefined
            : Math.round(timelinePlayer.maxStationaryMs / 1000),
      };
    },
  );
  const statsByTeam = new Map<number, AfkRelativeStats[]>();
  afkStatsByIndex.forEach((stats, index) => {
    if (!stats) return;
    const teamId = toNumber(participants[index]?.teamId);
    const list = statsByTeam.get(teamId) ?? [];
    list.push(stats);
    statsByTeam.set(teamId, list);
  });

  const ids = new Set<number>();
  for (let index = 0; index < participants.length; index += 1) {
    const participant = participants[index];
    const stats = afkStatsByIndex[index];
    if (!participant || !stats) continue;
    const peers = statsByTeam.get(toNumber(participant.teamId)) ?? [];
    if (isAfkLikeRelative(stats, peers)) {
      ids.add(toNumber(participant.participantId));
    }
  }
  return ids;
}

/** 对局详情缓存里计分板玩家需要的字段，用来按当前规则复核逃跑 */
export interface ScoreboardAfkPlayer {
  puuid?: string;
  name: string;
  championId: number;
  teamId: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  damage: number;
  damageTaken: number;
  heal: number;
  vision: number;
  position?: string;
  killParticipation?: number;
  durationMin?: number;
}

/**
 * 用已存档的时间线复核计分板里的逃跑判定，返回需要补“逃跑”标记的下标。
 * 对局详情缓存里的标签是当时算的，短局以前完全不判逃跑；
 * 打开旧对局时按当前规则补算一次，尤其是时间线证明大半局原地不动的场次。
 */
export function afkScoreboardIndexes(
  scoreboard: ScoreboardAfkPlayer[],
  timeline: MatchTimeline | undefined,
  fallbackDurationMin: number,
): Set<number> {
  const indexes = new Set<number>();
  const timelinePlayers = timeline?.players ?? [];
  if (!scoreboard.length || !timelinePlayers.length) return indexes;
  const byPuuid = new Map(
    timelinePlayers
      .filter((player) => Boolean(player.puuid))
      .map((player) => [player.puuid as string, player] as const),
  );

  const afkStats = scoreboard.map((player) => {
    // 结算数据和 game-timelines 的 participantId 偶尔会错位，优先按 puuid / 名字找
    const timelinePlayer =
      (player.puuid ? byPuuid.get(player.puuid) : undefined) ??
      timelinePlayers.find((item) => item.name === player.name) ??
      timelinePlayers.find(
        (item) => Number(item.championId) === Number(player.championId),
      );
    return {
      durationMin: player.durationMin ?? fallbackDurationMin,
      gold: player.gold,
      damage: player.damage,
      cs: player.cs,
      kills: player.kills,
      deaths: player.deaths,
      assists: player.assists,
      visionScore: player.vision,
      position: player.position as Lane | undefined,
      killParticipation: player.killParticipation,
      damageTaken: player.damageTaken,
      heal: player.heal,
      idleStreakSeconds:
        timelinePlayer?.maxIdleMs === undefined
          ? undefined
          : Math.round(timelinePlayer.maxIdleMs / 1000),
      idleAliveSeconds:
        timelinePlayer?.idleAliveMs === undefined
          ? undefined
          : Math.round(timelinePlayer.idleAliveMs / 1000),
      stationaryStreakSeconds:
        timelinePlayer?.maxStationaryMs === undefined
          ? undefined
          : Math.round(timelinePlayer.maxStationaryMs / 1000),
    } satisfies AfkRelativeStats;
  });

  const statsByTeam = new Map<number, AfkRelativeStats[]>();
  scoreboard.forEach((player, index) => {
    const list = statsByTeam.get(player.teamId) ?? [];
    list.push(afkStats[index]!);
    statsByTeam.set(player.teamId, list);
  });

  scoreboard.forEach((player, index) => {
    const stats = afkStats[index];
    if (!stats) return;
    if (isAfkLikeRelative(stats, statsByTeam.get(player.teamId) ?? [])) {
      indexes.add(index);
    }
  });
  return indexes;
}

/**
 * 计算某名参与者视角下的对局标记。
 * 队友/对手逃跑没有官方字段，用绝对阈值 + 队内相对表现做保守推断；
 * “坑”按单场表现分分成小坑 / 很坑 / 巨坑三档。
 */
export function gameFlags(
  game: RawGame,
  participantId: number | undefined,
  championMap: Map<number, ChampionSummary>,
  scores?: Map<number, number>,
  timeline?: MatchTimeline,
): GameFlags {
  const remake = isRemakeGame(game);
  const participants = game.participants ?? [];
  const scoreMap = scores ?? computeMatchScores(game, championMap);
  const self =
    participantId === undefined
      ? undefined
      : participants.find((item) => toNumber(item.participantId) === participantId);
  if (!self) {
    return { remake, teammateAfk: false, opponentAfk: false, selfAfk: false };
  }

  const teamId = toNumber(self.teamId);
  const afkIds = afkParticipantIds(game, championMap, scoreMap, timeline);
  const selfAfk = afkIds.has(toNumber(self.participantId));
  const selfBad = remake
    ? undefined
    : badLevelOfScore(analyzeParticipant(game, self, championMap, scoreMap)?.score);
  let teammateAfk = false;
  let opponentAfk = false;
  let teammateBad: BadLevel | undefined;
  let opponentBad: BadLevel | undefined;

  for (const other of participants) {
    const otherId = toNumber(other.participantId);
    if (otherId === participantId) continue;
    const isTeammate = toNumber(other.teamId) === teamId;
    if (afkIds.has(otherId)) {
      if (isTeammate) teammateAfk = true;
      else opponentAfk = true;
    }
    if (remake) continue;
    const analyzed = analyzeParticipant(game, other, championMap, scoreMap);
    const level = badLevelOfScore(analyzed?.score);
    if (!level) continue;
    if (isTeammate) teammateBad = worseBadLevel(teammateBad, level);
    else opponentBad = worseBadLevel(opponentBad, level);
  }

  // 逃跑和坑可以同时存在：挂机的人整局数据通常也很差，两个标签都有信息量
  return { remake, teammateAfk, opponentAfk, selfAfk, selfBad, teammateBad, opponentBad };
}

export function gameFlagTags(flags: GameFlags): string[] {
  const tags: string[] = [];
  if (flags.remake) tags.push('重开');
  if (flags.selfAfk) tags.push('自己逃跑');
  if (flags.selfBad) tags.push(`自己${badLevelLabel(flags.selfBad)}`);
  if (flags.teammateAfk) tags.push('队友逃跑');
  if (flags.opponentAfk) tags.push('对手逃跑');
  if (flags.teammateBad) tags.push(`队友${badLevelLabel(flags.teammateBad)}`);
  if (flags.opponentBad) tags.push(`敌方${badLevelLabel(flags.opponentBad)}`);
  return tags;
}
