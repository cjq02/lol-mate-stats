import type { LiveEvent, LiveTimeline, LiveTimelineLife } from '../types.js';
import { toNumber } from '../util.js';

/** 实时轮询保存下来的本人状态快照 */
export interface LiveTimelineSample {
  /** 对局已进行秒数 */
  t: number;
  cs: number;
  level: number;
  dead: boolean;
}

/** 构建实时时间线需要的本人基础字段 */
export interface LiveTimelineSelf {
  riotId?: string;
  summonerName?: string;
  riotIdGameName?: string;
  riotIdTagLine?: string;
  isDead?: boolean;
  respawnTimer?: number;
}

function normalizeName(name?: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase();
}

function baseName(name: string): string {
  return name.split('#')[0]?.trim() ?? '';
}

/**
 * 把实时轮询快照 + 击杀事件整理成“每条命”：
 * 事件负责切分死亡/复活和 KDA，快照负责补刀/等级增量。
 * 实时接口没有伤害和经济，这里也不编造。
 */
export function buildLiveTimeline(
  rawSamples: LiveTimelineSample[],
  events: LiveEvent[] | undefined,
  self: LiveTimelineSelf,
  gameTimeSeconds: number,
): LiveTimeline {
  const now = Math.max(0, gameTimeSeconds);
  const samples = [...rawSamples].sort((a, b) => a.t - b.t);
  const dead = Boolean(self.isDead);
  if (!samples.length) {
    return { gameTimeMs: Math.round(now * 1000), lives: [], dead: dead || undefined };
  }

  const sampleAt = (time: number): LiveTimelineSample => {
    let best = samples[0]!;
    for (const sample of samples) {
      if (Math.abs(sample.t - time) < Math.abs(best.t - time)) best = sample;
    }
    return best;
  };
  const nextAlive = (after: number): number | undefined => {
    for (const sample of samples) {
      if (sample.t > after && !sample.dead) return sample.t;
    }
    return undefined;
  };

  const selfNames = [
    self.riotId,
    self.summonerName,
    self.riotIdGameName
      ? `${self.riotIdGameName}${self.riotIdTagLine ? `#${self.riotIdTagLine}` : ''}`
      : undefined,
  ]
    .map(normalizeName)
    .filter(Boolean);
  const isSelf = (name?: string): boolean => {
    const target = normalizeName(name);
    if (!target) return false;
    return selfNames.some(
      (own) => own === target || baseName(own) === baseName(target),
    );
  };

  const killEvents = (events ?? [])
    .filter((event) => event.EventName === 'ChampionKill')
    .sort((a, b) => toNumber(a.EventTime) - toNumber(b.EventTime));
  const deaths = killEvents.filter((event) => isSelf(event.VictimName));
  const kills = killEvents.filter((event) => isSelf(event.KillerName));
  const assists = killEvents.filter((event) =>
    (event.Assisters ?? []).some((name) => isSelf(name)),
  );
  const eventTime = (event: LiveEvent): number =>
    Math.min(now, Math.max(0, toNumber(event.EventTime)));
  const countEvents = (list: LiveEvent[], from: number, to: number): number =>
    list.filter((event) => {
      const t = toNumber(event.EventTime);
      return t >= from && t < to;
    }).length;

  const lives: LiveTimelineLife[] = [];
  let prevDeath: number | undefined;
  for (const death of deaths) {
    const deathAt = eventTime(death);
    if (prevDeath !== undefined && deathAt <= prevDeath) continue;
    const start =
      prevDeath === undefined
        ? 0
        : nextAlive(prevDeath) ?? Math.min(deathAt, prevDeath + 15);
    if (deathAt <= start) {
      prevDeath = deathAt;
      continue;
    }
    const startSample = sampleAt(start);
    const endSample = sampleAt(deathAt);
    lives.push({
      index: lives.length + 1,
      startMs: Math.round(start * 1000),
      endMs: Math.round(deathAt * 1000),
      aliveMs: Math.round((deathAt - start) * 1000),
      respawnMs: prevDeath === undefined ? 0 : Math.round((start - prevDeath) * 1000),
      kills: countEvents(kills, start, deathAt),
      deaths: 1,
      assists: countEvents(assists, start, deathAt),
      cs: Math.max(0, Math.round(endSample.cs - startSample.cs)),
      level: endSample.level || undefined,
      death: {
        timestampMs: Math.round(deathAt * 1000),
        killerName: death.KillerName,
        assistNames: (death.Assisters ?? []).slice(0, 5),
      },
    });
    prevDeath = deathAt;
  }

  let currentStart: number | undefined;
  if (!deaths.length) {
    currentStart = dead ? undefined : 0;
  } else if (!dead) {
    currentStart = nextAlive(prevDeath ?? 0) ?? Math.min(now, (prevDeath ?? 0) + 15);
  }
  if (!dead && currentStart !== undefined && now > currentStart) {
    const startSample = sampleAt(currentStart);
    const endSample = sampleAt(now);
    lives.push({
      index: lives.length + 1,
      startMs: Math.round(currentStart * 1000),
      endMs: Math.round(now * 1000),
      aliveMs: Math.round((now - currentStart) * 1000),
      respawnMs:
        prevDeath === undefined ? 0 : Math.round((currentStart - prevDeath) * 1000),
      kills: countEvents(kills, currentStart, now),
      deaths: 0,
      assists: countEvents(assists, currentStart, now),
      cs: Math.max(0, Math.round(endSample.cs - startSample.cs)),
      level: endSample.level || undefined,
    });
  }

  return {
    gameTimeMs: Math.round(now * 1000),
    lives,
    dead: dead || undefined,
    respawnTimer: dead ? toNumber(self.respawnTimer) || undefined : undefined,
  };
}
