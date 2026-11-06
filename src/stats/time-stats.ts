import type { GameModeKey, MatchSummary } from '../types.js';
import { modeFromQueue } from './constants.js';

/** 每个统计时段的长度（小时） */
export const TIME_PERIOD_HOURS = 2;

/** 参与时段统计的最小对局信息 */
export interface TimeStatsGame {
  gameCreation: number;
  win: boolean;
  tags?: string[];
}

export interface TimePeriodStats {
  startHour: number;
  endHour: number;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  /** 本时段里至少有一名队友被标记为坑/逃跑的对局数 */
  teammateBadGames: number;
  teammateBadRate: number;
  /** 本时段里自己被标记为坑/逃跑的对局数 */
  selfBadGames: number;
  selfBadRate: number;
}

export interface TimeStatsSummary {
  totalGames: number;
  wins: number;
  winRate: number;
  periods: TimePeriodStats[];
}

const TEAMMATE_BAD_TAG = /^队友(?:小坑|坑|巨坑|逃跑)$/;
const SELF_BAD_TAG = /^自己(?:小坑|坑|巨坑|逃跑)$/;

/**
 * 按本地时间把对局归入固定的两小时时段。
 * 所有时段都会被返回（没有对局的时段为 0），方便前端画完整的一天。
 */
export function summarizeTimeStats(games: TimeStatsGame[]): TimeStatsSummary {
  const bucketCount = 24 / TIME_PERIOD_HOURS;
  const periods = Array.from({ length: bucketCount }, (_, index): TimePeriodStats => {
    const startHour = index * TIME_PERIOD_HOURS;
    return {
      startHour,
      endHour: startHour + TIME_PERIOD_HOURS,
      games: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      teammateBadGames: 0,
      teammateBadRate: 0,
      selfBadGames: 0,
      selfBadRate: 0,
    };
  });

  let totalGames = 0;
  let totalWins = 0;

  for (const game of games) {
    const tags = Array.isArray(game.tags) ? game.tags : [];
    // 重开不计入胜负和坑率
    if (tags.includes('重开')) continue;
    const timestamp = Number(game.gameCreation);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;

    const hour = new Date(timestamp).getHours();
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(hour / TIME_PERIOD_HOURS)),
    );
    const period = periods[index];
    if (!period) continue;

    const win = Boolean(game.win);
    period.games += 1;
    period.wins += win ? 1 : 0;
    totalGames += 1;
    totalWins += win ? 1 : 0;
    if (tags.some((tag) => TEAMMATE_BAD_TAG.test(tag))) period.teammateBadGames += 1;
    if (tags.some((tag) => SELF_BAD_TAG.test(tag))) period.selfBadGames += 1;
  }

  for (const period of periods) {
    period.losses = period.games - period.wins;
    period.winRate = period.games ? period.wins / period.games : 0;
    period.teammateBadRate = period.games ? period.teammateBadGames / period.games : 0;
    period.selfBadRate = period.games ? period.selfBadGames / period.games : 0;
  }

  return {
    totalGames,
    wins: totalWins,
    winRate: totalGames ? totalWins / totalGames : 0,
    periods,
  };
}

/** 把最近战绩列表转换成时段统计（本地存档不可用时的兜底） */
export function summarizeMatchSummaries(
  games: MatchSummary[],
  mode?: GameModeKey,
): TimeStatsSummary {
  const filtered = mode
    ? games.filter((game) => modeFromQueue(Number(game.queueId)) === mode)
    : games;
  return summarizeTimeStats(
    filtered.map((game) => ({
      gameCreation: Number(game.gameCreation) || 0,
      win: Boolean(game.win),
      tags: game.tags,
    })),
  );
}
