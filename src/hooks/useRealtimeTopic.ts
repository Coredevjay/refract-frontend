"use client";

import { useEffect, useState } from "react";

import { useFeatureFlag } from "@/lib/flags/useFeatureFlag";
import { fidelityController, realtimeBus, realtimeClient } from "@/lib/realtime";
import type { ConnectionState } from "@/lib/realtime/client";
import type { RealtimeTopic, RealtimeTopics, RealtimeViewStatus } from "@/lib/realtime";

/** Maps data presence and transport state to the shared view-status enum. */
export function deriveViewStatus(
  hasData: boolean,
  enabled: boolean,
  conn: ConnectionState
): RealtimeViewStatus {
  if (!hasData) return "empty";
  if (!enabled) return "polling";
  if (conn === "connected") return "live";
  if (conn === "reconnecting") return "reconnecting";
  return "disconnected";
}

interface Options<T extends RealtimeTopic> {
  /** REST snapshot used for first paint and as the fallback when realtime is off. */
  initial?: RealtimeTopics[T];
  /** Keep this topic subscribed even when the fidelity tier would drop it (e.g. claim settlement). */
  critical?: boolean;
}

/**
 * Subscribes to a topic through the event bus (never the socket directly).
 * Late mounts read the bus snapshot; `status` is the single enum views map to
 * presentation, so components never inspect transport internals.
 */
export function useRealtimeTopic<T extends RealtimeTopic>(topic: T, options: Options<T> = {}) {
  const enabled = useFeatureFlag("realtime-oracle");
  const [data, setData] = useState<RealtimeTopics[T] | undefined>(options.initial);
  const [conn, setConn] = useState<ConnectionState>("idle");

  useEffect(() => {
    if (!enabled) return;
    const snap = realtimeBus.getSnapshot(topic);
    if (snap !== undefined) setData(snap);
    const offBus = realtimeBus.subscribe(topic, setData);
    setConn(realtimeClient.getConnectionState());
    const offConn = realtimeClient.onConnectionChange(setConn);
    const release = options.critical ? fidelityController.requireTopic(topic) : () => {};
    realtimeClient.connect();
    return () => {
      offBus();
      offConn();
      release();
    };
  }, [enabled, topic, options.critical]);

  return { data, status: deriveViewStatus(data !== undefined, enabled, conn), enabled };
}
