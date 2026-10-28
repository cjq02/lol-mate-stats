import { Buffer } from 'node:buffer';
import WebSocket from 'ws';
import type { LcuConnection } from '../types.js';

export interface LcuEvent {
  uri: string;
  eventType: string;
  data: unknown;
}

export interface EventStreamHandlers {
  onEvent: (event: LcuEvent) => void;
  onOpen?: () => void;
  onClose?: (reason: string) => void;
  onError?: (error: Error) => void;
}

const SUBSCRIPTIONS = [
  'OnJsonApiEvent_lol-champ-select_v1_session',
  'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
];

/**
 * 订阅 LCU 事件（WAMP 风格）。连接失败不影响主流程，轮询可以兜底。
 * 返回取消订阅函数。
 */
export function openEventStream(
  conn: LcuConnection,
  handlers: EventStreamHandlers,
): { close: () => void } {
  const headers = {
    Authorization: `Basic ${Buffer.from(`riot:${conn.password}`).toString('base64')}`,
  };

  let socket: WebSocket | null = null;
  let closedByUser = false;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const connect = (): void => {
    if (closedByUser) return;
    socket = new WebSocket(`wss://127.0.0.1:${conn.port}/`, {
      headers,
      rejectUnauthorized: false,
      handshakeTimeout: 6_000,
    });

    socket.on('open', () => {
      attempt = 0;
      for (const topic of SUBSCRIPTIONS) {
        socket?.send(JSON.stringify([5, topic]));
      }
      handlers.onOpen?.();
    });

    socket.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      const [, topic, payload] = parsed as [number, string, unknown];
      if (typeof topic !== 'string' || !topic.startsWith('OnJsonApiEvent')) return;
      if (!payload || typeof payload !== 'object') return;
      const body = payload as { uri?: string; eventType?: string; data?: unknown };
      handlers.onEvent({
        uri: body.uri ?? '',
        eventType: body.eventType ?? '',
        data: body.data,
      });
    });

    socket.on('close', (code, reason) => {
      socket = null;
      if (closedByUser) return;
      handlers.onClose?.(`code=${code} ${reason.toString()}`.trim());
      const delay = Math.min(10_000, 1_000 * 2 ** Math.min(attempt++, 3));
      reconnectTimer = setTimeout(connect, delay);
    });

    socket.on('error', (error: Error) => {
      handlers.onError?.(error);
    });
  };

  connect();

  return {
    close: () => {
      closedByUser = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
    },
  };
}
