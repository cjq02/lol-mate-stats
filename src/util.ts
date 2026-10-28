import { Buffer } from 'node:buffer';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 简单的并发限制 map，保持结果顺序 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/* ------------------------------------------------------------------ */
/* 控制台输出辅助（中文字符按 2 列宽计算）                             */
/* ------------------------------------------------------------------ */

export function cjkWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function padCjk(text: string, width: number): string {
  const current = cjkWidth(text);
  return current >= width ? text : text + ' '.repeat(width - current);
}

export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) =>
    Math.max(cjkWidth(header), ...rows.map((row) => cjkWidth(row[column] ?? ''))),
  );
  const line = (row: string[]): string =>
    row.map((cell, index) => padCjk(cell, widths[index])).join('  ');

  const divider = widths.map((width) => '─'.repeat(width)).join('  ');
  console.log(line(headers));
  console.log(divider);
  for (const row of rows) console.log(line(row));
}

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
} as const;

export function colorize(
  text: string,
  color: keyof typeof ANSI,
  enabled = process.stdout.isTTY,
): string {
  if (!enabled) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

export function ok(text: string): string {
  return colorize(text, 'green');
}

export function warn(text: string): string {
  return colorize(text, 'yellow');
}

export function fail(text: string): string {
  return colorize(text, 'red');
}

export function dim(text: string): string {
  return colorize(text, 'dim');
}

export function header(text: string): string {
  return colorize(text, 'cyan', process.stdout.isTTY);
}

export function logTag(tag: string, message: string): void {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`${dim(`[${time}]`)} ${header(tag)} ${message}`);
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function byteLength(buffer: Buffer): string {
  return `${(buffer.byteLength / 1024).toFixed(1)} KB`;
}
