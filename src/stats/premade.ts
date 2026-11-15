import type { GameflowTeamMember } from '../types.js';

/**
 * 同一开黑队伍会共享 teamParticipantId。
 * 按队伍分别统计，避免两队恰好使用相同 ID 时被误判成同一组。
 */
export function premadeSizesByPuuid(
  teams: Array<GameflowTeamMember[] | undefined>,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const team of teams) {
    if (!Array.isArray(team) || !team.length) continue;
    const counts = new Map<number, number>();
    for (const member of team) {
      const id = Number(member.teamParticipantId);
      if (!Number.isFinite(id) || id <= 0) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const member of team) {
      const id = Number(member.teamParticipantId);
      const puuid = String(member.puuid ?? '').trim();
      if (!puuid || !Number.isFinite(id) || id <= 0) continue;
      const size = counts.get(id) ?? 0;
      if (size >= 2) result.set(puuid, size);
    }
  }
  return result;
}

/** 历史对局里可用的最小战绩字段：游戏 ID + 该玩家的队伍 */
export interface PremadeGameRef {
  gameId: number;
  teamId?: number;
}

export interface PremadeReportRef {
  puuid?: string;
  isEnemy?: boolean;
  games?: PremadeGameRef[];
}

/**
 * 根据最近战绩推断历史对局里的开黑分组。
 *
 * 只有当前对局之外、至少 `minSharedGames` 场“同队同局”才合并成一组：
 * 大乱斗深夜人少时经常随机重复匹配，要求多场同队可以过滤掉大部分误判。
 */
export function premadeSizesFromGames(
  reports: PremadeReportRef[],
  currentGameId?: number,
  minSharedGames = 2,
): Map<string, number> {
  const entries = reports
    .filter((report) => report.puuid && report.games?.length)
    .map((report) => ({
      puuid: report.puuid as string,
      isEnemy: Boolean(report.isEnemy),
      games: new Map(
        (report.games ?? [])
          .filter((game) => Number.isFinite(game.gameId))
          .map((game) => [game.gameId, game.teamId] as const),
      ),
    }));
  if (entries.length < 2) return new Map();

  const parent = new Map<string, string>();
  for (const entry of entries) parent.set(entry.puuid, entry.puuid);
  const find = (puuid: string): string => {
    let root = puuid;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    while (parent.get(puuid) !== root) {
      const next = parent.get(puuid) as string;
      parent.set(puuid, root);
      puuid = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i] as (typeof entries)[number];
      const b = entries[j] as (typeof entries)[number];
      if (a.isEnemy !== b.isEnemy) continue;
      let shared = 0;
      for (const [gameId, teamId] of a.games) {
        if (gameId === currentGameId || !teamId) continue;
        if (b.games.get(gameId) === teamId) shared += 1;
      }
      if (shared >= minSharedGames) union(a.puuid, b.puuid);
    }
  }

  const counts = new Map<string, number>();
  for (const entry of entries) {
    const root = find(entry.puuid);
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  const result = new Map<string, number>();
  for (const entry of entries) {
    const size = counts.get(find(entry.puuid)) ?? 0;
    if (size >= 2) result.set(entry.puuid, size);
  }
  return result;
}
