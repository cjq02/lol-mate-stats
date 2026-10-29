import { execFile } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { LcuConnection } from '../types.js';

const execFileAsync = promisify(execFile);

export class ClientNotFoundError extends Error {
  constructor(message = '未检测到正在运行的英雄联盟客户端') {
    super(message);
    this.name = 'ClientNotFoundError';
  }
}

interface DiscoverOptions {
  port?: number;
  password?: string;
  installDir?: string;
  silent?: boolean;
}

/**
 * 依次尝试：
 *  1. 命令行参数 / 环境变量 LCU_PORT + LCU_PASSWORD
 *  2. 从 LeagueClientUx.exe 的启动参数读取端口与 token（最可靠）
 *  3. 从 lockfile 读取
 *  4. 从客户端日志（LeagueClientUx.log）里的启动参数读取
 *
 * 国服 / WeGame 环境下 lockfile 可能为空、进程命令行又受权限限制，
 * 此时日志里的 `Command line arguments:` 是唯一可读的连接信息来源。
 */
export async function discoverConnection(options: DiscoverOptions = {}): Promise<LcuConnection> {
  const envPort = Number(process.env.LCU_PORT ?? '');
  const envPassword = process.env.LCU_PASSWORD;
  const port = options.port ?? (Number.isFinite(envPort) ? envPort : undefined);
  const password = options.password ?? envPassword;
  if (port && password) {
    return { host: '127.0.0.1', port, password, protocol: 'https', source: 'env' };
  }

  const fromProcess = await fromProcessCommandLine();
  if (fromProcess) return fromProcess;

  const lockfilePaths = candidateLockfiles(options.installDir);
  for (const path of lockfilePaths) {
    const conn = await readLockfile(path);
    if (conn && (await probeConnection(conn))) return conn;
  }

  // 国服 / WeGame：lockfile 可能是 0 字节，只能从客户端日志里找启动参数
  const logDirs = await candidateLogDirs(options.installDir);
  for (const dir of logDirs) {
    const conn = await fromClientLog(dir);
    if (conn) return conn;
  }

  throw new ClientNotFoundError(
    '未检测到正在运行的英雄联盟客户端。请先启动游戏客户端（登录后即可），' +
      '或通过 --port/--token 或环境变量 LCU_PORT/LCU_PASSWORD 手动指定 LCU 连接信息。',
  );
}

const COMMON_INSTALL_DIRS = [
  'C:/Riot Games/League of Legends',
  'D:/Riot Games/League of Legends',
  'C:/WeGameApps/英雄联盟',
  'D:/WeGameApps/英雄联盟',
  'C:/Program Files/WeGameApps/英雄联盟',
  'D:/Program Files/WeGameApps/英雄联盟',
  'C:/Program Files (x86)/WeGameApps/英雄联盟',
  'D:/英雄联盟',
  'E:/英雄联盟',
];

export function candidateLockfiles(installDir?: string): string[] {
  const paths = new Set<string>();

  const explicit = process.env.LOL_LOCKFILE;
  if (explicit) paths.add(resolve(explicit));

  const envDir = installDir ?? process.env.LOL_INSTALL_DIR;
  if (envDir) {
    paths.add(join(envDir, 'lockfile'));
    paths.add(join(envDir, 'LeagueClient', 'lockfile'));
  }

  for (const dir of COMMON_INSTALL_DIRS) {
    paths.add(join(dir, 'lockfile'));
    paths.add(join(dir, 'LeagueClient', 'lockfile'));
  }

  return [...paths];
}

export async function readLockfile(path: string): Promise<LcuConnection | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    // 格式：LeagueClient:12345:52111:password:https
    const parts = raw.split(':');
    if (parts.length < 5) return null;
    const pid = Number(parts[1]);
    const port = Number(parts[2]);
    const password = parts.slice(3, parts.length - 1).join(':');
    const protocol = parts[parts.length - 1];
    if (!Number.isFinite(port) || port <= 0 || !password) return null;
    return {
      host: '127.0.0.1',
      port,
      password,
      protocol: protocol === 'http' ? 'https' : 'https',
      pid: Number.isFinite(pid) ? pid : undefined,
      source: path,
    };
  } catch {
    return null;
  }
}

/** 可能存放 LeagueClientUx 日志的目录 */
export async function candidateLogDirs(installDir?: string): Promise<string[]> {
  const dirs = new Set<string>();

  const envDir = installDir ?? process.env.LOL_INSTALL_DIR;
  if (envDir) {
    dirs.add(resolve(envDir));
    dirs.add(join(envDir, 'LeagueClient'));
  }

  for (const dir of COMMON_INSTALL_DIRS) {
    dirs.add(dir);
    dirs.add(join(dir, 'LeagueClient'));
  }

  for (const dir of await riotClientInstallDirs()) {
    dirs.add(dir);
  }

  // 按最新日志时间排序：当前真正在运行的那份客户端排在最前
  const existing = [...dirs].filter((dir) => existsSync(dir));
  const ranked = await Promise.all(
    existing.map(async (dir) => ({ dir, time: await newestLogTime(dir) })),
  );
  return ranked
    .filter((item) => item.time > 0)
    .sort((a, b) => b.time - a.time)
    .map((item) => item.dir);
}

async function newestLogTime(dir: string): Promise<number> {
  let newest = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/LeagueClientUx\.log$/i.test(entry.name)) continue;
      try {
        const info = await stat(join(dir, entry.name));
        if (info.mtimeMs > newest) newest = info.mtimeMs;
      } catch {
        /* 单个文件读取失败不影响其它日志 */
      }
    }
  } catch {
    return 0;
  }
  return newest;
}

/**
 * 从 RiotClientInstalls.json 读取客户端实际安装位置。
 * 国服由 WeGame / Riot Client 启动时，安装目录常常不在常见路径里。
 */
async function riotClientInstallDirs(): Promise<string[]> {
  const programData = process.env.ProgramData ?? 'C:\\ProgramData';
  const localAppData = process.env.LOCALAPPDATA;
  const manifests = [
    join(programData, 'Riot Games', 'RiotClientInstalls.json'),
    localAppData ? join(localAppData, 'Riot Games', 'RiotClientInstalls.json') : '',
  ].filter(Boolean);
  const dirs = new Set<string>();

  for (const manifest of manifests) {
    if (!existsSync(manifest)) continue;
    try {
      const raw = await readFile(manifest, 'utf8');
      const data = JSON.parse(raw) as {
        associated_client?: Record<string, string>;
        rc_default?: string;
      };
      for (const key of Object.keys(data.associated_client ?? {})) {
        // 形如 "e:/.../riot client/../LeagueClient/"
        dirs.add(resolve(key));
      }
      if (typeof data.rc_default === 'string') {
        // rc_default 指向 riotclientservices.exe，LeagueClient 与 Riot Client 同级
        dirs.add(resolve(dirname(resolve(data.rc_default)), '..', 'LeagueClient'));
      }
    } catch {
      /* 配置损坏时忽略 */
    }
  }

  return [...dirs];
}

/**
 * 客户端启动时会把完整命令行写进 LeagueClientUx.log，其中包含
 * `--app-port=xxx` 和 `--remoting-auth-token=xxx`。
 * 只读最新的几个日志，避免遍历整个目录。
 */
async function fromClientLog(dir: string): Promise<LcuConnection | null> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && /LeagueClientUx\.log$/i.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  if (!names.length) return null;

  // 文件名以 ISO 时间开头，倒序即为最新
  names.sort((a, b) => b.localeCompare(a));

  for (const name of names.slice(0, 3)) {
    const file = join(dir, name);
    const head = await readHead(file);
    if (!head) continue;
    const port = /--app-port=(\d+)/.exec(head)?.[1];
    const password = /--remoting-auth-token=([\w-]+)/.exec(head)?.[1];
    if (!port || !password) continue;
    const conn: LcuConnection = {
      host: '127.0.0.1',
      port: Number(port),
      password,
      protocol: 'https',
      source: `log (${file})`,
    };
    // 旧日志里的端口可能已经失效，探测通过才返回
    if (await probeConnection(conn)) return conn;
  }

  return null;
}

function probeConnection(conn: LcuConnection, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const auth = `Basic ${Buffer.from(`riot:${conn.password}`).toString('base64')}`;
    const req = httpsRequest(
      {
        host: conn.host,
        port: conn.port,
        path: '/lol-gameflow/v1/gameflow-phase',
        method: 'GET',
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: { Authorization: auth },
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function readHead(file: string, size = 64 * 1024): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) return null;
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(Math.min(size, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function fromProcessCommandLine(): Promise<LcuConnection | null> {
  if (process.platform !== 'win32') return null;

  const commands = [
    "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine",
    // 部分系统上 CIM 不可用，退回 WMIC
    "wmic process where \"name='LeagueClientUx.exe'\" get CommandLine /format:list",
  ];

  for (const command of commands) {
    let stdout = '';
    try {
      const result = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch {
      continue;
    }
    if (!stdout.trim()) continue;

    const port = /--app-port=(\d+)/.exec(stdout)?.[1];
    const password = /--remoting-auth-token=([\w-]+)/.exec(stdout)?.[1];
    if (!port || !password) continue;

    const exePath =
      /"([^"]*LeagueClientUx\.exe)"/i.exec(stdout)?.[1] ??
      /([A-Za-z]:\\[^\r\n"]*?LeagueClientUx\.exe)/i.exec(stdout)?.[1];

    return {
      host: '127.0.0.1',
      port: Number(port),
      password,
      protocol: 'https',
      source: exePath ? `process (${exePath})` : 'process',
    };
  }

  // 从进程路径推导 lockfile（启动参数偶尔拿不到）
  const installDir = await processInstallDir();
  if (installDir) {
    const conn = await readLockfile(join(installDir, 'lockfile'));
    if (conn) return { ...conn, source: `lockfile (${join(installDir, 'lockfile')})` };
  }

  return null;
}

async function processInstallDir(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "(Get-Process LeagueClientUx -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)",
      ],
      { timeout: 15_000, windowsHide: true },
    );
    const exePath = stdout.trim();
    if (!exePath) return null;
    return dirname(exePath);
  } catch {
    return null;
  }
}
