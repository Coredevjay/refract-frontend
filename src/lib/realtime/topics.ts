/** Status of the protocol as announced by the backend (REST snapshot or realtime push). */
export type ProtocolStatusLevel = "healthy" | "degraded" | "maintenance" | "unknown";

export interface MaintenanceWindow {
  startsAt: string;
  endsAt: string;
  message?: string;
}

export interface ProtocolStatus {
  level: ProtocolStatusLevel;
  updatedAt: string;
  network?: string;
  maintenance?: MaintenanceWindow | null;
  incidents?: { id: string; title: string; at: string; resolved: boolean }[];
}

/** Topic identifiers and payload shapes of the realtime contract. */
export interface RealtimeTopics {
  oracle_update: { price: number; updatedAt: string };
  protocol_status: ProtocolStatus;
  network_health: { level: ProtocolStatusLevel; updatedAt: string };
}

export type RealtimeTopic = keyof RealtimeTopics;

/** Topics that carry the current state and are replayed to late subscribers. */
export const SNAPSHOT_TOPICS: ReadonlySet<RealtimeTopic> = new Set<RealtimeTopic>([
  "oracle_update",
  "protocol_status",
  "network_health",
]);

/** Single status enum shared by realtime-backed views. */
export type RealtimeViewStatus = "empty" | "live" | "disconnected" | "reconnecting" | "polling";
