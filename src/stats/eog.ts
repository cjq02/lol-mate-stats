import type {
  EndOfGamePlayer,
  EndOfGameStatsBlock,
  RawGame,
  RawParticipant,
  RawStats,
} from '../types.js';
import { queueIdFromType } from './constants.js';
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
  /** 对局中从 gameflow 记下的准确队列 ID，优先于 queueType 反推 */
  queueIdOverride?: number,
): RawGame | undefined {
  const gameId = toNumber(block.gameId);
  const queueId =
    toNumber(block.queueId) || toNumber(queueIdOverride) || queueIdFromType(block.queueType);
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
      win: entry.win || eogNumber(stats, 'WIN', 'win') > 0,
      kills: eogNumber(stats, 'CHAMPIONS_KILLED', 'kills'),
      deaths: eogNumber(stats, 'NUM_DEATHS', 'deaths'),
      assists: eogNumber(stats, 'ASSISTS', 'assists'),
      goldEarned: eogNumber(stats, 'GOLD_EARNED', 'goldEarned'),
      totalDamageDealtToChampions: eogNumber(
        stats,
        'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS',
        'totalDamageDealtToChampions',
      ),
      totalDamageTaken: eogNumber(stats, 'TOTAL_DAMAGE_TAKEN', 'totalDamageTaken'),
      totalHeal: eogNumber(stats, 'TOTAL_HEAL', 'totalHeal'),
      visionScore: eogNumber(stats, 'VISION_SCORE', 'visionScore'),
      totalMinionsKilled: eogNumber(stats, 'MINIONS_KILLED', 'totalMinionsKilled'),
      neutralMinionsKilled: eogNumber(
        stats,
        'NEUTRAL_MINIONS_KILLED',
        'neutralMinionsKilled',
      ),
      largestKillingSpree: eogNumber(stats, 'LARGEST_KILLING_SPREE', 'largestKillingSpree'),
      doubleKills: eogNumber(stats, 'DOUBLE_KILLS', 'doubleKills'),
      tripleKills: eogNumber(stats, 'TRIPLE_KILLS', 'tripleKills'),
      quadraKills: eogNumber(stats, 'QUADRA_KILLS', 'quadraKills'),
      pentaKills: eogNumber(stats, 'PENTA_KILLS', 'pentaKills'),
      turretKills: eogNumber(stats, 'TURRETS_KILLED', 'turretKills'),
      firstBloodKill: eogNumber(stats, 'FIRST_BLOOD', 'firstBloodKill') > 0,
      // 只认 early surrender 字段：普通投降（gameEndedInSurrender）不是重开
      gameEndedInEarlySurrender:
        eogNumber(stats, 'GAME_ENDED_IN_EARLY_SURRENDER', 'gameEndedInEarlySurrender') > 0,
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
      spell1Id: toNumber(entry.player.spell1Id) || undefined,
      spell2Id: toNumber(entry.player.spell2Id) || undefined,
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
  ...keys: string[]
): number {
  if (!stats) return 0;
  for (const key of keys) {
    const value = stats[key];
    if (value === undefined || value === null) continue;
    const number = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}
