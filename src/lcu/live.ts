import { request } from 'node:https';
import type { LiveGameData, LiveGamePlayer, LiveMember } from '../types.js';

/** 游戏内 Live Client Data API 固定端口 */
const DEFAULT_LIVE_PORT = 2999;

/**
 * 只在对局中可用：按“己方 5 人 → 敌方 5 人”的顺序返回本局 10 名玩家。
 * 无法判断当前队伍时，按接口返回顺序前 5 人视为己方。
 */
export function liveMembersOf(
  allPlayers: LiveGamePlayer[],
  activePlayer?: { riotId?: string; summonerName?: string },
): LiveMember[] {
  const name = activePlayer?.riotId || activePlayer?.summonerName || '';
  const self = allPlayers.find((player) => sameLiveName(player, name));
  const allyTeam = self?.team;
  const allies = allyTeam ? allPlayers.filter((player) => player.team === allyTeam) : allPlayers.slice(0, 5);
  const enemies = allyTeam ? allPlayers.filter((player) => player.team !== allyTeam) : allPlayers.slice(5, 10);

  return [
    ...allies.map((player) => ({ ...player, isEnemy: false })),
    ...enemies.map((player) => ({ ...player, isEnemy: true })),
  ];
}

export function sameLiveName(
  player: { riotId?: string; summonerName?: string },
  name: string,
): boolean {
  if (!name) return false;
  const target = name.toLowerCase();
  return [player.riotId, player.summonerName].some(
    (value) => typeof value === 'string' && value.toLowerCase() === target,
  );
}

/**
 * 读取本局实时数据。只在对局进行中（InProgress）可用。
 * 该接口不需要认证，但证书是自签名的。
 */
export function fetchLiveGame(timeoutMs = 3_000): Promise<LiveGameData | null> {
  const port = Number(process.env.LOL_LIVE_PORT) || DEFAULT_LIVE_PORT;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: LiveGameData | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/liveclientdata/allgamedata',
        method: 'GET',
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: { Accept: 'application/json' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(null);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
          // 防御异常大的响应
          if (body.length > 8 * 1024 * 1024) {
            req.destroy();
            finish(null);
          }
        });
        response.on('end', () => {
          try {
            const data = JSON.parse(body) as LiveGameData;
            if (!Array.isArray(data?.allPlayers) || !data.allPlayers.length) {
              finish(null);
              return;
            }
            finish(data);
          } catch {
            finish(null);
          }
        });
      },
    );

    req.on('error', () => finish(null));
    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });
    req.end();
  });
}
