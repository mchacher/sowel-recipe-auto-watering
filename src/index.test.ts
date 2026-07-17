import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRecipe, parseDays, msUntilTime, findNextSlot } from "./index.js";

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

// ============================================================
// Weekday helpers (spec 130) — pure functions with an injected `now`
// ============================================================

describe("weekday helpers", () => {
  // 2026-07-08 is a Wednesday (getDay() === 3), local time.
  const wed8am = new Date("2026-07-08T08:00:00");

  it("parseDays maps tokens to getDay() values, ignoring unknowns and case", () => {
    expect([...parseDays("mon,wed,fri")].sort()).toEqual([1, 3, 5]);
    expect([...parseDays(["sat", "sun"])].sort()).toEqual([0, 6]);
    expect(parseDays("").size).toBe(0);
    expect(parseDays(undefined).size).toBe(0);
    expect(parseDays([]).size).toBe(0);
    expect([...parseDays("mon,bogus,SUN")].sort()).toEqual([0, 1]);
  });

  it("empty days: fires later today when the time is still ahead", () => {
    expect(msUntilTime("09:00", new Set(), wed8am)).toBe(60 * 60 * 1000);
  });

  it("empty days: rolls to tomorrow when the time already passed", () => {
    expect(msUntilTime("07:00", new Set(), wed8am)).toBe(23 * 60 * 60 * 1000);
  });

  it("all seven days behaves exactly like empty (every day)", () => {
    const all = new Set([0, 1, 2, 3, 4, 5, 6]);
    expect(msUntilTime("09:00", all, wed8am)).toBe(60 * 60 * 1000);
    expect(msUntilTime("07:00", all, wed8am)).toBe(23 * 60 * 60 * 1000);
  });

  it("today allowed and ahead → fires today", () => {
    const target = new Date(wed8am.getTime() + msUntilTime("09:00", new Set([3]), wed8am));
    expect(target.getDate()).toBe(8);
    expect(target.getHours()).toBe(9);
  });

  it("today not allowed → next allowed weekday", () => {
    // Wednesday now, only Thursday allowed.
    const target = new Date(wed8am.getTime() + msUntilTime("09:00", new Set([4]), wed8am));
    expect(target.getDay()).toBe(4);
    expect(target.getDate()).toBe(9);
    expect(target.getHours()).toBe(9);
  });

  it("time passed today and only today's weekday allowed → next week", () => {
    const target = new Date(wed8am.getTime() + msUntilTime("07:00", new Set([3]), wed8am));
    expect(target.getDay()).toBe(3);
    expect(target.getDate()).toBe(15);
    expect(target.getHours()).toBe(7);
  });

  it("findNextSlot picks the soonest slot across weekday filters", () => {
    const fri10am = new Date("2026-07-10T10:00:00"); // Friday
    const slots = [
      { time: "07:30", durationMin: 5, days: new Set([1, 2, 3, 4, 5]) }, // Mon-Fri (07:30 already passed today)
      { time: "09:00", durationMin: 5, days: new Set([6, 0]) },          // Sat-Sun → Saturday 09:00 is sooner
    ];
    expect(findNextSlot(slots, fri10am)?.time).toBe("09:00");
  });
});

// ============================================================
// Weekday scheduling end-to-end (Romain's case, issue #306)
// ============================================================

describe("auto-watering weekday scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("on Wednesday, the school-day slot is skipped and the Wed/weekend slot fires", async () => {
    // Wednesday 08:00 — after slot1's 07:30, before slot2's 09:00.
    vi.setSystemTime(new Date("2026-07-08T08:00:00"));
    const h = makeCtx();
    const params = {
      ...baseParams,
      slot1_time: "07:30", slot1_duration: "5", slot1_days: "mon,tue,thu,fri",
      slot2_time: "09:00", slot2_duration: "5", slot2_days: "wed,sat,sun",
    };
    const inst = createRecipe().createInstance(params, h.ctx);

    // Advance to 09:00. slot1 (07:30, excluded on Wed) must NOT fire; slot2 must.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(h.getState("status")).toBe("watering");
    expect(h.getState("currentSlot")).toBe("09:00");
    expect(h.orders.some((o) => (o.value as { state?: string }).state === "ON")).toBe(true);

    inst.stop();
  });
});
