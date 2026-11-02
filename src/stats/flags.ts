import type { BadLevel, RawGame } from '../types.js';
import type { ChampionSummary } from '../lcu/api.js';
import { toNumber } from '../util.js';
import { analyzeParticipant } from './analyze.js';
import { isAfkLikeRelative, type AfkRelativeStats } from './rating.js';

/** 低于此分数算“坑” */
export const BAD_GAME_SCORE = 40;
/** 略低于正常水平，算“小坑” */
export const MILD_BAD_GAME_SCORE = 48;
/** 多项数据严重不达标，算“巨坑” */
export const SEVERE_BAD_GAME_SCORE = 25;

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
  return '坑';
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
): Set<number> {
  const participants = game.participants ?? [];
  const afkStatsByIndex: Array<AfkRelativeStats | undefined> = participants.map(
    (participant) => {
      const analyzed = analyzeParticipant(game, participant, championMap);
      if (!analyzed) return undefined;
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

/**
 * 计算某名参与者视角下的对局标记。
 * 队友/对手逃跑没有官方字段，用绝对阈值 + 队内相对表现做保守推断；
 * “坑”按单场表现分分成小坑 / 坑 / 巨坑三档。
 */
export function gameFlags(
  game: RawGame,
  participantId: number | undefined,
  championMap: Map<number, ChampionSummary>,
): GameFlags {
  const remake = isRemakeGame(game);
  const participants = game.participants ?? [];
  const self =
    participantId === undefined
      ? undefined
      : participants.find((item) => toNumber(item.participantId) === participantId);
  if (!self) {
    return { remake, teammateAfk: false, opponentAfk: false, selfAfk: false };
  }

  const teamId = toNumber(self.teamId);
  const afkIds = afkParticipantIds(game, championMap);
  const selfAfk = afkIds.has(toNumber(self.participantId));
  const selfBad =
    !remake && !selfAfk
      ? badLevelOfScore(analyzeParticipant(game, self, championMap)?.score)
      : undefined;
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
      continue;
    }
    if (remake) continue;
    const analyzed = analyzeParticipant(game, other, championMap);
    const level = badLevelOfScore(analyzed?.score);
    if (!level) continue;
    if (isTeammate) teammateBad = worseBadLevel(teammateBad, level);
    else opponentBad = worseBadLevel(opponentBad, level);
  }

  // 有队友/对手逃跑时不再叠加“坑”标签，避免同一局出现两种强判断
  if (teammateAfk) teammateBad = undefined;
  if (opponentAfk) opponentBad = undefined;

  return { remake, teammateAfk, opponentAfk, selfAfk, selfBad, teammateBad, opponentBad };
}

export function gameFlagTags(flags: GameFlags): string[] {
  const tags: string[] = [];
  if (flags.remake) tags.push('重开');
  if (flags.selfAfk) tags.push('自己逃跑');
  else if (flags.selfBad) tags.push(`自己${badLevelLabel(flags.selfBad)}`);
  if (flags.teammateAfk) tags.push('队友逃跑');
  if (flags.opponentAfk) tags.push('对手逃跑');
  if (flags.teammateBad) tags.push(`队友${badLevelLabel(flags.teammateBad)}`);
  if (flags.opponentBad) tags.push(`敌方${badLevelLabel(flags.opponentBad)}`);
  return tags;
}
