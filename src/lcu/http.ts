import https from 'node:https';
import { Buffer } from 'node:buffer';
import type { IncomingHttpHeaders } from 'node:http';
import type { LcuConnection } from '../types.js';

export class LcuError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`LCU ${method} ${path} -> HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'LcuError';
  }
}

export interface LcuRawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** 极简 LCU HTTP 客户端：本地自签名证书 + Basic Auth(riot:token) */
export class LcuHttp {
  private readonly agent: https.Agent;
  private readonly auth: string;
  /** 全局并发/频率限制：国服战绩服务对突发请求很敏感 */
  private readonly maxConcurrent = 4;
  private readonly minGapMs = 60;
  private running = 0;
  private lastStart = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly conn: LcuConnection) {
    this.agent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      maxSockets: 4,
    });
    this.auth = `Basic ${Buffer.from(`riot:${conn.password}`).toString('base64')}`;
  }

  get port(): number {
    return this.conn.port;
  }

  async get<T = unknown>(path: string, timeoutMs = 15_000): Promise<T> {
    return this.request<T>('GET', path, undefined, timeoutMs);
  }

  async post<T = unknown>(path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    return this.request<T>('POST', path, body, timeoutMs);
  }

  async delete<T = unknown>(path: string, timeoutMs = 15_000): Promise<T> {
    return this.request<T>('DELETE', path, undefined, timeoutMs);
  }

  async getOrNull<T = unknown>(path: string, timeoutMs = 15_000): Promise<T | null> {
    try {
      return await this.get<T>(path, timeoutMs);
    } catch (error) {
      if (error instanceof LcuError && error.status === 404) return null;
      throw error;
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<T> {
    // 国服战绩服务偶发 500/503，重试一次，避免整张卡片直接报错
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.raw(method, path, body, timeoutMs);
        const text = response.body.toString('utf8');
        if (!text) return undefined as T;
        const contentType = String(response.headers['content-type'] ?? '');
        if (contentType.includes('json') || /^[\[{]/.test(text.trim())) {
          try {
            return JSON.parse(text) as T;
          } catch {
            /* 非 JSON 响应，原样返回 */
          }
        }
        return text as unknown as T;
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof LcuError &&
          (error.status === 429 ||
            error.status === 500 ||
            error.status === 502 ||
            error.status === 503 ||
            error.status === 504);
        if (!retryable || attempt >= 1) throw error;
        await new Promise((resolveSleep) =>
          setTimeout(resolveSleep, 800 + Math.floor(Math.random() * 400)),
        );
      }
    }
    throw lastError;
  }

  async raw(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<LcuRawResponse> {
    await this.acquire();
    try {
      return await this.rawInner(method, path, body, timeoutMs);
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolveWaiter) => this.waiters.push(resolveWaiter));
    } else {
      this.running += 1;
    }

    const wait = this.lastStart + this.minGapMs - Date.now();
    if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
    this.lastStart = Date.now();
  }

  private release(): void {
    this.running -= 1;
    const next = this.waiters.shift();
    if (next) {
      this.running += 1;
      next();
    }
  }

  private async rawInner(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<LcuRawResponse> {
    const url = `https://127.0.0.1:${this.conn.port}${path}`;
    return new Promise<LcuRawResponse>((resolve, reject) => {
      const payload =
        body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));

      const request = https.request(
        url,
        {
          method,
          agent: this.agent,
          timeout: timeoutMs,
          headers: {
            Authorization: this.auth,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const result: LcuRawResponse = {
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            };
            if (result.status >= 200 && result.status < 300) {
              resolve(result);
            } else {
              reject(
                new LcuError(result.status, method, path, result.body.toString('utf8').slice(0, 300)),
              );
            }
          });
        },
      );

      request.on('timeout', () => {
        request.destroy(new Error(`LCU 请求超时: ${method} ${path}`));
      });
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  destroy(): void {
    this.agent.destroy();
  }
}
