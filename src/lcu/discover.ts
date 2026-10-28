import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
    if (conn) return conn;
  }

  throw new ClientNotFoundError(
    '未检测到正在运行的英雄联盟客户端。请先启动游戏客户端（登录后即可），' +
      '或通过 --port/--token 或环境变量 LCU_PORT/LCU_PASSWORD 手动指定 LCU 连接信息。',
  );
}

export function candidateLockfiles(installDir?: string): string[] {
  const paths = new Set<string>();

  const explicit = process.env.LOL_LOCKFILE;
  if (explicit) paths.add(resolve(explicit));

  const envDir = installDir ?? process.env.LOL_INSTALL_DIR;
  if (envDir) {
    paths.add(join(envDir, 'lockfile'));
    paths.add(join(envDir, 'LeagueClient', 'lockfile'));
  }

  const commonDirs = [
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
  for (const dir of commonDirs) {
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
