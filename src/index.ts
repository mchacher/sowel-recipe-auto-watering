/**
 * Sowel Recipe: Auto Watering
 *
 * Scheduled irrigation with up to 3 time slots, rain-aware skip logic.
 * Uses z2m's "on with timed off" pattern ({state:"ON",on_time:N}).
 *
 * All slots use standard core types (time, duration, equipment, number,
 * boolean) — no custom slot types needed.
 */

// ============================================================
// Types (mirrored from Sowel core — recipe plugins don't import core)
// ============================================================

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type:
    | "zone"
    | "equipment"
    | "number"
    | "duration"
    | "time"
    | "boolean"
    | "text"
    | "data-key"
    | "select";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  /** For `type: "select"` — the closed list of choices rendered as a dropdown. */
  options?: { value: string; label: string }[];
  /** Hide this slot in the recipe form when a sibling slot's value matches. */
  hiddenWhen?: { slot: string; equals: string | string[] };
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
  };
  group?: string;
}

interface RecipeSlotI18n {
  name: string;
  description: string;
  /** Per-language labels for a `select` slot's options, keyed by option value. */
  options?: Record<string, string>;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, RecipeSlotI18n>;
  groups?: Record<string, string>;
}

interface RecipeInstanceHandle {
  stop(): void;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(
    params: Record<string, unknown>,
    ctx: RecipeContext,
  ): RecipeInstanceHandle;
}

interface ComputedDataEntry {
  alias: string;
  value: unknown;
  unit?: string;
  category?: string;
  lastUpdated: string | null;
}

interface DataBindingWithValue {
  alias: string;
  value: unknown;
  category: string;
  [key: string]: unknown;
}

interface Equipment {
  id: string;
  name: string;
  type: string;
  [key: string]: unknown;
}

interface EquipmentWithDetails extends Equipment {
  dataBindings: DataBindingWithValue[];
  orderBindings: { alias: string; [key: string]: unknown }[];
  computedData?: ComputedDataEntry[];
}

interface RecipeStateStore {
  get(key: string): unknown | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  clear(): void;
}

interface EquipmentManager {
  getById(id: string): Equipment | null;
  getByIdWithDetails(id: string): EquipmentWithDetails | null;
  getAllWithDetails(): EquipmentWithDetails[];
  executeOrder(
    equipmentId: string,
    alias: string,
    value: unknown,
  ): Promise<{ success: boolean; error?: string }>;
}

interface RecipeContext {
  eventBus: { onType(type: string, handler: (event: unknown) => void): () => void };
  equipmentManager: EquipmentManager;
  zoneManager: { getById(id: string): unknown | null };
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
  state: RecipeStateStore;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: { parseDuration(value: unknown): number };
}

// ============================================================
// Schedule slot definition
// ============================================================

interface TimeSlot {
  time: string;       // "HH:MM"
  durationMin: number; // minutes
  days: Set<number>;   // JS Date#getDay() values (0=Sun..6=Sat) allowed to trigger
}

// ============================================================
// Helpers
// ============================================================

function parseValveIds(raw: unknown): string[] {
  if (typeof raw === "string") return raw.split(",").filter(Boolean);
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

const DAY_TOKENS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const ALL_DAYS = new Set<number>([0, 1, 2, 3, 4, 5, 6]);

/**
 * Parse a comma/space-separated list of day tokens (mon,tue,wed,thu,fri,sat,sun)
 * into a Set of JS Date#getDay() values. Empty/unset means every day.
 * Throws on an unknown token.
 */
function parseDays(raw: unknown): Set<number> {
  if (raw === undefined || raw === null || raw === "") return new Set(ALL_DAYS);
  const tokens = String(raw).toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (tokens.length === 0) return new Set(ALL_DAYS);
  const days = new Set<number>();
  for (const token of tokens) {
    const day = DAY_TOKENS[token];
    if (day === undefined) {
      throw new Error(`Unknown day "${token}" — use mon,tue,wed,thu,fri,sat,sun`);
    }
    days.add(day);
  }
  return days;
}

const DAYS_PRESETS: Record<string, Set<number> | null> = {
  all: ALL_DAYS,
  weekdays: new Set([1, 2, 3, 4, 5]),
  weekend: new Set([0, 6]),
  custom: null, // resolved from the slot's free-text days field
};

const DAYS_PRESET_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "Every day" },
  { value: "weekdays", label: "Weekdays (Mon-Fri)" },
  { value: "weekend", label: "Weekend (Sat-Sun)" },
  { value: "custom", label: "Custom..." },
];

/**
 * Resolve the allowed days for slot `n` from its preset select (`slotN_daysPreset`)
 * plus, when the preset is "custom", its free-text days field (`slotN_days`).
 * Unset preset defaults to "all" (every day — matches the pre-preset behavior).
 */
function resolveDays(params: Record<string, unknown>, n: number): Set<number> {
  const preset = params[`slot${n}_daysPreset`];
  const presetKey = preset ? String(preset) : "all";
  const fixed = DAYS_PRESETS[presetKey];
  if (fixed) return new Set(fixed);
  return parseDays(params[`slot${n}_days`]);
}

/** Compute ms delay from now to the next occurrence of HH:MM on one of `days`. */
function msUntilNextOccurrence(time: string, days: Set<number>): number {
  const [h, m] = time.split(":").map(Number);
  const now = new Date();
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(h, m, 0, 0);
    if (candidate.getTime() > now.getTime() && days.has(candidate.getDay())) {
      return candidate.getTime() - now.getTime();
    }
  }
  // Unreachable: parseDays() never returns an empty set.
  return 24 * 60 * 60 * 1000;
}

/** Find the soonest scheduled slot. */
function findNextSlot(slots: TimeSlot[]): TimeSlot | null {
  if (slots.length === 0) return null;
  let best: TimeSlot | null = null;
  let bestMs = Infinity;
  for (const slot of slots) {
    const ms = msUntilNextOccurrence(slot.time, slot.days);
    if (ms < bestMs) {
      bestMs = ms;
      best = slot;
    }
  }
  return best;
}

// ============================================================
// Slot definitions
// ============================================================

function buildSlots(): RecipeSlotDef[] {
  return [
    // Core
    { id: "zone", name: "Zone", description: "Zone to manage", type: "zone", required: true },
    { id: "valves", name: "Water valves", description: "Valves to control",
      type: "equipment", list: true, required: true,
      constraints: { equipmentType: "water_valve" } },

    // Slot 1 (required — group with required slots → always visible in UI)
    { id: "slot1_time", name: "Time", description: "Watering time",
      type: "time", required: true, group: "slot1" },
    { id: "slot1_duration", name: "Duration (min)", description: "Duration in minutes",
      type: "number", required: true, defaultValue: 10,
      constraints: { min: 1, max: 120 }, group: "slot1" },
    { id: "slot1_daysPreset", name: "Days", description: "Days of week this slot runs on",
      type: "select", required: false, defaultValue: "all", options: DAYS_PRESET_OPTIONS,
      group: "slot1" },
    { id: "slot1_days", name: "Custom days", description: "e.g. mon,tue,wed,thu,fri",
      type: "text", required: false, group: "slot1",
      hiddenWhen: { slot: "slot1_daysPreset", equals: ["all", "weekdays", "weekend"] } },

    // Slot 2 (optional)
    { id: "slot2_time", name: "Time", description: "Watering time",
      type: "time", required: false, group: "slot2" },
    { id: "slot2_duration", name: "Duration (min)", description: "Duration in minutes",
      type: "number", required: false,
      constraints: { min: 1, max: 120 }, group: "slot2" },
    { id: "slot2_daysPreset", name: "Days", description: "Days of week this slot runs on",
      type: "select", required: false, defaultValue: "all", options: DAYS_PRESET_OPTIONS,
      group: "slot2" },
    { id: "slot2_days", name: "Custom days", description: "e.g. mon,tue,wed,thu,fri",
      type: "text", required: false, group: "slot2",
      hiddenWhen: { slot: "slot2_daysPreset", equals: ["all", "weekdays", "weekend"] } },

    // Slot 3 (optional)
    { id: "slot3_time", name: "Time", description: "Watering time",
      type: "time", required: false, group: "slot3" },
    { id: "slot3_duration", name: "Duration (min)", description: "Duration in minutes",
      type: "number", required: false,
      constraints: { min: 1, max: 120 }, group: "slot3" },
    { id: "slot3_daysPreset", name: "Days", description: "Days of week this slot runs on",
      type: "select", required: false, defaultValue: "all", options: DAYS_PRESET_OPTIONS,
      group: "slot3" },
    { id: "slot3_days", name: "Custom days", description: "e.g. mon,tue,wed,thu,fri",
      type: "text", required: false, group: "slot3",
      hiddenWhen: { slot: "slot3_daysPreset", equals: ["all", "weekdays", "weekend"] } },

    // Weather condition (optional)
    { id: "weatherStation", name: "Weather station",
      description: "Weather equipment to read rain_24h from",
      type: "equipment", required: false,
      constraints: { equipmentType: "weather" }, group: "weather" },
    { id: "rainThreshold", name: "Rain threshold (mm)",
      description: "Skip if rain_24h exceeds this",
      type: "number", required: false,
      constraints: { min: 0, max: 50 }, group: "weather" },

    // Forecast
    { id: "forecastThreshold", name: "Rain forecast threshold (%)",
      description: "Skip if rain probability J+1 exceeds this threshold",
      type: "number", required: false,
      constraints: { min: 50, max: 100 }, group: "forecast" },
  ];
}

// ============================================================
// i18n
// ============================================================

const DAYS_PRESET_OPTIONS_FR: Record<string, string> = {
  all: "Tous les jours",
  weekdays: "Semaine (lun-ven)",
  weekend: "Week-end (sam-dim)",
  custom: "Personnalisé...",
};

const FR: RecipeLangPack = {
  name: "Arrosage Auto",
  description: "Arrosage programmé avec créneaux horaires et gestion intelligente de la pluie",
  slots: {
    zone: { name: "Zone", description: "Zone d'arrosage" },
    valves: { name: "Vannes d'arrosage", description: "Vannes à piloter" },
    slot1_time: { name: "Heure", description: "Heure d'arrosage" },
    slot1_duration: { name: "Durée (min)", description: "Durée en minutes" },
    slot1_daysPreset: { name: "Jours", description: "Jours de la semaine pour ce créneau", options: DAYS_PRESET_OPTIONS_FR },
    slot1_days: { name: "Jours personnalisés", description: "ex: mon,tue,wed,thu,fri" },
    slot2_time: { name: "Heure", description: "Heure d'arrosage" },
    slot2_duration: { name: "Durée (min)", description: "Durée en minutes" },
    slot2_daysPreset: { name: "Jours", description: "Jours de la semaine pour ce créneau", options: DAYS_PRESET_OPTIONS_FR },
    slot2_days: { name: "Jours personnalisés", description: "ex: mon,tue,wed,thu,fri" },
    slot3_time: { name: "Heure", description: "Heure d'arrosage" },
    slot3_duration: { name: "Durée (min)", description: "Durée en minutes" },
    slot3_daysPreset: { name: "Jours", description: "Jours de la semaine pour ce créneau", options: DAYS_PRESET_OPTIONS_FR },
    slot3_days: { name: "Jours personnalisés", description: "ex: mon,tue,wed,thu,fri" },
    weatherStation: { name: "Station météo", description: "Pour lire le cumul de pluie 24h" },
    rainThreshold: { name: "Seuil de pluie (mm)", description: "Ne pas arroser si le cumul de pluie sur 24h dépasse ce seuil" },
    forecastThreshold: { name: "Seuil prévision pluie (%)", description: "Ne pas arroser si la probabilité de pluie le lendemain dépasse ce seuil" },
  },
  groups: {
    slot1: "Créneau 1",
    slot2: "Créneau 2",
    slot3: "Créneau 3",
    weather: "Condition pluie",
    forecast: "Prévision météo",
  },
};

// ============================================================
// Recipe definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "auto-watering",
    name: "Auto Watering",
    description: "Scheduled irrigation with configurable time slots and rain-aware skip logic",
    slots: buildSlots(),
    i18n: { fr: FR },

    validate(params, ctx) {
      const valveIds = parseValveIds(params.valves);
      if (valveIds.length === 0) {
        throw new Error("At least one valve must be selected");
      }

      // Slot 1 is required
      if (!params.slot1_time) throw new Error("Slot 1 time is required");
      if (!params.slot1_duration) throw new Error("Slot 1 duration is required");

      // Validate optional slots: if time is set, duration must be set too
      if (params.slot2_time && !params.slot2_duration) {
        throw new Error("Slot 2 duration is required when time is set");
      }
      if (params.slot3_time && !params.slot3_duration) {
        throw new Error("Slot 3 duration is required when time is set");
      }

      // Weather: if station set, threshold required
      if (params.weatherStation && !params.rainThreshold) {
        throw new Error("Rain threshold is required when a weather station is selected");
      }

      // Days: preset must be known; custom days are only validated when selected
      for (const n of [1, 2, 3] as const) {
        const presetRaw = params[`slot${n}_daysPreset`];
        const preset = presetRaw ? String(presetRaw) : "all";
        if (!(preset in DAYS_PRESETS)) {
          throw new Error(`Slot ${n} days: unknown preset "${preset}"`);
        }
        if (preset !== "custom") continue;

        const daysRaw = params[`slot${n}_days`];
        if (daysRaw === undefined || daysRaw === null || daysRaw === "") continue;
        try {
          parseDays(daysRaw);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Slot ${n} days: ${msg}`);
        }
      }
    },

    createInstance(params, ctx) {
      const valveIds = parseValveIds(params.valves);
      const weatherStationId = params.weatherStation ? String(params.weatherStation) : null;
      const rainThreshold = params.rainThreshold ? Number(params.rainThreshold) : null;
      const forecastThreshold = params.forecastThreshold ? Number(params.forecastThreshold) : null;

      // Build active time slots from params
      const timeSlots: TimeSlot[] = [];
      for (const n of [1, 2, 3]) {
        const time = params[`slot${n}_time`];
        const dur = params[`slot${n}_duration`];
        if (time && dur) {
          timeSlots.push({
            time: String(time),
            durationMin: Math.max(1, Math.min(120, Number(dur) || 10)),
            days: resolveDays(params, n),
          });
        }
      }

      // Timers
      const triggerTimers = new Map<string, ReturnType<typeof setTimeout>>();
      let completionTimer: ReturnType<typeof setTimeout> | null = null;

      // ── Helpers ──

      function valveName(id: string): string {
        return ctx.equipmentManager.getById(id)?.name ?? id.slice(0, 8);
      }

      function durationMinutes(slot: TimeSlot): number {
        return slot.durationMin;
      }

      // ── Valve control ──

      /**
       * Open a valve for `durMin` minutes, robust across valve types.
       *
       * 1. Plain `{ state: "ON" }` first — accepted by every valve, including
       *    Tuya irrigation timers that reject the `on_time` property (and with
       *    it the whole command). This guarantees the valve actually opens.
       * 2. Then `{ state: "ON", on_time }` — valves that support `on_time` also
       *    arm a hardware auto-off, which survives a Sowel outage. Valves that
       *    don't support it silently ignore this second command; they are
       *    already open from step 1. Sent best-effort so its rejection never
       *    hides a successful open.
       *
       * A software off-timer (armCompletion) is the reliable close in all cases.
       */
      async function openValve(vId: string, durMin: number): Promise<boolean> {
        const name = valveName(vId);
        try {
          await ctx.equipmentManager.executeOrder(vId, "state", { state: "ON" });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`Erreur ouverture ${name}: ${msg}`, "error");
          return false;
        }
        try {
          await ctx.equipmentManager.executeOrder(vId, "state", {
            state: "ON",
            on_time: durMin * 60,
          });
        } catch {
          // Device without on_time support (or transient): the software
          // off-timer is the fallback close. The valve is already open.
        }
        ctx.log(`${name} ouverte pour ${durMin} min`);
        return true;
      }

      async function closeValve(vId: string): Promise<void> {
        const name = valveName(vId);
        try {
          await ctx.equipmentManager.executeOrder(vId, "state", { state: "OFF" });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`Erreur fermeture ${name}: ${msg}`, "error");
        }
      }

      function armCompletion(ms: number, slotTime: string): void {
        if (completionTimer) clearTimeout(completionTimer);
        completionTimer = setTimeout(() => {
          void finishWatering(slotTime);
        }, ms);
      }

      async function finishWatering(slotTime: string): Promise<void> {
        completionTimer = null;
        for (const vId of valveIds) await closeValve(vId);
        ctx.state.set("status", "idle");
        ctx.state.set("currentSlot", null);
        ctx.state.delete("wateringUntil");
        updateNextSlot();
        ctx.log(`Arrosage créneau ${slotTime} terminé`);
      }

      /**
       * After a Sowel restart, pick up an in-progress watering: if the deadline
       * is still ahead, re-arm the software close; if it has already passed
       * (Sowel was down), close the valves now as a safety. Valves are never
       * re-opened — an interrupted watering is only guaranteed to end, not
       * restarted (avoids surprise over-watering).
       */
      function resumeIfWatering(): void {
        if (ctx.state.get("status") !== "watering") return;
        const untilRaw = ctx.state.get("wateringUntil");
        const slotTime = String(ctx.state.get("currentSlot") ?? "");
        const until = typeof untilRaw === "string" ? Date.parse(untilRaw) : NaN;
        const remaining = Number.isFinite(until) ? until - Date.now() : -1;
        if (remaining > 0) {
          armCompletion(remaining, slotTime);
          ctx.log(`Reprise arrosage ${slotTime} — fermeture dans ${Math.ceil(remaining / 60000)} min`);
        } else {
          ctx.state.set("status", "idle");
          ctx.state.set("currentSlot", null);
          ctx.state.delete("wateringUntil");
          ctx.log("Reprise après échéance — fermeture des vannes par sécurité");
          for (const vId of valveIds) void closeValve(vId);
        }
      }

      // ── Rain check ──

      function shouldSkipRain(): { skip: boolean; reason: string } {
        if (!weatherStationId || rainThreshold === null) return { skip: false, reason: "" };

        const eq = ctx.equipmentManager.getByIdWithDetails(weatherStationId);
        if (!eq) return { skip: false, reason: "" };

        const rain24h = eq.computedData?.find((c) => c.alias === "rain_24h");
        if (!rain24h || rain24h.value === null) return { skip: false, reason: "" };

        const value = Number(rain24h.value);
        if (value > rainThreshold) {
          return { skip: true, reason: `rain_24h = ${value} mm (seuil: ${rainThreshold} mm)` };
        }
        return { skip: false, reason: "" };
      }

      // ── Forecast check ──

      function shouldSkipForecast(): { skip: boolean; reason: string } {
        if (forecastThreshold === null) return { skip: false, reason: "" };

        const allEq = ctx.equipmentManager.getAllWithDetails();
        const forecast = allEq.find((e) => e.type === "weather_forecast");
        if (!forecast) return { skip: false, reason: "" };

        const prob = forecast.dataBindings.find((b) => b.alias === "j1_rain_prob");
        if (!prob || typeof prob.value !== "number") return { skip: false, reason: "" };

        if (prob.value > forecastThreshold) {
          return { skip: true, reason: `probabilité pluie J+1 = ${prob.value}% (seuil: ${forecastThreshold}%)` };
        }
        return { skip: false, reason: "" };
      }

      // ── Trigger ──

      async function triggerSlot(slot: TimeSlot): Promise<void> {
        const durMin = durationMinutes(slot);
        ctx.log(`Créneau ${slot.time} — évaluation des conditions`);

        // Rain check
        const rain = shouldSkipRain();
        if (rain.skip) {
          ctx.log(`Créneau ${slot.time} skippé — ${rain.reason}`);
          ctx.state.set("status", "skipped");
          ctx.state.set("lastSkipReason", rain.reason);
          ctx.state.set("currentSlot", null);
          updateNextSlot();
          return;
        }

        // Forecast check
        const forecast = shouldSkipForecast();
        if (forecast.skip) {
          ctx.log(`Créneau ${slot.time} skippé — ${forecast.reason}`);
          ctx.state.set("status", "skipped");
          ctx.state.set("lastSkipReason", forecast.reason);
          ctx.state.set("currentSlot", null);
          updateNextSlot();
          return;
        }

        // Open all valves
        const durMs = durMin * 60 * 1000;
        ctx.state.set("status", "watering");
        ctx.state.set("currentSlot", slot.time);
        ctx.state.set("lastSkipReason", null);
        ctx.state.set("wateringUntil", new Date(Date.now() + durMs).toISOString());

        const summary: string[] = [];
        for (const vId of valveIds) {
          if (await openValve(vId, durMin)) summary.push(`${valveName(vId)} ${durMin}min`);
        }

        ctx.log(`Arrosage créneau ${slot.time} — ${summary.join(", ")}`);

        // Reliable close after the duration (works with or without hardware on_time)
        armCompletion(durMs, slot.time);
      }

      // ── Scheduling ──

      function updateNextSlot(): void {
        const next = findNextSlot(timeSlots);
        ctx.state.set("nextSlot", next?.time ?? null);
      }

      function scheduleSlot(slot: TimeSlot): void {
        const existing = triggerTimers.get(slot.time);
        if (existing) clearTimeout(existing);

        const delay = msUntilNextOccurrence(slot.time, slot.days);
        const timer = setTimeout(() => {
          triggerSlot(slot).catch((err) =>
            ctx.logger.error({ err, slot: slot.time }, "Trigger failed"),
          );
          // Reschedule for tomorrow
          scheduleSlot(slot);
        }, delay);
        triggerTimers.set(slot.time, timer);
      }

      function scheduleAll(): void {
        for (const slot of timeSlots) scheduleSlot(slot);
      }

      // ── Initialize ──

      // Resume an in-progress watering across a restart BEFORE resetting state.
      resumeIfWatering();
      if (ctx.state.get("status") !== "watering") {
        ctx.state.set("status", "idle");
        ctx.state.set("currentSlot", null);
      }
      ctx.state.set("lastSkipReason", null);
      updateNextSlot();
      scheduleAll();

      const slotTimes = timeSlots.map((s) => s.time).join(", ");
      ctx.log(`Recette démarrée — ${timeSlots.length} créneau(x), ${valveIds.length} vanne(s) [${slotTimes}]`);

      return {
        stop() {
          for (const timer of triggerTimers.values()) clearTimeout(timer);
          triggerTimers.clear();
          if (completionTimer) {
            clearTimeout(completionTimer);
            completionTimer = null;
          }
          // Intentionally do NOT reset status/currentSlot/wateringUntil here:
          // that persisted state lets createInstance() resume an in-progress
          // watering after a plugin reload.
          ctx.log("Recette arrêtée");
        },
      };
    },
  };
}
