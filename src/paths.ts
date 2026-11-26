import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Windows 的“文档”目录（可能被重定向到 E 盘） */
function resolveDocumentsDir(): string {
  if (process.platform === 'win32') {
    try {
      const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
      const output = execFileSync(
        reg,
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
          '/v',
          'Personal',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      const line = output
        .split(/\r?\n/)
        .find((item) => /Personal\s+REG_(?:EXPAND_)?SZ/i.test(item));
      const match = line?.match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i);
      if (match?.[1]) {
        return match[1].replace(/%([^%]+)%/g, (_, key: string) => process.env[key] ?? '');
      }
    } catch {
      /* 读不到注册表时退回 ~/Documents */
    }
  }
  return join(homedir(), 'Documents');
}

/** 本地数据目录：装备图标、补丁公告缓存、导入用的旧 SQLite 等仍然放在本机 */
export const DATA_DIR =
  process.env.LOL_MATE_DATA_DIR?.trim() || join(resolveDocumentsDir(), 'lol-mate-stats');
