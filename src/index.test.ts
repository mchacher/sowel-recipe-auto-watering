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

describe("auto-watering day-of-week filtering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday, 1 minute before the 14:45 slot.
    vi.setSystemTime(new Date("2026-07-08T14:44:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("custom preset: does not trigger on a day outside the configured list, then triggers on the right day", async () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance(
      { ...baseParams, slot1_daysPreset: "custom", slot1_days: "thu" },
      h.ctx,
    );

    // Wednesday 14:45 — Thursday-only slot must stay idle.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.orders.length).toBe(0);
    expect(h.getState("status")).toBe("idle");

    // Thursday 14:45 — now it should fire.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    const opens = h.orders.filter((o) => (o.value as { state?: string }).state === "ON");
    expect(opens.length).toBe(2);
    expect(h.getState("status")).toBe("watering");

    inst.stop();
  });

  it("custom preset: triggers normally when today is in the configured days list", async () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance(
      { ...baseParams, slot1_daysPreset: "custom", slot1_days: "mon,wed,fri" },
      h.ctx,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    const opens = h.orders.filter((o) => (o.value as { state?: string }).state === "ON");
    expect(opens.length).toBe(2);
    expect(h.getState("status")).toBe("watering");

    inst.stop();
  });

  it("weekdays preset triggers on Wednesday", async () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance(
      { ...baseParams, slot1_daysPreset: "weekdays" },
      h.ctx,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    const opens = h.orders.filter((o) => (o.value as { state?: string }).state === "ON");
    expect(opens.length).toBe(2);
    expect(h.getState("status")).toBe("watering");

    inst.stop();
  });

  it("weekend preset does not trigger on Wednesday, fires on Saturday", async () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance(
      { ...baseParams, slot1_daysPreset: "weekend" },
      h.ctx,
    );

    // Wednesday 14:45 — weekend-only slot must stay idle.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.orders.length).toBe(0);
    expect(h.getState("status")).toBe("idle");

    // Saturday 14:45 (3 days later) — now it should fire.
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);
    const opens = h.orders.filter((o) => (o.value as { state?: string }).state === "ON");
    expect(opens.length).toBe(2);
    expect(h.getState("status")).toBe("watering");

    inst.stop();
  });

  it("treats an unset preset as every day (backward compatible)", async () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance({ ...baseParams }, h.ctx);

    await vi.advanceTimersByTimeAsync(60_000);
    const opens = h.orders.filter((o) => (o.value as { state?: string }).state === "ON");
    expect(opens.length).toBe(2);

    inst.stop();
  });

  it("ignores a stale custom days value when the preset isn't custom", async () => {
    const h = makeCtx();
    // slot1_days holds leftover garbage, but the preset says "all" — must not throw or restrict.
    const inst = createRecipe().createInstance(
      { ...baseParams, slot1_daysPreset: "all", slot1_days: "not-a-real-day" },
      h.ctx,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    const opens = h.orders.filter((o) => (o.value as { state?: string }).state === "ON");
    expect(opens.length).toBe(2);

    inst.stop();
  });
});

describe("auto-watering days validation", () => {
  it("rejects an unknown days preset", () => {
    const recipe = createRecipe();
    const h = makeCtx();
    expect(() =>
      recipe.validate({ ...baseParams, slot1_daysPreset: "biweekly" }, h.ctx),
    ).toThrow(/biweekly/);
  });

  it("ignores an invalid custom days value when the preset isn't custom", () => {
    const recipe = createRecipe();
    const h = makeCtx();
    expect(() =>
      recipe.validate({ ...baseParams, slot1_daysPreset: "weekdays", slot1_days: "garbage" }, h.ctx),
    ).not.toThrow();
  });

  it("rejects an unknown day token in a custom-preset slot", () => {
    const recipe = createRecipe();
    const h = makeCtx();
    expect(() =>
      recipe.validate({ ...baseParams, slot1_daysPreset: "custom", slot1_days: "mon,foo" }, h.ctx),
    ).toThrow(/foo/);
  });

  it("accepts empty custom days and a valid comma/space-separated list", () => {
    const recipe = createRecipe();
    const h = makeCtx();
    expect(() =>
      recipe.validate({ ...baseParams, slot1_daysPreset: "custom", slot1_days: "" }, h.ctx),
    ).not.toThrow();
    expect(() =>
      recipe.validate({ ...baseParams, slot2_daysPreset: "custom", slot2_days: "mon, wed ,FRI" }, h.ctx),
    ).not.toThrow();
  });
});
