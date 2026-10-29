import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DataSource } from './source.js';
import { logTag } from './util.js';

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
  '.ico': 'image/x-icon',
};

const STATIC_FILES = new Set(['/', '/index.html', '/app.js', '/style.css']);
const fileCache = new Map<string, { body: Buffer; type: string }>();
const assetCache = new Map<string, { at: number; result: { body: Buffer; contentType: string } }>();
const ASSET_TTL = 60 * 60_000;
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
      mode: snapshot.mode,
      phase: snapshot.phase,
      inChampSelect: snapshot.inChampSelect,
      updatedAt: snapshot.updatedAt,
    });
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
    const result = await source.getAsset(path);
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

    const owner = await findPortOwner(port);
    const ours = owner && (isOwnPanelProcess(owner.commandLine) || (await probePanelHealth(port)));
    if (!owner || !ours) {
      const detail = owner
        ? `PID ${owner.pid}（${owner.commandLine || '无法读取命令行'}）`
        : '未知进程';
      throw new Error(
        `端口 ${port} 已被 ${detail} 占用。请先关闭该进程，或用 --port 指定其它端口。`,
      );
    }

    logTag('web', `端口 ${port} 被旧面板进程 PID ${owner.pid} 占用，正在结束它…`);
    try {
      process.kill(owner.pid, 'SIGTERM');
    } catch {
      /* 进程可能已经退出 */
    }

    if (!(await waitForExit(owner.pid, 5_000))) {
      throw new Error(`端口 ${port} 的旧面板进程 PID ${owner.pid} 未能退出，请手动结束。`);
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
    if (!Number.isInteger(pid) || pid <= 0) return null;

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
    return null;
  }
}

function isOwnPanelProcess(commandLine: string): boolean {
  return /lol-mate-stats|dist[\\/]index\.js|src[\\/]index\.ts/i.test(commandLine);
}

/** 端口占用时先确认是不是本项目的面板，避免误杀其它程序 */
function probePanelHealth(port: number): Promise<boolean> {
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
            const data = JSON.parse(body) as { ok?: boolean; mode?: string };
            resolveProbe(Boolean(data?.ok && (data.mode === 'live' || data.mode === 'demo')));
          } catch {
            resolveProbe(false);
          }
        });
      },
    );
    req.on('error', () => resolveProbe(false));
    req.on('timeout', () => {
      req.destroy();
      resolveProbe(false);
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
