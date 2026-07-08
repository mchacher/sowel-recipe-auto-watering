import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRecipe } from "./index.js";

// ============================================================
// Mock RecipeContext harness
// ============================================================

interface OrderCall {
  vId: string;
  alias: string;
  value: unknown;
}

function makeCtx(opts: { rejectOnTime?: boolean } = {}) {
  const store = new Map<string, unknown>();
  const orders: OrderCall[] = [];

  const ctx = {
    eventBus: { onType: () => () => {} },
    equipmentManager: {
      getById: (id: string) => ({ id, name: `Vanne ${id}`, type: "water_valve" }),
      getByIdWithDetails: () => null,
      getAllWithDetails: () => [],
      executeOrder: async (vId: string, alias: string, value: unknown) => {
        orders.push({ vId, alias, value });
        // Simulate a Tuya valve that rejects a payload containing `on_time`.
        if (opts.rejectOnTime && value && typeof value === "object" && "on_time" in (value as object)) {
          throw new Error("No converter available for 'on_time'");
        }
        return { success: true };
      },
    },
    zoneManager: { getById: () => ({ id: "z", name: "Zone" }) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    state: {
      get: (k: string) => (store.has(k) ? store.get(k) : null),
      set: (k: string, v: unknown) => void store.set(k, v),
      delete: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    log: () => {},
    helpers: { parseDuration: (v: unknown) => Number(v) || 0 },
  };

  return {
    ctx: ctx as unknown as Parameters<ReturnType<typeof createRecipe>["createInstance"]>[1],
    orders,
    store,
    getState: (k: string) => (store.has(k) ? store.get(k) : null),
  };
}

const baseParams = {
  zone: "z",
  valves: ["v1"],
  slot1_time: "14:45",
  slot1_duration: "2", // minutes
  slot2_time: "",
  slot2_duration: "",
  slot3_time: "",
  slot3_duration: "",
  weatherStation: "",
  rainThreshold: "",
  forecastThreshold: "",
};

describe("auto-watering valve control", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 1 minute before the slot, in local time (msUntilTime uses local hours).
    vi.setSystemTime(new Date("2026-07-08T14:44:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("opens with plain ON first, then ON+on_time, and closes after the duration", async () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance({ ...baseParams }, h.ctx);

    // Fire the 14:45 slot.
    await vi.advanceTimersByTimeAsync(60_000);

    const opens = h.orders.filter((o) => o.value && (o.value as { state?: string }).state === "ON");
    expect(opens.length).toBe(2);
    // Order matters: plain ON must come first so a rejected on_time can't leave
    // the valve closed, and on capable devices the timer (2nd) is what sticks.
    expect(opens[0].value).toEqual({ state: "ON" });
    expect(opens[1].value).toEqual({ state: "ON", on_time: 120 });
    expect(h.getState("status")).toBe("watering");

    // After 2 min, the software off-timer closes the valve.
    await vi.advanceTimersByTimeAsync(120_000);
    const closes = h.orders.filter((o) => (o.value as { state?: string }).state === "OFF");
    expect(closes.length).toBe(1);
    expect(closes[0].value).toEqual({ state: "OFF" });
    expect(h.getState("status")).toBe("idle");

    inst.stop();
  });

  it("valve that rejects on_time still opens (via plain ON) and still closes", async () => {
    const h = makeCtx({ rejectOnTime: true });
    const inst = createRecipe().createInstance({ ...baseParams }, h.ctx);

    await vi.advanceTimersByTimeAsync(60_000);
    // Plain ON succeeded even though the on_time variant threw.
    expect(h.orders.some((o) => JSON.stringify(o.value) === JSON.stringify({ state: "ON" }))).toBe(true);
    expect(h.getState("status")).toBe("watering");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.orders.some((o) => (o.value as { state?: string }).state === "OFF")).toBe(true);
    expect(h.getState("status")).toBe("idle");

    inst.stop();
  });
});

describe("auto-watering resume after restart", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-arms the close when the deadline is still ahead (does not re-open)", async () => {
    vi.setSystemTime(new Date("2026-07-08T15:00:00"));
    const h = makeCtx();
    h.store.set("status", "watering");
    h.store.set("currentSlot", "14:59");
    h.store.set("wateringUntil", new Date(Date.now() + 60_000).toISOString());

    const inst = createRecipe().createInstance({ ...baseParams }, h.ctx);
    expect(h.getState("status")).toBe("watering");
    // Must NOT re-open the valve on resume.
    expect(h.orders.filter((o) => (o.value as { state?: string }).state === "ON").length).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.orders.some((o) => (o.value as { state?: string }).state === "OFF")).toBe(true);
    expect(h.getState("status")).toBe("idle");

    inst.stop();
  });

  it("closes valves immediately when the deadline already passed during downtime", async () => {
    vi.setSystemTime(new Date("2026-07-08T15:00:00"));
    const h = makeCtx();
    h.store.set("status", "watering");
    h.store.set("currentSlot", "14:40");
    h.store.set("wateringUntil", new Date(Date.now() - 60_000).toISOString());

    createRecipe().createInstance({ ...baseParams }, h.ctx);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.orders.some((o) => (o.value as { state?: string }).state === "OFF")).toBe(true);
    expect(h.getState("status")).toBe("idle");
  });
});
