import type {
  EndOfGamePlayer,
  EndOfGameStatsBlock,
  RawGame,
  RawParticipant,
  RawStats,
} from '../types.js';
import { toNumber } from '../util.js';

/** 结算数据里的一名玩家，附带所属队伍和胜负 */
export interface EndOfGameEntry {
  player: EndOfGamePlayer;
  teamId: number;
  win: boolean;
}

/** 按顺序补齐的召唤师身份（puuid 必填，用于存档归属） */
export interface EndOfGameIdentity {
  puuid: string;
  summonerId?: number;
  accountId?: number;
  gameName?: string;
  tagLine?: string;
}

/** 读出结算数据里的所有玩家；不同客户端版本可能放在 teams 或顶层 players */
export function endOfGameEntries(block?: EndOfGameStatsBlock | null): EndOfGameEntry[] {
  if (!block) return [];
  const entries: EndOfGameEntry[] = [];
  for (const team of block.teams ?? []) {
    const teamId = toNumber(team.teamId);
    for (const player of team.players ?? []) {
      entries.push({
        player,
        teamId: toNumber(player.teamId) || teamId,
        win: Boolean(team.isWinningTeam),
      });
    }
  }
  if (entries.length) return entries;
  for (const player of block.players ?? []) {
    entries.push({
      player,
      teamId: toNumber(player.teamId),
      win: eogNumber(player.stats, 'WIN') > 0,
    });
  }
  return entries;
}

/**
 * 把结算界面的数据转成 RawGame，复用现有的评分 / 标签 / 存档管线。
 * 战绩列表还没同步时，用它抢先写入刚结束的对局。
 */
export function endOfGameToRawGame(
  block: EndOfGameStatsBlock,
  identities: EndOfGameIdentity[],
  now = Date.now(),
): RawGame | undefined {
  const gameId = toNumber(block.gameId);
  const queueId = toNumber(block.queueId);
  const entries = endOfGameEntries(block);
  const rawLength = toNumber(block.gameLength);
  const gameLength = rawLength > 100_000 ? Math.round(rawLength / 1000) : rawLength;
  if (!gameId || !queueId || gameLength <= 0) return undefined;
  if (entries.length < 2 || identities.length !== entries.length) return undefined;
  if (identities.some((identity) => !identity.puuid)) return undefined;

  const participants: RawParticipant[] = entries.map((entry, index) => {
    const stats = entry.player.stats ?? {};
    const position = String(
      entry.player.selectedPosition || entry.player.detectedTeamPosition || '',
    ).toUpperCase();
    const role =
      position === 'UTILITY'
        ? 'DUO_SUPPORT'
        : position === 'BOTTOM'
          ? 'DUO_CARRY'
          : 'SOLO';
    const rawStats: RawStats = {
      win: entry.win || eogNumber(stats, 'WIN') > 0,
      kills: eogNumber(stats, 'CHAMPIONS_KILLED'),
      deaths: eogNumber(stats, 'NUM_DEATHS'),
      assists: eogNumber(stats, 'ASSISTS'),
      goldEarned: eogNumber(stats, 'GOLD_EARNED'),
      totalDamageDealtToChampions: eogNumber(stats, 'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS'),
      totalDamageTaken: eogNumber(stats, 'TOTAL_DAMAGE_TAKEN'),
      totalHeal: eogNumber(stats, 'TOTAL_HEAL'),
      visionScore: eogNumber(stats, 'VISION_SCORE'),
      totalMinionsKilled: eogNumber(stats, 'MINIONS_KILLED'),
      neutralMinionsKilled: eogNumber(stats, 'NEUTRAL_MINIONS_KILLED'),
      largestKillingSpree: eogNumber(stats, 'LARGEST_KILLING_SPREE'),
      doubleKills: eogNumber(stats, 'DOUBLE_KILLS'),
      tripleKills: eogNumber(stats, 'TRIPLE_KILLS'),
      quadraKills: eogNumber(stats, 'QUADRA_KILLS'),
      pentaKills: eogNumber(stats, 'PENTA_KILLS'),
      turretKills: eogNumber(stats, 'TURRETS_KILLED'),
      firstBloodKill: eogNumber(stats, 'FIRST_BLOOD') > 0,
      gameEndedInEarlySurrender: eogNumber(stats, 'GAME_ENDED_IN_EARLY_SURRENDER') > 0,
    };
    const items = Array.isArray(entry.player.items) ? entry.player.items : [];
    for (let slot = 0; slot < 7; slot += 1) {
      const itemId = toNumber(items[slot]);
      if (itemId > 0) rawStats[`item${slot}`] = itemId;
    }
    return {
      participantId: index + 1,
      championId: toNumber(entry.player.championId),
      teamId: entry.teamId,
      stats: rawStats,
      timeline: { lane: position || undefined, role },
    };
  });

  return {
    gameId,
    queueId,
    gameMode: typeof block.gameMode === 'string' ? block.gameMode : undefined,
    // 结算接口不提供开局时间，用“当前时间 - 对局时长”估算，足够排序和展示
    gameCreation: now - Math.round(gameLength * 1000),
    gameDuration: gameLength,
    participants,
    participantIdentities: entries.map((entry, index) => {
      const identity = identities[index];
      return {
        participantId: index + 1,
        player: {
          puuid: identity?.puuid,
          summonerId: identity?.summonerId ?? toNumber(entry.player.summonerId),
          accountId: identity?.accountId ?? toNumber(entry.player.accountId),
          gameName: identity?.gameName ?? entry.player.summonerName,
          tagLine: identity?.tagLine,
          summonerName: entry.player.summonerName,
        },
      };
    }),
  };
}

function eogNumber(
  stats: Record<string, number | string | boolean | undefined> | undefined,
  key: string,
): number {
  const value = stats?.[key];
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
