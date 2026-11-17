import type {
  MatchTimeline,
  MatchTimelineChampionCount,
  MatchTimelineDeath,
  MatchTimelineEvent,
  MatchTimelineLife,
  MatchTimelinePlayer,
  RawGame,
  RawGameTimeline,
  RawGameTimelineEvent,
  RawGameTimelineFrame,
} from '../types.js';
import { toNumber } from '../util.js';

interface FrameSample {
  t: number;
  cs: number;
  gold: number;
  level?: number;
}

interface PlayerMeta {
  participantId: number;
  puuid?: string;
  name: string;
  championId: number;
  championName?: string;
  teamId: number;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  damageTaken: number;
}

/**
 * 各等级的基础复活等待（秒）。
 * 取自当前版本的死亡计时表；15 分钟后按游戏时间放大，仅用于时间线展示。
 */
const BASE_RESPAWN_SECONDS = [
  10, 10, 12, 12, 14, 16, 20, 25, 28, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5,
];

/** 估算复活等待：等级基础值 + 15 分钟后的游戏时间放大 */
export function estimateRespawnMs(level: number, atMs: number): number {
  const lv = Math.min(18, Math.max(1, Math.round(level) || 1));
  const base = BASE_RESPAWN_SECONDS[lv - 1] ?? 20;
  const minutes = Math.max(0, atMs / 60_000);
  let bonus = 0;
  if (minutes > 15) bonus += Math.min(15, minutes - 15) * 0.0085;
  if (minutes > 30) bonus += (minutes - 30) * 0.006;
  return Math.round(base * Math.min(1.35, 1 + bonus) * 1000);
}

/** 在分钟快照之间做线性插值，得到任意时刻的累计补刀/金币 */
function sampleAt(samples: FrameSample[], timeMs: number): { cs: number; gold: number } {
  if (!samples.length) return { cs: 0, gold: 0 };
  const t = Math.max(0, timeMs);
  const first = samples[0]!;
  if (t <= first.t) return { cs: first.cs, gold: first.gold };
  const last = samples[samples.length - 1]!;
  if (t >= last.t) return { cs: last.cs, gold: last.gold };

  let lo = 0;
  let hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const span = b.t - a.t;
  const ratio = span > 0 ? (t - a.t) / span : 0;
  return {
    cs: a.cs + (b.cs - a.cs) * ratio,
    gold: a.gold + (b.gold - a.gold) * ratio,
  };
}

/** 取离指定时刻最近的等级快照 */
function nearestLevel(samples: FrameSample[], timeMs: number): number | undefined {
  let best: FrameSample | undefined;
  for (const sample of samples) {
    if (!sample.level) continue;
    if (!best || Math.abs(sample.t - timeMs) < Math.abs(best.t - timeMs)) best = sample;
  }
  return best?.level;
}

function buildSamples(
  frames: RawGameTimelineFrame[],
  participantId: number,
): FrameSample[] {
  const samples: FrameSample[] = [{ t: 0, cs: 0, gold: 0, level: 1 }];
  for (const frame of frames) {
    const t = toNumber(frame.timestamp);
    const framePlayer = frame.participantFrames?.[String(participantId)];
    if (!framePlayer || t <= 0) continue;
    samples.push({
      t,
      cs: toNumber(framePlayer.minionsKilled) + toNumber(framePlayer.jungleMinionsKilled),
      gold: toNumber(framePlayer.totalGold),
      level: toNumber(framePlayer.level) || undefined,
    });
  }
  return samples.sort((a, b) => a.t - b.t);
}

function playerMetas(
  game: RawGame,
  championNames: Map<number, string>,
): PlayerMeta[] {
  const identityByPid = new Map<
    number,
    NonNullable<RawGame['participantIdentities']>[number]['player']
  >();
  for (const identity of game.participantIdentities ?? []) {
    const pid = toNumber(identity.participantId);
    if (pid > 0) identityByPid.set(pid, identity.player);
  }

  const players: PlayerMeta[] = [];
  for (const participant of game.participants ?? []) {
    const participantId = toNumber(participant.participantId);
    if (!participantId) continue;
    const player = identityByPid.get(participantId);
    const name = player?.gameName
      ? `${player.gameName}${player.tagLine ? `#${player.tagLine}` : ''}`
      : String(player?.summonerName ?? `玩家 ${participantId}`);
    const stats = participant.stats ?? {};
    const championId = toNumber(participant.championId);
    players.push({
      participantId,
      puuid: typeof player?.puuid === 'string' ? player.puuid : undefined,
      name,
      championId,
      championName: championNames.get(championId),
      teamId: toNumber(participant.teamId),
      kills: toNumber(stats.kills),
      deaths: toNumber(stats.deaths),
      assists: toNumber(stats.assists),
      damage: toNumber(stats.totalDamageDealtToChampions),
      damageTaken: toNumber(stats.totalDamageTaken),
    });
  }
  return players;
}

/** 同一个击杀事件在时间线里只出现一次 */
function championKillEvents(frames: RawGameTimelineFrame[]): RawGameTimelineEvent[] {
  const seen = new Set<string>();
  const events: RawGameTimelineEvent[] = [];
  for (const frame of frames) {
    for (const event of frame.events ?? []) {
      if (event.type !== 'CHAMPION_KILL') continue;
      const key = `${toNumber(event.timestamp)}:${toNumber(event.killerId)}:${toNumber(
        event.victimId,
      )}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return events.sort((a, b) => toNumber(a.timestamp) - toNumber(b.timestamp));
}

function deathInfo(
  event: RawGameTimelineEvent,
  playersById: Map<number, PlayerMeta>,
): MatchTimelineDeath {
  const killerId = toNumber(event.killerId) || undefined;
  const assistIds = (event.assistingParticipantIds ?? [])
    .map((id) => toNumber(id))
    .filter((id) => id > 0);
  const x = toNumber(event.position?.x);
  const y = toNumber(event.position?.y);
  return {
    timestampMs: toNumber(event.timestamp),
    killerId,
    killerName: killerId ? playersById.get(killerId)?.name : undefined,
    assistIds,
    assistNames: assistIds
      .map((id) => playersById.get(id)?.name)
      .filter((name): name is string => Boolean(name)),
    position: x > 0 && y > 0 ? { x, y } : undefined,
  };
}

/** 把击杀/助攻事件转成时间线里可展示的目标英雄 */
function lifeEventInfo(
  event: RawGameTimelineEvent,
  type: 'kill' | 'assist',
  playersById: Map<number, PlayerMeta>,
): MatchTimelineEvent {
  const victimId = toNumber(event.victimId);
  const victim = playersById.get(victimId);
  const killerId = type === 'assist' ? toNumber(event.killerId) || undefined : undefined;
  const killer = killerId ? playersById.get(killerId) : undefined;
  const assistIds = (event.assistingParticipantIds ?? [])
    .map((id) => toNumber(id))
    .filter((id) => id > 0);
  const assistPlayers = assistIds.map((id) => playersById.get(id));
  return {
    type,
    timestampMs: Math.round(toNumber(event.timestamp)),
    participantId: victimId,
    championId: victim?.championId ?? 0,
    championName: victim?.championName,
    killerParticipantId: killerId,
    killerChampionId: killer?.championId,
    killerChampionName: killer?.championName,
    assistParticipantIds: assistIds,
    assistChampionIds: assistPlayers.map((player) => player?.championId ?? 0),
    assistChampionNames: assistPlayers.map((player) => player?.championName ?? ''),
  };
}

function buildLives(
  deaths: RawGameTimelineEvent[],
  kills: RawGameTimelineEvent[],
  assists: RawGameTimelineEvent[],
  samples: FrameSample[],
  durationMs: number,
  playersById: Map<number, PlayerMeta>,
): MatchTimelineLife[] {
  const lives: MatchTimelineLife[] = [];
  let start = 0;
  let respawnMs = 0;
  let lastLevel = 1;

  const addLife = (endMs: number, death?: RawGameTimelineEvent): void => {
    const end = Math.max(start, Math.min(durationMs, endMs));
    const startSnap = sampleAt(samples, start);
    const endSnap = sampleAt(samples, end);
    const level = nearestLevel(samples, end) ?? lastLevel;
    lastLevel = level;
    const respawnAfter = death ? estimateRespawnMs(level, end) : 0;
    const assistEnd = Math.min(durationMs, end + respawnAfter);
    const lifeKills = kills.filter((event) => {
      const t = toNumber(event.timestamp);
      return t >= start && t < end;
    });
    const lifeAssists = assists.filter((event) => {
      const t = toNumber(event.timestamp);
      return t >= start && t < assistEnd;
    });
    const events: MatchTimelineEvent[] = [
      ...lifeKills.map((event) => lifeEventInfo(event, 'kill', playersById)),
      ...lifeAssists.map((event) => lifeEventInfo(event, 'assist', playersById)),
    ].sort((a, b) => a.timestampMs - b.timestampMs);
    lives.push({
      index: lives.length + 1,
      startMs: Math.round(start),
      endMs: Math.round(end),
      respawnMs: Math.round(respawnMs),
      aliveMs: Math.max(0, Math.round(end - start)),
      kills: lifeKills.length,
      assists: lifeAssists.length,
      cs: Math.max(0, Math.round(endSnap.cs - startSnap.cs)),
      gold: Math.max(0, Math.round(endSnap.gold - startSnap.gold)),
      level,
      events,
      death: death ? deathInfo(death, playersById) : undefined,
    });
  };

  for (const death of deaths) {
    const t = Math.min(durationMs, toNumber(death.timestamp));
    if (t <= start) continue;
    addLife(t, death);
    const level = nearestLevel(samples, t) ?? lastLevel;
    respawnMs = estimateRespawnMs(level, t);
    start = t + respawnMs;
    if (start >= durationMs) break;
  }

  if (!deaths.length) {
    addLife(durationMs);
  } else if (durationMs - start > 1_000) {
    addLife(durationMs);
  }
  return lives;
}

/**
 * 把 LCU 对局时间线解析成“每条命”：
 * 阵亡事件切分时间段，分钟快照提供补刀/金币增量，等级用于估算复活等待。
 * 官方时间线没有伤害字段，伤害/承伤只能保留整局总数。
 */
export function parseMatchTimeline(
  game: RawGame,
  raw: RawGameTimeline,
  championNames: Map<number, string> = new Map(),
): MatchTimeline {
  const frames = [...(raw.frames ?? [])].sort(
    (a, b) => toNumber(a.timestamp) - toNumber(b.timestamp),
  );
  const metas = playerMetas(game, championNames);
  const playersById = new Map(metas.map((meta) => [meta.participantId, meta]));
  const events = championKillEvents(frames);
  const lastFrameMs = toNumber(frames[frames.length - 1]?.timestamp);
  const rawDuration = toNumber(game.gameDuration);
  const gameDurationMs = rawDuration > 100_000 ? rawDuration : rawDuration * 1000;
  const durationMs = Math.max(0, lastFrameMs, gameDurationMs);

  const players: MatchTimelinePlayer[] = metas.map((meta) => {
    const deaths = events.filter(
      (event) => toNumber(event.victimId) === meta.participantId,
    );
    const kills = events.filter(
      (event) => toNumber(event.killerId) === meta.participantId,
    );
    const assists = events.filter((event) =>
      (event.assistingParticipantIds ?? [])
        .map((id) => toNumber(id))
        .includes(meta.participantId),
    );
    const countChampions = (ids: number[]): MatchTimelineChampionCount[] => {
      const counts = new Map<number, number>();
      for (const id of ids) {
        if (id > 0) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([participantId, count]) => {
          const target = playersById.get(participantId);
          return {
            championId: target?.championId ?? 0,
            championName: target?.championName,
            count,
          };
        })
        .sort((a, b) => b.count - a.count || a.championId - b.championId);
    };
    return {
      ...meta,
      killedBy: countChampions(deaths.map((event) => toNumber(event.killerId))),
      assistedBy: countChampions(
        deaths.flatMap((event) =>
          (event.assistingParticipantIds ?? []).map((id) => toNumber(id)),
        ),
      ),
      killedChampions: countChampions(
        kills.map((event) => toNumber(event.victimId)),
      ),
      assistedChampions: countChampions(
        assists.map((event) => toNumber(event.victimId)),
      ),
      lives: buildLives(
        deaths,
        kills,
        assists,
        buildSamples(frames, meta.participantId),
        durationMs,
        playersById,
      ),
    };
  });

  return { gameId: toNumber(game.gameId), durationMs, players };
}
