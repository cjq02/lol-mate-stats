import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读取项目根目录的 .env。
 * 已经存在的真实环境变量优先，不会被 .env 覆盖。
 */
function parseEnv(text: string): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1] as string;
    if (process.env[key] !== undefined) continue;

    let value = (match[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    process.env[key] = value;
  }
}

function loadEnv(): void {
  // dist/env.js -> 项目根目录；src/env.ts（tsx）-> 项目根目录
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const candidates = [join(root, '.env'), join(process.cwd(), '.env')];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      parseEnv(readFileSync(file, 'utf8'));
      return;
    } catch {
      /* .env 读取失败时继续使用现有环境变量 */
    }
  }
}

loadEnv();
