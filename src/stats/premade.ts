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
