import type { RawGame } from '../types.js';
import type { ChampionSummary } from '../lcu/api.js';
import { toNumber } from '../util.js';
import { analyzeParticipant } from './analyze.js';
import { isAfkLikeRelative, type AfkRelativeStats } from './rating.js';

export const BAD_GAME_SCORE = 40;

export interface GameFlags {
  /** 对局是否在 5 分钟内重开 */
  remake: boolean;
  /** 是否有队友表现出明显的挂机/逃跑特征（数据推断） */
  teammateAfk: boolean;
  /** 是否有对手表现出明显的挂机/逃跑特征（数据推断） */
  opponentAfk: boolean;
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
 * 队友/对手逃跑没有官方字段，用绝对阈值 + 队内相对表现做保守推断。
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
  if (!self) return { remake, teammateAfk: false, opponentAfk: false };

  const teamId = toNumber(self.teamId);
  let teammateAfk = false;
  let opponentAfk = false;
  for (const id of afkParticipantIds(game, championMap)) {
    if (id === participantId) continue;
    const other = participants.find((item) => toNumber(item.participantId) === id);
    if (!other) continue;
    if (toNumber(other.teamId) === teamId) teammateAfk = true;
    else opponentAfk = true;
  }

  return { remake, teammateAfk, opponentAfk };
}

export function gameFlagTags(flags: GameFlags): string[] {
  const tags: string[] = [];
  if (flags.remake) tags.push('重开');
  if (flags.teammateAfk) tags.push('队友逃跑');
  if (flags.opponentAfk) tags.push('对手逃跑');
  return tags;
}
