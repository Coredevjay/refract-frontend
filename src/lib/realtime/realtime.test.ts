import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RealtimeBus } from "./bus";
import { FidelityController, selectTier, DOWNGRADE_HOLD_MS, UPGRADE_HOLD_MS } from "./fidelity";
import { realtimeClient } from "./client";

describe("RealtimeBus", () => {
  it("fans out in order, isolates throwing handlers, replays snapshots and tears down", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new RealtimeBus();
    const seen: number[] = [];
    bus.subscribe("oracle_update", () => {
      throw new Error("boom");
    });
    const off = bus.subscribe("oracle_update", (p) => seen.push(p.price));
    bus.publish("oracle_update", { price: 1, updatedAt: "" });
    bus.publish("oracle_update", { price: 2, updatedAt: "" });
    expect(seen).toEqual([1, 2]);
    expect(bus.getSnapshot("oracle_update")?.price).toBe(2);
    off();
    expect(bus.handlerCount("oracle_update")).toBe(1);
  });

  it("delivers re-entrant publishes after the current event", () => {
    const bus = new RealtimeBus();
    const order: number[] = [];
    bus.subscribe("oracle_update", (p) => {
      order.push(p.price);
      if (p.price === 1) bus.publish("oracle_update", { price: 2, updatedAt: "" });
      order.push(p.price * 10);
    });
    bus.publish("oracle_update", { price: 1, updatedAt: "" });
    expect(order).toEqual([1, 10, 2, 20]);
  });
});

describe("fidelity", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("selects tiers and tolerates missing signals", () => {
    expect(selectTier({})).toBe("full");
    expect(selectTier({ saveData: true })).toBe("minimal");
    expect(selectTier({ effectiveType: "3g" })).toBe("lite");
    expect(selectTier({ batteryLevel: 0.1, charging: false })).toBe("minimal");
  });

  it("applies hysteresis and syncs topic diffs without leaking timers", () => {
    const sync = vi.spyOn(realtimeClient, "syncTopics").mockImplementation(() => {});
    const c = new FidelityController();
    c.evaluate({ effectiveType: "2g" });
    c.evaluate({}); // flap back before the hold elapses
    vi.advanceTimersByTime(DOWNGRADE_HOLD_MS);
    expect(c.getTier()).toBe("full");
    c.evaluate({ effectiveType: "2g" });
    vi.advanceTimersByTime(DOWNGRADE_HOLD_MS);
    expect(c.getTier()).toBe("minimal");
    expect([...sync.mock.lastCall![0]]).toEqual([]);
    const release = c.requireTopic("oracle_update");
    expect([...sync.mock.lastCall![0]]).toEqual(["oracle_update"]);
    release();
    c.evaluate({});
    vi.advanceTimersByTime(UPGRADE_HOLD_MS);
    expect(c.getTier()).toBe("full");
    expect(vi.getTimerCount()).toBe(0);
  });
});
