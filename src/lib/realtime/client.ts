import { API_BASE_URL } from "../api/client";
import { realtimeBus } from "./bus";
import type { RealtimeTopic, RealtimeTopics } from "./topics";

type Handler = (payload: unknown) => void;
type ConnectionListener = (state: ConnectionState) => void;

export type ConnectionState = "idle" | "connected" | "reconnecting";

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

/**
 * A small reconnecting WebSocket wrapper exposing a subscribe-by-topic API.
 * The backend contract this assumes (documented, not yet implemented
 * upstream): connect to `${wsUrl}`, receive JSON messages shaped
 * `{ topic: string, payload: unknown }`, one topic per push-based update
 * type (e.g. "oracle_update"). Callers must treat this connection as
 * best-effort — always keep an independent REST fetch as the source of
 * truth for initial state.
 */
class RealtimeClient {
  private socket: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private attempt = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wireTopics = new Set<string>();
  private listeners = new Set<ConnectionListener>();
  private state: ConnectionState = "idle";

  getConnectionState(): ConnectionState {
    return this.state;
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.listeners.forEach((l) => l(next));
  }

  /**
   * Applies the wire-level topic set as a diff (subscribe/unsubscribe deltas).
   * The full set is re-sent on every (re)connect so a tier change or a
   * reconnect never loses a topic.
   */
  syncTopics(topics: ReadonlySet<string>): void {
    const prev = this.wireTopics;
    this.wireTopics = new Set(topics);
    if (this.socket?.readyState !== 1) return;
    for (const t of topics) if (!prev.has(t)) this.send({ action: "subscribe", topic: t });
    for (const t of prev) if (!topics.has(t)) this.send({ action: "unsubscribe", topic: t });
  }

  private send(msg: unknown): void {
    try {
      this.socket?.send(JSON.stringify(msg));
    } catch {
      // Socket closing — the reconnect path re-sends the full topic set.
    }
  }

  connect(): void {
    if (typeof WebSocket === "undefined" || this.socket) return;
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    const wsUrl = API_BASE_URL.replace(/^http/, "ws").replace(/\/api\/v1$/, "/ws");
    try {
      this.socket = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.addEventListener("open", () => {
      this.attempt = 0;
      this.setState("connected");
      for (const t of this.wireTopics) this.send({ action: "subscribe", topic: t });
    });
    this.socket.addEventListener("message", (event) => {
      try {
        const { topic, payload } = JSON.parse(event.data as string) as {
          topic: string;
          payload: unknown;
        };
        this.handlers.get(topic)?.forEach((handler) => handler(payload));
        // Decoded events fan out through the bus so consumers never own a socket subscription.
        if (typeof topic === "string" && payload !== null && typeof payload === "object") {
          realtimeBus.publish(topic as RealtimeTopic, payload as RealtimeTopics[RealtimeTopic]);
        }
      } catch {
        // Malformed message — ignore, don't crash the connection.
      }
    });
    this.socket.addEventListener("close", () => {
      this.socket = null;
      if (!this.closedByUser) {
        this.setState("reconnecting");
        this.scheduleReconnect();
      } else {
        this.setState("idle");
      }
    });
    this.socket.addEventListener("error", () => {
      this.socket?.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.open();
    }, delay);
  }

  subscribe(topic: string, handler: Handler): () => void {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic)!.add(handler);
    this.connect();

    return () => {
      this.handlers.get(topic)?.delete(handler);
    };
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.setState("idle");
  }
}

export const realtimeClient = new RealtimeClient();
