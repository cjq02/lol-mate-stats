import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DataSource } from './source.js';
import type { GameContext, GameModeKey } from './types.js';
import { buildAnalysisMessages, buildLiveAnalysisMessages, getAiConfig, streamChatCompletion } from './ai.js';
import {
  DATA_DIR,
  getAiAnalysis,
  getLiveAiAnalysis,
  getLiveAiAnalysisByGame,
  linkLiveAnalysisToGameByArchive,
  saveAiAnalysis,
  saveLiveAiAnalysis,
} from './stats/store.js';
import { logTag, mapLimit } from './util.js';

const execFileAsync = promisify(execFile);

export interface ServerOptions {
  source: DataSource;
  port: number;
  host?: string;
  open?: boolean;
  quiet?: boolean;
}

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

const STATIC_FILES = new Set(['/', '/index.html', '/app.js', '/style.css']);
const fileCache = new Map<string, { body: Buffer; type: string }>();
const assetCache = new Map<string, { at: number; result: { body: Buffer; contentType: string } }>();
const ASSET_TTL = 60 * 60_000;
/** 装备图标等静态资源落盘，客户端关闭后也能显示 */
const ASSET_DIR = join(DATA_DIR, 'assets');
const ITEMS_ASSET_PATH = '/lol-game-data/assets/v1/items.json';
const ITEMS_DISK_PATH = join(ASSET_DIR, 'items.json');
const ITEMS_PREFETCH_MARKER = join(ASSET_DIR, 'items-prefetch.json');
type ItemTable = Record<string, { icon: string; name: string; price: number }>;
let itemsCache: { at: number; items: ItemTable } | undefined;
let itemPrefetch: Promise<void> | undefined;
const ASSET_CACHE_LIMIT = 300;

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const source = options.source;
  const host = options.host ?? '127.0.0.1';
  const clients = new Set<ServerResponse>();

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, source, clients).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  const port = await listenFixed(server, options.port, host);
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

  if (!options.quiet) {
    logTag('web', `面板已启动：${url}${options.open ? '（正在打开浏览器…）' : ''}`);
  }
  if (options.open) openBrowser(url);

  return {
    port,
    url,
    close: async () => {
      for (const client of clients) client.end();
      clients.clear();
      // 关闭 keep-alive 连接，避免旧进程退出时卡住端口
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  source: DataSource,
  clients: Set<ServerResponse>,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (method === 'GET' && STATIC_FILES.has(url.pathname)) {
    await serveStatic(url.pathname === '/' ? '/index.html' : url.pathname, res);
    return;
  }

  if (method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  if (method === 'GET' && url.pathname === '/api/snapshot') {
    sendJson(res, 200, source.getSnapshot());
    return;
  }

  if (method === 'GET' && url.pathname === '/api/health') {
    const snapshot = source.getSnapshot();
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      mode: snapshot.mode,
      phase: snapshot.phase,
      inChampSelect: snapshot.inChampSelect,
      updatedAt: snapshot.updatedAt,
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/ai/status') {
    const config = getAiConfig();
    sendJson(res, 200, {
      ok: true,
      enabled: config.enabled,
      model: config.model,
      opencode: config.opencode,
      hint: config.enabled
        ? undefined
        : '在项目根目录的 .env 中设置 LOL_MATE_AI_API_KEY=你的 OpenCode Go API Key，然后重启面板。',
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/live/ai') {
    const snapshot = source.getSnapshot();
    const sessionKey = snapshot.inGame ? snapshot.liveSessionId : undefined;
    sendJson(res, 200, {
      ok: true,
      analysis: sessionKey ? (await getLiveAiAnalysis(sessionKey)) ?? null : null,
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/live/ai') {
    const config = getAiConfig();
    if (!config.enabled) {
      sendJson(res, 400, {
        ok: false,
        code: 'ai-not-configured',
        error:
          'AI 分析未启用：请在项目根目录的 .env 里设置 LOL_MATE_AI_API_KEY=你的 OpenCode Go API Key，然后重启面板。',
      });
      return;
    }
    const snapshot = source.getSnapshot();
    if (
      !snapshot.inGame ||
      !snapshot.players?.length ||
      !snapshot.liveSessionId ||
      !snapshot.localPlayer
    ) {
      sendJson(res, 400, {
        ok: false,
        error: '本局数据还没准备好，请稍后再试。',
      });
      return;
    }

    const sessionKey = snapshot.liveSessionId;
    const started = Date.now();
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.on('error', () => undefined);
    res.flushHeaders?.();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort(new Error('客户端已断开'));
    });
    const sendEvent = (payload: unknown): void => {
      if (abort.signal.aborted || res.writableEnded) return;
      res.write(`${JSON.stringify(payload)}\n`);
    };

    logTag('ai', `开始分析进行中的对局（${config.model}）…`);
    try {
      sendEvent({ type: 'status', text: '正在整理本局阵容和实时数据…' });
      const items = await loadItemTable(source).catch(() => null);
      const itemName = (id: number): string => items?.[String(id)]?.name ?? '';
      const messages = buildLiveAnalysisMessages(snapshot, itemName);

      sendEvent({ type: 'status', text: '正在生成出装和打法建议…' });
      let content = '';
      await streamChatCompletion(
        config,
        messages,
        (text) => {
          content += text;
          sendEvent({ type: 'delta', text });
        },
        abort.signal,
        `lol-mate-live-${sessionKey}`,
      );
      if (!content.trim()) {
        throw new Error('AI 没有返回正式内容（可能推理被截断），请点「重新分析」再试一次。');
      }
      const saved =
        !abort.signal.aborted &&
        (await saveLiveAiAnalysis(sessionKey, config.model, content.trim()));
      sendEvent({ type: 'done', model: config.model, saved });
      logTag(
        'ai',
        `进行中对局分析完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s${
          saved ? '，已保存到数据库' : ''
        }`,
      );
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        sendEvent({ type: 'error', error: message });
        logTag('ai', `进行中对局分析失败：${message}`);
      }
    }
    if (!res.writableEnded) res.end();
    return;
  }

  if (method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const send = (snapshot: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };

    clients.add(res);
    send(source.getSnapshot());
    const unsubscribe = source.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      clients.delete(res);
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/cache/clear') {
    if (!source.clearCache) {
      sendJson(res, 501, { ok: false, error: '当前模式不支持缓存操作' });
      return;
    }
    source.clearCache();
    logTag('api', '已清空战绩缓存');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/refresh') {
    try {
      await source.refresh();
      sendJson(res, 200, { ok: true, snapshot: source.getSnapshot() });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/scan') {
    if (!source.scanPlayer) {
      sendJson(res, 501, { ok: false, error: '当前模式不支持查询玩家' });
      return;
    }
    const name = (url.searchParams.get('name') ?? '').trim();
    if (!name) {
      sendJson(res, 400, { ok: false, error: '请输入玩家名称（游戏名#TAG）' });
      return;
    }
    const rawRecent = Number(url.searchParams.get('recent') ?? 10);
    const recent = Number.isFinite(rawRecent)
      ? Math.min(30, Math.max(1, Math.trunc(rawRecent)))
      : 10;
    try {
      logTag('api', `查询玩家 ${name}（最近 ${recent} 场）…`);
      const players = await source.scanPlayer(name, recent);
      logTag('api', `查询玩家 ${name} 完成：${players.length} 人`);
      sendJson(res, 200, { ok: true, players });
    } catch (error) {
      logTag(
        'api',
        `查询玩家 ${name} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
      sendJson(res, 502, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/player/refresh') {
    if (!source.refreshPlayer) {
      sendJson(res, 501, { ok: false, error: '当前模式不支持更新玩家战绩' });
      return;
    }
    const summonerId = Number(url.searchParams.get('summonerId'));
    if (!Number.isFinite(summonerId) || summonerId <= 0) {
      sendJson(res, 400, { ok: false, error: '缺少有效的 summonerId' });
      return;
    }
    const rawRecent = Number(url.searchParams.get('recent') ?? 0);
    const recent =
      Number.isFinite(rawRecent) && rawRecent > 0
        ? Math.min(30, Math.max(1, Math.trunc(rawRecent)))
        : undefined;
    const rawQueueId = Number(url.searchParams.get('queueId') ?? 0);
    const queueId =
      Number.isFinite(rawQueueId) && rawQueueId > 0 ? rawQueueId : undefined;
    const rawMode = url.searchParams.get('mode');
    const mode: GameModeKey | undefined =
      rawMode === 'SR' || rawMode === 'ARAM' || rawMode === 'ARENA' ? rawMode : undefined;
    const context: GameContext | undefined = queueId || mode ? { queueId, mode } : undefined;
    try {
      logTag('api', `更新玩家战绩：summonerId=${summonerId}`);
      const player = await source.refreshPlayer(summonerId, { recent, context });
      logTag('api', `更新玩家战绩完成：${player.displayName}`);
      sendJson(res, 200, { ok: true, player });
    } catch (error) {
      logTag(
        'api',
        `更新玩家战绩失败：${error instanceof Error ? error.message : String(error)}`,
      );
      sendJson(res, 502, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/me/matches') {
    if (!source.getMyMatches) {
      sendJson(res, 501, { ok: false, error: '当前模式不支持查询战绩' });
      return;
    }
    const rawRecent = Number(url.searchParams.get('recent') ?? 10);
    const recent = Number.isFinite(rawRecent)
      ? Math.min(100, Math.max(1, Math.trunc(rawRecent)))
      : 10;
    const rawOffset = Number(url.searchParams.get('offset') ?? 0);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
    try {
      const data = await source.getMyMatches(recent, offset);
      sendJson(res, 200, { ok: true, ...data });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/archive/matches') {
    if (!source.getArchivedMatches) {
      sendJson(res, 501, { ok: false, error: '当前模式不支持历史存档' });
      return;
    }
    const rawLimit = Number(url.searchParams.get('limit') ?? 100);
    const rawOffset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(200, Math.max(1, Math.trunc(rawLimit)))
      : 100;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
    const puuid = url.searchParams.get('puuid')?.trim() || undefined;
    const rawChampionId = Number(url.searchParams.get('championId') ?? 0);
    const championId =
      Number.isFinite(rawChampionId) && rawChampionId > 0
        ? Math.trunc(rawChampionId)
        : undefined;
    const rawMode = url.searchParams.get('mode');
    const mode: GameModeKey | undefined =
      rawMode === 'SR' || rawMode === 'ARAM' || rawMode === 'ARENA' ? rawMode : undefined;
    try {
      const data = await source.getArchivedMatches(limit, offset, puuid, {
        championId,
        mode,
      });
      sendJson(res, 200, { ok: true, ...data });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/archive/champions') {
    if (!source.getArchivedChampionScores) {
      sendJson(res, 501, { ok: false, error: '当前模式不支持英雄评分排名' });
      return;
    }
    const puuid = url.searchParams.get('puuid')?.trim() || undefined;
    const rawMinGames = Number(url.searchParams.get('minGames') ?? 1);
    const minGames = Number.isFinite(rawMinGames)
      ? Math.min(100, Math.max(1, Math.trunc(rawMinGames)))
      : 1;
    const rawMode = url.searchParams.get('mode');
    const mode: GameModeKey | undefined =
      rawMode === 'SR' || rawMode === 'ARAM' || rawMode === 'ARENA' ? rawMode : undefined;
    try {
      const data = await source.getArchivedChampionScores(puuid, minGames, mode);
      sendJson(res, 200, { ok: true, ...data });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/archive/record') {
    if (!source.getArchivedWinRecord) {
      sendJson(res, 501, { ok: false, error: '当前模式不支持历史胜率' });
      return;
    }
    const puuid = url.searchParams.get('puuid')?.trim() || undefined;
    const rawQueueId = Number(url.searchParams.get('queueId') ?? 0);
    const queueId =
      Number.isFinite(rawQueueId) && rawQueueId > 0 ? rawQueueId : undefined;
    const rawMode = url.searchParams.get('mode');
    const mode: GameModeKey | undefined =
      rawMode === 'SR' || rawMode === 'ARAM' || rawMode === 'ARENA' ? rawMode : undefined;
    const rawChampionId = Number(url.searchParams.get('championId') ?? 0);
    const championId =
      Number.isFinite(rawChampionId) && rawChampionId > 0 ? rawChampionId : undefined;
    try {
      const data = await source.getArchivedWinRecord(puuid, queueId, mode, championId);
      sendJson(res, 200, { ok: true, ...data });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const matchStreamRoute = /^\/api\/match\/(\d+)\/stream$/.exec(url.pathname);
  if (method === 'GET' && matchStreamRoute) {
    if (!source.getMatchDetail) {
      sendJson(res, 501, { ok: false, error: '当前模式不支持查询战绩' });
      return;
    }
    const gameId = Number(matchStreamRoute[1]);
    const rawRecent = Number(url.searchParams.get('recent') ?? 10);
    const recent = Number.isFinite(rawRecent)
      ? Math.min(30, Math.max(1, Math.trunc(rawRecent)))
      : 10;
    const force = url.searchParams.get('refresh') === '1';
    const started = Date.now();

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.on('error', () => undefined);
    res.flushHeaders?.();
    const sendEvent = (payload: unknown): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(payload)}\n`);
    };

    logTag('api', `流式读取对局 ${gameId} 详情（最近 ${recent} 场）…`);
    try {
      const detail = await source.getMatchDetail(gameId, recent, (done, total, name) => {
        sendEvent({ type: 'progress', done, total, name });
      }, { force });
      sendEvent({ type: 'done', data: detail });
      logTag(
        'api',
        `流式读取对局 ${gameId} 完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendEvent({ type: 'error', error: message });
      logTag('api', `流式读取对局 ${gameId} 失败：${message}`);
    }
    res.end();
    return;
  }

  const matchRoute = /^\/api\/match\/(\d+)$/.exec(url.pathname);
  if (method === 'GET' && matchRoute) {
    if (!source.getMatchDetail) {
      sendJson(res, 501, { ok: false, error: '当前模式不支持查询战绩' });
      return;
    }
    const gameId = Number(matchRoute[1]);
    const rawRecent = Number(url.searchParams.get('recent') ?? 10);
    const recent = Number.isFinite(rawRecent)
      ? Math.min(30, Math.max(1, Math.trunc(rawRecent)))
      : 10;
    const force = url.searchParams.get('refresh') === '1';
    try {
      logTag('api', `读取对局 ${gameId} 详情（最近 ${recent} 场）…`);
      const detail = await source.getMatchDetail(gameId, recent, undefined, { force });
      sendJson(res, 200, { ok: true, ...detail });
    } catch (error) {
      logTag(
        'api',
        `读取对局 ${gameId} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
      sendJson(res, 502, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const matchAiRoute = /^\/api\/match\/(\d+)\/ai$/.exec(url.pathname);
  if (method === 'GET' && matchAiRoute) {
    const gameId = Number(matchAiRoute[1]);
    await linkLiveAnalysisToGameByArchive(gameId);
    const [analysis, liveAnalysis] = await Promise.all([
      getAiAnalysis(gameId),
      getLiveAiAnalysisByGame(gameId),
    ]);
    sendJson(res, 200, {
      ok: true,
      analysis: analysis ?? null,
      liveAnalysis: liveAnalysis ?? null,
    });
    return;
  }
  if (method === 'POST' && matchAiRoute) {
    if (!source.getMatchDetail) {
      sendJson(res, 501, { ok: false, error: '当前模式不支持 AI 分析' });
      return;
    }
    const config = getAiConfig();
    if (!config.enabled) {
      sendJson(res, 400, {
        ok: false,
        code: 'ai-not-configured',
        error:
          'AI 分析未启用：请在项目根目录的 .env 里设置 LOL_MATE_AI_API_KEY=你的 OpenCode Go API Key，然后重启面板。',
      });
      return;
    }

    const gameId = Number(matchAiRoute[1]);
    const started = Date.now();
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.on('error', () => undefined);
    res.flushHeaders?.();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort(new Error('客户端已断开'));
    });
    const sendEvent = (payload: unknown): void => {
      if (abort.signal.aborted || res.writableEnded) return;
      res.write(`${JSON.stringify(payload)}\n`);
    };

    logTag('ai', `开始分析对局 ${gameId}（${config.model}）…`);
    try {
      sendEvent({ type: 'status', text: '正在整理本局数据…' });
      const detail = await source.getMatchDetail(
        gameId,
        10,
        (done, total) => {
          if (done > 0 && done < total) {
            sendEvent({ type: 'progress', done, total });
          }
        },
      );
      const items = await loadItemTable(source).catch(() => null);
      const itemName = (id: number): string => items?.[String(id)]?.name ?? '';
      const messages = buildAnalysisMessages(detail, itemName);

      sendEvent({ type: 'status', text: '正在生成复盘分析…' });
      let content = '';
      await streamChatCompletion(
        config,
        messages,
        (text) => {
          content += text;
          sendEvent({ type: 'delta', text });
        },
        abort.signal,
        `lol-mate-match-${gameId}`,
      );
      const saved =
        !abort.signal.aborted && content.trim()
          ? await saveAiAnalysis(gameId, config.model, content.trim())
          : false;
      if (!content.trim()) {
        throw new Error('AI 没有返回正式内容（可能推理被截断），请点「重新分析」再试一次。');
      }
      sendEvent({ type: 'done', model: config.model, saved });
      logTag(
        'ai',
        `对局 ${gameId} 分析完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s${
          saved ? '，已保存到数据库' : ''
        }`,
      );
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        sendEvent({ type: 'error', error: message });
        logTag('ai', `对局 ${gameId} 分析失败：${message}`);
      }
    }
    if (!res.writableEnded) res.end();
    return;
  }

  if (method === 'GET' && url.pathname === '/api/items') {
    const items = await loadItemTable(source);
    if (!items) {
      sendJson(res, 404, { ok: false, error: '无法读取装备数据' });
      return;
    }
    sendJson(res, 200, { ok: true, items });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/asset') {
    const path = url.searchParams.get('path') ?? '';
    if (!path.startsWith('/lol-game-data/assets/') || path.includes('..')) {
      sendJson(res, 400, { error: '非法的资源路径' });
      return;
    }
    const cached = assetCache.get(path);
    if (cached && Date.now() - cached.at < ASSET_TTL) {
      sendAsset(res, cached.result);
      return;
    }

    // 客户端可用时以客户端为准；读不到时用磁盘缓存（离线/重启后也能用）
    let result = await source.getAsset(path);
    if (result) {
      void writeAssetToDisk(path, result.body);
    } else {
      result = await readAssetFromDisk(path);
    }
    if (!result) {
      res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    if (assetCache.size > ASSET_CACHE_LIMIT) {
      const oldest = [...assetCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) assetCache.delete(oldest[0]);
    }
    assetCache.set(path, { at: Date.now(), result });
    sendAsset(res, result);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  // 误输入 /index、/public/index.html 之类的页面路径时，直接回到面板
  if (method === 'GET' && (!extname(url.pathname) || url.pathname.endsWith('.html'))) {
    await serveStatic('/index.html', res);
    return;
  }

  res
    .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    .end(`Not Found\n\n面板地址：http://127.0.0.1:${req.socket.localPort ?? ''}/\n`);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendAsset(res: ServerResponse, asset: { body: Buffer; contentType: string }): void {
  res.writeHead(200, {
    'Content-Type': asset.contentType || 'image/png',
    'Content-Length': asset.body.byteLength,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(asset.body);
}

/* ----------------------------- 装备/资源落盘 ----------------------------- */

function contentTypeForAsset(assetPath: string): string {
  return CONTENT_TYPES[extname(assetPath).toLowerCase()] ?? 'image/png';
}

/** 资源路径 -> 以 SHA1 命名的磁盘文件，避免路径里的斜杠和中文 */
function assetDiskPath(assetPath: string): string {
  const hash = createHash('sha1').update(assetPath).digest('hex');
  return join(ASSET_DIR, `${hash}${extname(assetPath) || '.bin'}`);
}

async function readAssetFromDisk(
  assetPath: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    const body = await readFile(assetDiskPath(assetPath));
    return { body, contentType: contentTypeForAsset(assetPath) };
  } catch {
    return null;
  }
}

async function writeAssetToDisk(assetPath: string, body: Buffer): Promise<void> {
  try {
    await mkdir(ASSET_DIR, { recursive: true });
    await writeFile(assetDiskPath(assetPath), body);
  } catch {
    /* 磁盘不可写时只保留内存缓存 */
  }
}

function parseItemTable(body: Buffer): ItemTable {
  const list = JSON.parse(body.toString('utf8')) as Array<{
    id?: number;
    name?: string;
    iconPath?: string;
    price?: number;
    priceTotal?: number;
  }>;
  const items: ItemTable = {};
  for (const item of list) {
    if (typeof item?.id === 'number' && item.iconPath) {
      items[String(item.id)] = {
        icon: item.iconPath,
        name: item.name ?? '',
        price: Number(item.priceTotal ?? item.price ?? 0) || 0,
      };
    }
  }
  return items;
}

async function persistItems(body: Buffer): Promise<void> {
  try {
    await mkdir(ASSET_DIR, { recursive: true });
    await writeFile(ITEMS_DISK_PATH, body);
  } catch {
    /* 忽略磁盘写入失败 */
  }
}

/** 优先读客户端 items.json；读不到时用上次落盘的副本 */
async function loadItemTable(source: DataSource): Promise<ItemTable | null> {
  const now = Date.now();
  if (itemsCache && now - itemsCache.at < ASSET_TTL) return itemsCache.items;

  const asset = await source.getAsset(ITEMS_ASSET_PATH).catch(() => null);
  if (asset) {
    try {
      const items = parseItemTable(asset.body);
      if (Object.keys(items).length) {
        itemsCache = { at: now, items };
        void persistItems(asset.body);
        setTimeout(() => void prefetchItemIcons(source, items), 5_000).unref?.();
        return items;
      }
    } catch {
      /* 解析失败时尝试磁盘副本 */
    }
  }

  try {
    const items = parseItemTable(await readFile(ITEMS_DISK_PATH));
    if (Object.keys(items).length) {
      // 磁盘数据先顶着用，1 分钟后再试一次客户端
      itemsCache = { at: now - ASSET_TTL + 60_000, items };
      setTimeout(() => void prefetchItemIcons(source, items), 5_000).unref?.();
      return items;
    }
  } catch {
    /* 没有磁盘副本 */
  }
  return null;
}

/** 后台把所有装备图标预存到磁盘，之后即使客户端没开也能显示 */
async function prefetchItemIcons(source: DataSource, items: ItemTable): Promise<void> {
  if (itemPrefetch) return itemPrefetch;
  itemPrefetch = (async () => {
    const paths = [...new Set(Object.values(items).map((item) => item.icon).filter(Boolean))];
    if (!paths.length) return;
    paths.sort();
    const fingerprint = createHash('sha1').update(paths.join('\n')).digest('hex');

    try {
      const marker = JSON.parse(await readFile(ITEMS_PREFETCH_MARKER, 'utf8')) as {
        fingerprint?: string;
      };
      if (marker.fingerprint === fingerprint) return;
    } catch {
      /* 还没有预缓存记录 */
    }

    let saved = 0;
    await mapLimit(paths, 3, async (assetPath) => {
      if (existsSync(assetDiskPath(assetPath))) {
        saved += 1;
        return;
      }
      const asset = await source.getAsset(assetPath).catch(() => null);
      if (!asset) return;
      await writeAssetToDisk(assetPath, asset.body);
      saved += 1;
    });

    if (saved === paths.length) {
      try {
        await mkdir(ASSET_DIR, { recursive: true });
        await writeFile(ITEMS_PREFETCH_MARKER, JSON.stringify({ fingerprint, at: Date.now() }));
        logTag('asset', `装备图标已预缓存（${paths.length} 个）`);
      } catch {
        /* 忽略磁盘写入失败 */
      }
    }
  })().finally(() => {
    itemPrefetch = undefined;
  });
  return itemPrefetch;
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const cached = fileCache.get(pathname);
  if (cached) {
    res.writeHead(200, {
      'Content-Type': cached.type,
      'Content-Length': cached.body.byteLength,
      'Cache-Control': 'no-cache',
    });
    res.end(cached.body);
    return;
  }

  const filePath = join(PUBLIC_DIR, pathname.replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    fileCache.set(pathname, { body, type });
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

async function listenFixed(server: Server, port: number, host: string): Promise<number> {
  try {
    await listenOnce(server, port, host);
    return port;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;

    const health = await probePanelHealth(port);
    // 新版面板的 health 里带 PID，直接用它，省掉 PowerShell 查询
    const owner =
      health.ok && health.pid ? null : await findPortOwner(port);
    const panelPid = health.pid ?? owner?.pid;
    const ours = Boolean(
      panelPid &&
        (health.ok || isOwnPanelProcess(owner?.commandLine ?? '')),
    );

    if (!ours) {
      // 端口可能刚被释放但内核还没回收，短暂等待后再试
      if (!panelPid) {
        const releaseDeadline = Date.now() + 3_000;
        while (Date.now() < releaseDeadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 300));
          try {
            await listenOnce(server, port, host);
            return port;
          } catch (retryError) {
            if ((retryError as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
              throw retryError;
            }
          }
        }
      }
      const detail = owner
        ? `PID ${owner.pid}（${owner.commandLine || '无法读取命令行'}）`
        : health.pid
          ? `PID ${health.pid}（面板健康检查失败）`
          : '未知进程';
      throw new Error(
        `端口 ${port} 已被 ${detail} 占用。请先关闭该进程，或用 --port 指定其它端口。`,
      );
    }

    if (!panelPid) {
      throw new Error(`端口 ${port} 已被占用，但无法确定占用进程。`);
    }

    logTag('web', `端口 ${port} 被旧面板进程 PID ${panelPid} 占用，正在结束它…`);
    // 旧面板没有需要保存的状态，直接强制结束，避免优雅退出拖慢启动
    try {
      process.kill(panelPid, 'SIGKILL');
    } catch {
      /* 进程可能已经退出 */
    }
    if (!(await waitForExit(panelPid, 3_000))) {
      throw new Error(`端口 ${port} 的旧面板进程 PID ${panelPid} 未能退出，请手动结束。`);
    }

    // 进程退出后端口可能还会短暂占用，重试几次
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await listenOnce(server, port, host);
        return port;
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw retryError;
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
    }
    throw new Error(`端口 ${port} 在结束旧进程后仍被占用，请手动检查。`);
  }
}

function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  return false;
}

async function findPortOwner(
  port: number,
): Promise<{ pid: number; commandLine: string } | null> {
  const pid = (await pidFromNetstat(port)) ?? (await pidFromPowerShell(port));
  if (!pid) return null;
  if (process.platform !== 'win32') return { pid, commandLine: '' };

  try {
    const result = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
      ],
      { timeout: 8_000, windowsHide: true },
    ).catch(() => ({ stdout: '' }));
    return { pid, commandLine: result.stdout.trim() };
  } catch {
    return { pid, commandLine: '' };
  }
}

async function pidFromPowerShell(port: number): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`,
      ],
      { timeout: 8_000, windowsHide: true },
    );
    const pid = Number(stdout.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** PowerShell 的 CIM 查询偶尔失败，用 netstat 兜底 */
async function pidFromNetstat(port: number): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano'], {
      timeout: 8_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] ?? '';
      if (!local.endsWith(`:${port}`)) continue;
      const pid = Number(parts[4]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

function isOwnPanelProcess(commandLine: string): boolean {
  return /lol-mate-stats|dist[\\/]index\.js|src[\\/]index\.ts/i.test(commandLine);
}

/** 端口占用时先确认是不是本项目的面板，避免误杀其它程序 */
function probePanelHealth(port: number): Promise<{ ok: boolean; pid?: number }> {
  return new Promise((resolveProbe) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/health',
        method: 'GET',
        timeout: 1_200,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const data = JSON.parse(body) as { ok?: boolean; mode?: string; pid?: number };
            const ok = Boolean(data?.ok && (data.mode === 'live' || data.mode === 'demo'));
            resolveProbe({ ok, pid: typeof data?.pid === 'number' ? data.pid : undefined });
          } catch {
            resolveProbe({ ok: false });
          }
        });
      },
    );
    req.on('error', () => resolveProbe({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolveProbe({ ok: false });
    });
    req.end();
  });
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => undefined);
    } else if (process.platform === 'darwin') {
      execFile('open', [url], () => undefined);
    } else {
      execFile('xdg-open', [url], () => undefined);
    }
  } catch {
    /* 打开浏览器失败不影响面板使用 */
  }
}
