import type { RawGame } from '../types.js';
import type { ChampionSummary } from '../lcu/api.js';
import { toNumber } from '../util.js';
import { analyzeParticipant } from './analyze.js';
import { isAfkLike } from './rating.js';

export interface GameFlags {
  /** 对局是否在 5 分钟内重开 */
  remake: boolean;
  /** 是否有队友表现出明显的挂机/逃跑特征（数据推断） */
  teammateAfk: boolean;
}

function durationSeconds(game: RawGame): number {
  const raw = toNumber(game.gameDuration);
  return raw > 100_000 ? Math.round(raw / 1000) : raw;
}

export function isRemakeMeta(
  queueId: number,
  duration: number,
  gameMode?: string | null,
): boolean {
  if (duration <= 0 || duration > 300) return false;
  if (queueId === 450 || queueId === 1700 || queueId === 1710) return false;
  const mode = String(gameMode ?? '').toUpperCase();
  if (mode === 'ARAM' || mode === 'CHERRY') return false;
  return true;
}

/** 官方没有直接的重开标记，用 early surrender 字段或极短时长推断 */
export function isRemakeGame(game: RawGame): boolean {
  for (const participant of game.participants ?? []) {
    const flag = participant.stats?.gameEndedInEarlySurrender;
    if (flag === true || flag === 1) return true;
  }
  return isRemakeMeta(toNumber(game.queueId), durationSeconds(game), game.gameMode);
}

/**
 * 计算某名参与者视角下的对局标记。
 * 队友逃跑没有官方字段，沿用最近战绩里的保守推断：
 * 时长 ≥ 8 分钟，且伤害/经济/补刀/参团/视野同时明显异常。
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
  if (!self) return { remake, teammateAfk: false };

  const teamId = toNumber(self.teamId);
  const teammateAfk = participants.some((other) => {
    if (toNumber(other.participantId) === participantId) return false;
    if (toNumber(other.teamId) !== teamId) return false;
    const analyzed = analyzeParticipant(game, other, championMap);
    return analyzed ? isAfkLike(analyzed) : false;
  });

  return { remake, teammateAfk };
}

export function gameFlagTags(flags: GameFlags): string[] {
  const tags: string[] = [];
  if (flags.remake) tags.push('重开');
  if (flags.teammateAfk) tags.push('队友逃跑');
  return tags;
}
