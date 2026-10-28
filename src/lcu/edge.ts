import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import type { LcuConnection } from '../types.js';
import { candidateLogDirs } from './discover.js';

/** 单个客户端会话里的战绩请求统计 */
export interface EdgeRequestStats {
  file: string;
  total: number;
  failed: number;
  codes: Record<number, number>;
  /** 最后一次失败的时间（ISO） */
  lastFailureAt?: string;
  lastError?: string;
}

export interface EdgeDiagnostics {
  logDir: string;
  /** 客户端实际使用的 Player Platform Edge 地址 */
  edgeUrl?: string;
  /** 最新一个客户端会话里的战绩请求数（可能是 0） */
  newestTotal: number;
  /** 最新会话里失败的请求数 */
  newestFailed: number;
  sessions: EdgeRequestStats[];
}

/**
 * 客户端插件日志在 `<安装目录>/Game/Logs/LeagueClient Logs/`，
 * 而 discover 拿到的是 `<安装目录>/LeagueClient`，这里两种都能兜住。
 */
export async function findClientLogDir(
  connection?: Pick<LcuConnection, 'source'>,
): Promise<string | null> {
  const candidates = new Set<string>();

  const fromSource = /^log \((.+)\)$/.exec(connection?.source ?? '')?.[1];
  if (fromSource) {
    const installDir = dirname(dirname(fromSource));
    candidates.add(join(installDir, 'Game', 'Logs', 'LeagueClient Logs'));
  }

  try {
    for (const dir of await candidateLogDirs()) {
      candidates.add(join(dir, 'Game', 'Logs', 'LeagueClient Logs'));
      candidates.add(join(dir, '..', 'Game', 'Logs', 'LeagueClient Logs'));
    }
  } catch {
    /* 目录枚举失败不影响其它候选 */
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

/** 从最近的客户端日志里还原 edge 地址与战绩请求的失败情况 */
export async function readEdgeDiagnostics(
  logDir: string,
  sessionLimit = 4,
): Promise<EdgeDiagnostics> {
  let names: string[] = [];
  try {
    const entries = await readdir(logDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && /_LeagueClient\.log$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return { logDir, newestTotal: 0, newestFailed: 0, sessions: [] };
  }

  const diagnostics: EdgeDiagnostics = {
    logDir,
    newestTotal: 0,
    newestFailed: 0,
    sessions: [],
  };

  for (const [index, name] of names.slice(0, sessionLimit).entries()) {
    let text = '';
    try {
      text = await readFile(join(logDir, name), 'utf8');
    } catch {
      continue;
    }

    if (!diagnostics.edgeUrl) {
      const edge = /PlayerPlatformEdgeUrl via ClientConfig:\s*(\S+)/.exec(text)?.[1];
      if (edge) diagnostics.edgeUrl = edge;
    }

    const stats: EdgeRequestStats = { file: name, total: 0, failed: 0, codes: {} };
    const startedAt = sessionStartTime(name);
    let lastFailureOffset: number | undefined;
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('ExternalWebRequest') || !line.includes('match-history-query')) continue;
      stats.total += 1;
      const code = Number(/"responseCode":(\d+)/.exec(line)?.[1] ?? 0);
      stats.codes[code] = (stats.codes[code] ?? 0) + 1;
      if (code < 200 || code >= 300) {
        stats.failed += 1;
        const offset = Number(/^(\d+(?:\.\d+)?)\|/.exec(line)?.[1] ?? NaN);
        if (Number.isFinite(offset)) lastFailureOffset = offset;
      }
    }
    if (startedAt && lastFailureOffset !== undefined) {
      stats.lastFailureAt = new Date(startedAt.getTime() + lastFailureOffset * 1000).toISOString();
    }

    const errorLines = text
      .split(/\r?\n/)
      .filter((line) => line.includes('GetMatchHistoryDataBatch failed'));
    const lastError = errorLines.at(-1);
    if (lastError) {
      const message = /GetMatchHistoryDataBatch failed:\s*(.{0,160})/.exec(lastError)?.[1];
      if (message) stats.lastError = message.trim();
    }

    if (stats.total > 0) diagnostics.sessions.push(stats);
    if (index === 0) {
      diagnostics.newestTotal = stats.total;
      diagnostics.newestFailed = stats.failed;
    }
  }

  return diagnostics;
}

/** 日志文件名以会话开始时间开头：2026-10-29T00-29-42_13904_19684 */
function sessionStartTime(name: string): Date | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!match) return undefined;
  return new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`);
}

export interface EdgeProbeResult {
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}

/**
 * 只验证 edge 是否可达：不带鉴权请求会返回 401/403，能拿到任何 HTTP 响应就说明网络通。
 * 真正失败（503 "Response timed out"）是 edge 后面的战绩服务，不在这一层。
 */
export function probeEdge(edgeUrl: string, timeoutMs = 8_000): Promise<EdgeProbeResult> {
  const started = Date.now();
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (result: EdgeProbeResult) => {
      if (settled) return;
      settled = true;
      resolveProbe(result);
    };

    let url: URL;
    try {
      url = new URL(`${edgeUrl.replace(/\/$/, '')}/match-history-query/v1/products/lol/player/doctor/SUMMARY`);
    } catch {
      finish({ ok: false, ms: 0, error: '地址格式不正确' });
      return;
    }

    const req = https.request(
      {
        host: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        response.on('end', () =>
          finish({ ok: true, status: response.statusCode, ms: Date.now() - started }),
        );
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, ms: Date.now() - started, error: `连接超时（${timeoutMs}ms）` });
    });
    req.on('error', (error) =>
      finish({ ok: false, ms: Date.now() - started, error: error.message }),
    );
    req.end();
  });
}
