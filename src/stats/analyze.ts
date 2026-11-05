import type {
  AnalyzedGame,
  Lane,
  RawGame,
  RawParticipant,
  RawStats,
} from '../types.js';
import type { ChampionSummary } from '../lcu/api.js';
import { toNumber } from '../util.js';
import { queueName } from './constants.js';
import { championRole } from './champion-roles.js';
import { gameTags, percentileScores } from './rating.js';

export interface IdentityKey {
  puuid?: string;
  summonerId?: number | string;
  accountId?: number | string;
}

export function detectLane(game: RawGame, participant: RawParticipant): Lane {
  const queueId = toNumber(game.queueId);
  const mode = String(game.gameMode ?? '').toUpperCase();
  if (queueId === 450 || mode === 'ARAM') return 'ARAM';
  if (queueId === 1700 || queueId === 1710 || mode === 'CHERRY') return 'ARENA';

  const lane = String(participant.timeline?.lane ?? '').toUpperCase();
  const role = String(participant.timeline?.role ?? '').toUpperCase();

  if (lane === 'TOP') return 'TOP';
  if (lane === 'JUNGLE') return 'JUNGLE';
  if (lane === 'MIDDLE' || lane === 'MID') return 'MID';
  if (lane === 'BOTTOM') return role === 'DUO_SUPPORT' ? 'SUPPORT' : 'ADC';
  if (role === 'DUO_SUPPORT') return 'SUPPORT';
  if (role === 'DUO_CARRY') return 'ADC';
  return 'UNKNOWN';
}

function sameId(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b);
}

function findParticipant(
  game: RawGame,
  identityKey: IdentityKey,
): RawParticipant | undefined {
  const participants = game.participants ?? [];
  const identities = game.participantIdentities ?? [];

  let identity = identities.find(
    (item) => identityKey.puuid && item.player?.puuid === identityKey.puuid,
  );

  if (!identity && identityKey.summonerId !== undefined) {
    identity = identities.find(
      (item) =>
        sameId(item.player?.summonerId, identityKey.summonerId) ||
        sameId(item.player?.accountId, identityKey.summonerId) ||
        sameId(item.player?.currentAccountId, identityKey.summonerId),
    );
  }

  if (!identity && identityKey.accountId !== undefined) {
    identity = identities.find(
      (item) =>
        sameId(item.player?.accountId, identityKey.accountId) ||
        sameId(item.player?.currentAccountId, identityKey.accountId),
    );
  }

  if (identity) {
    const participant = participants.find(
      (item) => sameId(item.participantId, identity?.participantId),
    );
    if (participant) return participant;
    const index = identities.indexOf(identity);
    if (index >= 0) {
      return (
        participants.find((item) => sameId(item.participantId, index + 1)) ??
        participants[index]
      );
    }
  }

  // 少数 LCU 版本会直接在 participant 上带 puuid
  if (identityKey.puuid) {
    const direct = participants.find(
      (item) => sameId((item as Record<string, unknown>).puuid, identityKey.puuid),
    );
    if (direct) return direct;
  }

  // 只有一个参与者时（数据降级）直接使用
  if (participants.length === 1) return participants[0];
  return undefined;
}

function statNumber(stats: RawStats, ...keys: string[]): number {
  for (const key of keys) {
    const value = stats[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return 0;
}

interface BaseAnalysis {
  participantId: number;
  gameId: number;
  queueId: number;
  queueName: string;
  gameCreation: number;
  durationMin: number;
  championId: number;
  championName: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  kdaRaw: number;
  kda: number;
  cs: number;
  csPerMin: number;
  gold: number;
  damage: number;
  heal: number;
  damageShareRaw: number;
  damageShare: number;
  damagePerMin: number;
  tankShareRaw: number;
  tankShare: number;
  killParticipationRaw: number;
  killParticipation: number;
  healShareRaw: number;
  visionScore: number;
  visionPerMin: number;
  position: Lane;
  largestKillingSpree: number;
  pentaKills: number;
  quadraKills: number;
  turretKills: number;
  firstBloodKill: boolean;
}

function analyzeBase(
  game: RawGame,
  participant: RawParticipant,
  championMap: Map<number, ChampionSummary>,
): BaseAnalysis | null {
  const stats = participant.stats ?? {};
  const participants = game.participants ?? [];
  const teamId = toNumber(participant.teamId);
  const team = participants.filter((item) => toNumber(item.teamId) === teamId);

  const kills = statNumber(stats, 'kills');
  const deaths = statNumber(stats, 'deaths');
  const assists = statNumber(stats, 'assists');
  const largestKillingSpree = statNumber(stats, 'largestKillingSpree');
  const pentaKills = statNumber(stats, 'pentaKills');
  const quadraKills = statNumber(stats, 'quadraKills');
  const turretKills = statNumber(stats, 'turretKills');
  const totalHeal = statNumber(stats, 'totalHeal');
  const firstBloodKill = stats.firstBloodKill === true || stats.firstBloodKill === 1;
  const damage = statNumber(stats, 'totalDamageDealtToChampions');
  const damageTaken = statNumber(stats, 'totalDamageTaken');
  const gold = statNumber(stats, 'goldEarned');
  const visionScore = statNumber(stats, 'visionScore');
  const cs =
    statNumber(stats, 'totalMinionsKilled') +
    statNumber(stats, 'neutralMinionsKilled') ||
    statNumber(stats, 'minionsKilled');

  const teamKills = team.reduce((sum, item) => sum + statNumber(item.stats ?? {}, 'kills'), 0);
  const teamDamage = team.reduce(
    (sum, item) => sum + statNumber(item.stats ?? {}, 'totalDamageDealtToChampions'),
    0,
  );
  const teamDamageTaken = team.reduce(
    (sum, item) => sum + statNumber(item.stats ?? {}, 'totalDamageTaken'),
    0,
  );
  const teamHeal = team.reduce(
    (sum, item) => sum + statNumber(item.stats ?? {}, 'totalHeal'),
    0,
  );

  // 只有自己的“概况”数据算不出伤害占比/参团，直接丢弃，避免评分虚高
  if (team.length < 2) return null;

  const rawDuration = toNumber(game.gameDuration);
  const durationSeconds = rawDuration > 100_000 ? rawDuration / 1000 : rawDuration;
  const durationMin = Math.max(1, durationSeconds / 60);
  const displayDurationMin = durationSeconds > 0 ? durationSeconds / 60 : 0;

  const kda = (kills + assists) / Math.max(1, deaths);
  const damageShare = teamDamage > 0 ? damage / teamDamage : 0;
  const tankShare = teamDamageTaken > 0 ? damageTaken / teamDamageTaken : 0;
  const healShare = teamHeal > 0 ? totalHeal / teamHeal : 0;
  const killParticipation = teamKills > 0 ? (kills + assists) / teamKills : 0;
  const csPerMin = cs / durationMin;
  const visionPerMin = visionScore / durationMin;
  const damagePerMin = damage / durationMin;
  const win = stats.win === true || stats.win === 1;
  const championId = toNumber(participant.championId);
  const position = detectLane(game, participant);
  const championName =
    championMap.get(championId)?.name ?? (championId ? `英雄 ${championId}` : '未知英雄');

  return {
    participantId: toNumber(participant.participantId),
    gameId: toNumber(game.gameId),
    queueId: toNumber(game.queueId),
    queueName: queueName(toNumber(game.queueId)),
    gameCreation: toNumber(game.gameCreation),
    durationMin: Math.round(displayDurationMin),
    championId,
    championName,
    win,
    kills,
    deaths,
    assists,
    kdaRaw: kda,
    kda: Math.round(kda * 100) / 100,
    cs,
    csPerMin: Math.round(csPerMin * 10) / 10,
    gold,
    damage,
    heal: totalHeal,
    damageShareRaw: damageShare,
    damageShare: Math.round(damageShare * 1000) / 1000,
    damagePerMin: Math.round(damagePerMin),
    tankShareRaw: tankShare,
    tankShare: Math.round(tankShare * 1000) / 1000,
    killParticipationRaw: killParticipation,
    killParticipation: Math.round(killParticipation * 1000) / 1000,
    healShareRaw: healShare,
    visionScore,
    visionPerMin: Math.round(visionPerMin * 100) / 100,
    position,
    largestKillingSpree,
    pentaKills,
    quadraKills,
    turretKills,
    firstBloodKill,
  };
}

/** 按本局所有参与者计算 0–100 的单场评分 */
export function computeMatchScores(
  game: RawGame,
  championMap: Map<number, ChampionSummary>,
): Map<number, number> {
  const bases = (game.participants ?? [])
    .map((participant) => analyzeBase(game, participant, championMap))
    .filter((base): base is BaseAnalysis => base !== null);
  const scores = percentileScores(
    bases.map((base) => ({
      kda: base.kdaRaw,
      killParticipation: base.killParticipationRaw,
      damageShare: base.damageShareRaw,
      tankShare: base.tankShareRaw,
      healShare: base.healShareRaw,
      role: championRole(base.championId),
    })),
  );
  const result = new Map<number, number>();
  bases.forEach((base, index) => {
    result.set(base.participantId, scores[index] ?? 0);
  });
  return result;
}

/**
 * 每队评分最高的玩家：胜方记 MVP，负方记 SVP。
 * 返回 participantId → 标签；重开对局由调用方决定是否忽略。
 */
export function matchBestTags(
  game: RawGame,
  scoreMap: Map<number, number>,
): Map<number, string> {
  const bestByTeam = new Map<
    number,
    { participantId: number; score: number; win: boolean }
  >();
  for (const participant of game.participants ?? []) {
    const participantId = toNumber(participant.participantId);
    const score = scoreMap.get(participantId);
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;
    const teamId = toNumber(participant.teamId);
    const win = participant.stats?.win === true || participant.stats?.win === 1;
    const current = bestByTeam.get(teamId);
    if (!current || score > current.score) {
      bestByTeam.set(teamId, { participantId, score, win });
    }
  }

  const result = new Map<number, string>();
  for (const best of bestByTeam.values()) {
    result.set(best.participantId, best.win ? 'MVP' : 'SVP');
  }
  return result;
}

export function analyzeGame(
  game: RawGame,
  identityKey: IdentityKey,
  championMap: Map<number, ChampionSummary>,
  scores?: Map<number, number>,
): AnalyzedGame | null {
  const participant = findParticipant(game, identityKey);
  if (!participant) return null;
  return analyzeParticipant(game, participant, championMap, scores);
}

/** 已知参与者时直接计算单场数据（对局详情记分板复用） */
export function analyzeParticipant(
  game: RawGame,
  participant: RawParticipant,
  championMap: Map<number, ChampionSummary>,
  scores?: Map<number, number>,
): AnalyzedGame | null {
  const base = analyzeBase(game, participant, championMap);
  if (!base) return null;

  const scoreMap = scores ?? computeMatchScores(game, championMap);
  const score = scoreMap.get(base.participantId) ?? 0;

  const {
    participantId: _participantId,
    kdaRaw: _kdaRaw,
    damageShareRaw: _damageShareRaw,
    tankShareRaw: _tankShareRaw,
    killParticipationRaw: _killParticipationRaw,
    healShareRaw: _healShareRaw,
    largestKillingSpree,
    pentaKills,
    quadraKills,
    turretKills,
    firstBloodKill,
    ...data
  } = base;

  return {
    ...data,
    score,
    tags: gameTags({
      ...data,
      score,
      totalHeal: data.heal,
      largestKillingSpree,
      pentaKills,
      quadraKills,
      turretKills,
      firstBloodKill,
    }),
  };
}
