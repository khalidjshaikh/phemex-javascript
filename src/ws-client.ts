// SPDX-License-Identifier: MIT
/**
 * ws-client.ts — Reconnecting WebSocket with heartbeat for Phemex.
 *
 * Provides:
 *   ReconnectingWs — Class that manages the WebSocket lifecycle:
 *     - Auto-connect with exponential backoff (1s → 30s max)
 *     - Heartbeat (server.ping) at configurable interval
 *     - Clean SIGINT shutdown
 *     - Custom onOpen, onMessage, onReconnect callbacks
 *
 * Usage:
 *   const ws = new ReconnectingWs("wss://ws.phemex.com", {
 *     onOpen: () => { ws.send(JSON.stringify({ method: "market24h.subscribe", params: [], id: 1 })); },
 *     onMessage: (msg) => { console.log(msg); },
 *   });
 *   ws.connect();
 */

const DEFAULT_HEARTBEAT_INTERVAL = 20_000; // 20s
const MAX_RECONNECT_DELAY = 30_000;

export interface ReconnectingWsOptions {
  /** Called when the WebSocket opens. Use this to send subscriptions. */
  onOpen?: () => void;
  /** Called with the parsed JSON message object on each message. */
  onMessage?: (msg: Record<string, unknown>) => void;
  /** Called just before a reconnect attempt (after a close). */
  onReconnect?: (delayMs: number) => void;
  /** Heartbeat interval in ms (default: 20000). Set to 0 to disable. */
  heartbeatInterval?: number;
  /** Whether to auto-handle pong (msg.result === "pong") and subscription acks (msg.result?.status === "success"). Default: true */
  autoHandleControl?: boolean;
  /** Whether to ignore subscription-error messages. Default: true */
  ignoreSubscriptionErrors?: boolean;
  /** Whether to register a SIGINT handler for graceful shutdown. Default: true */
  registerSigint?: boolean;
}

export class ReconnectingWs {
  private ws: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectDelay = 1_000;
  private readonly url: string;
  private readonly options: Required<ReconnectingWsOptions>;
  private readonly sigintHandler: (() => void) | undefined;

  constructor(url: string, options?: ReconnectingWsOptions) {
    this.url = url;
    this.options = {
      onOpen: options?.onOpen ?? (() => {}),
      onMessage: options?.onMessage ?? (() => {}),
      onReconnect: options?.onReconnect ?? (() => {}),
      heartbeatInterval: options?.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
      autoHandleControl: options?.autoHandleControl ?? true,
      ignoreSubscriptionErrors: options?.ignoreSubscriptionErrors ?? true,
      registerSigint: options?.registerSigint ?? true,
    };

    if (this.options.registerSigint) {
      this.sigintHandler = () => {
        this.shutdown();
        process.exit(0);
      };
      process.on("SIGINT", this.sigintHandler);
    }
  }

  /** Start (or restart) the connection. */
  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener("open", () => {
      this.reconnectDelay = 1_000; // reset backoff on successful connection
      this.startHeartbeat();
      this.options.onOpen();
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;

      if (this.options.autoHandleControl) {
        // Pong — heartbeat response
        if (msg.result === "pong") return;
        // Ignore subscription ack
        if ((msg.result as Record<string, unknown> | undefined)?.status === "success") return;
      }

      if (this.options.ignoreSubscriptionErrors && msg.error != null) return;

      this.options.onMessage(msg);
    });

    this.ws.addEventListener("close", () => {
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      /* error event is always followed by close, so reconnect handles it */
    });
  }

  /** Send a JSON-stringified message. */
  send(data: object | string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
    }
  }

  /** Close the connection and clean up timers. */
  close(): void {
    this.ws?.close();
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /** Full shutdown: close + deregister SIGINT. */
  shutdown(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.close();
    if (this.sigintHandler) {
      process.removeListener("SIGINT", this.sigintHandler);
    }
  }

  /** Whether the underlying socket is in the OPEN state. */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /* ------------------------------------------------------------------ */
  /*  Private                                                            */
  /* ------------------------------------------------------------------ */

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.options.heartbeatInterval <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      this.send({ method: "server.ping", params: [], id: Date.now() });
    }, this.options.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return; // already scheduled
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.options.onReconnect(this.reconnectDelay);
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
}