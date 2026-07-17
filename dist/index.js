/**
 * Sowel Recipe: Auto Watering
 *
 * Scheduled irrigation with up to 3 time slots, rain-aware skip logic.
 * Uses z2m's "on with timed off" pattern ({state:"ON",on_time:N}).
 *
 * Each slot has an optional per-weekday filter (a `select` + `list` slot).
 * No day selected = every day, so pre-1.2.0 instances behave exactly as before.
 */
// ============================================================
// Helpers
// ============================================================
function parseValveIds(raw) {
    if (typeof raw === "string")
        return raw.split(",").filter(Boolean);
    if (Array.isArray(raw))
        return raw.map(String);
    return [];
}
// ── Weekdays ──
/** Day-of-week tokens (Monday-first) → JS Date.getDay() values (0 = Sunday). */
const DAY_TOKEN_TO_DOW = {
    mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
};
/** Options for the per-slot weekday `select` (English fallback labels;
 *  localized labels come from the recipe i18n `options` map). */
export const WEEKDAY_OPTIONS = [
    { value: "mon", label: "Mon" },
    { value: "tue", label: "Tue" },
    { value: "wed", label: "Wed" },
    { value: "thu", label: "Thu" },
    { value: "fri", label: "Fri" },
    { value: "sat", label: "Sat" },
    { value: "sun", label: "Sun" },
];
/**
 * Parse a weekday parameter (comma string "mon,wed" or an array) into a set of
 * getDay() values. Unknown tokens are ignored. An empty set means "every day".
 */
export function parseDays(raw) {
    const tokens = typeof raw === "string"
        ? raw.split(",")
        : Array.isArray(raw)
            ? raw.map(String)
            : [];
    const set = new Set();
    for (const tok of tokens) {
        const dow = DAY_TOKEN_TO_DOW[tok.trim().toLowerCase()];
        if (dow !== undefined)
            set.add(dow);
    }
    return set;
}
/**
 * ms delay from `now` to the next occurrence of HH:MM on an allowed weekday.
 * `days` empty = every day (reduces to the today-or-tomorrow behavior). Scans up
 * to 8 calendar days so a weekly recurrence is always found. Weekday and hours
 * are evaluated in the process timezone (Sowel sets TZ=Europe/Paris).
 */
export function msUntilTime(time, days, now = new Date()) {
    const [h, m] = time.split(":").map(Number);
    for (let offset = 0; offset <= 7; offset++) {
        const target = new Date(now);
        target.setHours(h, m, 0, 0);
        target.setDate(target.getDate() + offset);
        if (target.getTime() <= now.getTime())
            continue;
        if (days.size === 0 || days.has(target.getDay())) {
            return target.getTime() - now.getTime();
        }
    }
    // Defensive fallback (unreachable when at least one weekday is allowed): 24h.
    return 24 * 60 * 60 * 1000;
}
/** Find the soonest scheduled slot across their weekday filters. */
export function findNextSlot(slots, now = new Date()) {
    if (slots.length === 0)
        return null;
    let best = null;
    let bestMs = Infinity;
    for (const slot of slots) {
        const ms = msUntilTime(slot.time, slot.days, now);
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
function buildSlots() {
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
        { id: "slot1_days", name: "Days", description: "Days of week (empty = every day)",
            type: "select", list: true, required: false, options: WEEKDAY_OPTIONS, group: "slot1" },
        // Slot 2 (optional)
        { id: "slot2_time", name: "Time", description: "Watering time",
            type: "time", required: false, group: "slot2" },
        { id: "slot2_duration", name: "Duration (min)", description: "Duration in minutes",
            type: "number", required: false,
            constraints: { min: 1, max: 120 }, group: "slot2" },
        { id: "slot2_days", name: "Days", description: "Days of week (empty = every day)",
            type: "select", list: true, required: false, options: WEEKDAY_OPTIONS, group: "slot2" },
        // Slot 3 (optional)
        { id: "slot3_time", name: "Time", description: "Watering time",
            type: "time", required: false, group: "slot3" },
        { id: "slot3_duration", name: "Duration (min)", description: "Duration in minutes",
            type: "number", required: false,
            constraints: { min: 1, max: 120 }, group: "slot3" },
        { id: "slot3_days", name: "Days", description: "Days of week (empty = every day)",
            type: "select", list: true, required: false, options: WEEKDAY_OPTIONS, group: "slot3" },
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
const FR_DAY_LABELS = {
    mon: "Lun", tue: "Mar", wed: "Mer", thu: "Jeu", fri: "Ven", sat: "Sam", sun: "Dim",
};
const FR = {
    name: "Arrosage Auto",
    description: "Arrosage programmé avec créneaux horaires et gestion intelligente de la pluie",
    slots: {
        zone: { name: "Zone", description: "Zone d'arrosage" },
        valves: { name: "Vannes d'arrosage", description: "Vannes à piloter" },
        slot1_time: { name: "Heure", description: "Heure d'arrosage" },
        slot1_duration: { name: "Durée (min)", description: "Durée en minutes" },
        slot1_days: { name: "Jours", description: "Jours de la semaine (vide = tous les jours)", options: FR_DAY_LABELS },
        slot2_time: { name: "Heure", description: "Heure d'arrosage" },
        slot2_duration: { name: "Durée (min)", description: "Durée en minutes" },
        slot2_days: { name: "Jours", description: "Jours de la semaine (vide = tous les jours)", options: FR_DAY_LABELS },
        slot3_time: { name: "Heure", description: "Heure d'arrosage" },
        slot3_duration: { name: "Durée (min)", description: "Durée en minutes" },
        slot3_days: { name: "Jours", description: "Jours de la semaine (vide = tous les jours)", options: FR_DAY_LABELS },
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
export function createRecipe() {
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
            if (!params.slot1_time)
                throw new Error("Slot 1 time is required");
            if (!params.slot1_duration)
                throw new Error("Slot 1 duration is required");
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
        },
        createInstance(params, ctx) {
            const valveIds = parseValveIds(params.valves);
            const weatherStationId = params.weatherStation ? String(params.weatherStation) : null;
            const rainThreshold = params.rainThreshold ? Number(params.rainThreshold) : null;
            const forecastThreshold = params.forecastThreshold ? Number(params.forecastThreshold) : null;
            // Build active time slots from params
            const timeSlots = [];
            for (const n of [1, 2, 3]) {
                const time = params[`slot${n}_time`];
                const dur = params[`slot${n}_duration`];
                if (time && dur) {
                    timeSlots.push({
                        time: String(time),
                        durationMin: Math.max(1, Math.min(120, Number(dur) || 10)),
                        days: parseDays(params[`slot${n}_days`]),
                    });
                }
            }
            // Timers
            const triggerTimers = new Map();
            let completionTimer = null;
            // ── Helpers ──
            function valveName(id) {
                return ctx.equipmentManager.getById(id)?.name ?? id.slice(0, 8);
            }
            function durationMinutes(slot) {
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
            async function openValve(vId, durMin) {
                const name = valveName(vId);
                try {
                    await ctx.equipmentManager.executeOrder(vId, "state", { state: "ON" });
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    ctx.log(`Erreur ouverture ${name}: ${msg}`, "error");
                    return false;
                }
                try {
                    await ctx.equipmentManager.executeOrder(vId, "state", {
                        state: "ON",
                        on_time: durMin * 60,
                    });
                }
                catch {
                    // Device without on_time support (or transient): the software
                    // off-timer is the fallback close. The valve is already open.
                }
                ctx.log(`${name} ouverte pour ${durMin} min`);
                return true;
            }
            async function closeValve(vId) {
                const name = valveName(vId);
                try {
                    await ctx.equipmentManager.executeOrder(vId, "state", { state: "OFF" });
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    ctx.log(`Erreur fermeture ${name}: ${msg}`, "error");
                }
            }
            function armCompletion(ms, slotTime) {
                if (completionTimer)
                    clearTimeout(completionTimer);
                completionTimer = setTimeout(() => {
                    void finishWatering(slotTime);
                }, ms);
            }
            async function finishWatering(slotTime) {
                completionTimer = null;
                for (const vId of valveIds)
                    await closeValve(vId);
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
            function resumeIfWatering() {
                if (ctx.state.get("status") !== "watering")
                    return;
                const untilRaw = ctx.state.get("wateringUntil");
                const slotTime = String(ctx.state.get("currentSlot") ?? "");
                const until = typeof untilRaw === "string" ? Date.parse(untilRaw) : NaN;
                const remaining = Number.isFinite(until) ? until - Date.now() : -1;
                if (remaining > 0) {
                    armCompletion(remaining, slotTime);
                    ctx.log(`Reprise arrosage ${slotTime} — fermeture dans ${Math.ceil(remaining / 60000)} min`);
                }
                else {
                    ctx.state.set("status", "idle");
                    ctx.state.set("currentSlot", null);
                    ctx.state.delete("wateringUntil");
                    ctx.log("Reprise après échéance — fermeture des vannes par sécurité");
                    for (const vId of valveIds)
                        void closeValve(vId);
                }
            }
            // ── Rain check ──
            function shouldSkipRain() {
                if (!weatherStationId || rainThreshold === null)
                    return { skip: false, reason: "" };
                const eq = ctx.equipmentManager.getByIdWithDetails(weatherStationId);
                if (!eq)
                    return { skip: false, reason: "" };
                const rain24h = eq.computedData?.find((c) => c.alias === "rain_24h");
                if (!rain24h || rain24h.value === null)
                    return { skip: false, reason: "" };
                const value = Number(rain24h.value);
                if (value > rainThreshold) {
                    return { skip: true, reason: `rain_24h = ${value} mm (seuil: ${rainThreshold} mm)` };
                }
                return { skip: false, reason: "" };
            }
            // ── Forecast check ──
            function shouldSkipForecast() {
                if (forecastThreshold === null)
                    return { skip: false, reason: "" };
                const allEq = ctx.equipmentManager.getAllWithDetails();
                const forecast = allEq.find((e) => e.type === "weather_forecast");
                if (!forecast)
                    return { skip: false, reason: "" };
                const prob = forecast.dataBindings.find((b) => b.alias === "j1_rain_prob");
                if (!prob || typeof prob.value !== "number")
                    return { skip: false, reason: "" };
                if (prob.value > forecastThreshold) {
                    return { skip: true, reason: `probabilité pluie J+1 = ${prob.value}% (seuil: ${forecastThreshold}%)` };
                }
                return { skip: false, reason: "" };
            }
            // ── Trigger ──
            async function triggerSlot(slot) {
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
                const summary = [];
                for (const vId of valveIds) {
                    if (await openValve(vId, durMin))
                        summary.push(`${valveName(vId)} ${durMin}min`);
                }
                ctx.log(`Arrosage créneau ${slot.time} — ${summary.join(", ")}`);
                // Reliable close after the duration (works with or without hardware on_time)
                armCompletion(durMs, slot.time);
            }
            // ── Scheduling ──
            function updateNextSlot() {
                const next = findNextSlot(timeSlots);
                ctx.state.set("nextSlot", next?.time ?? null);
            }
            function scheduleSlot(slot) {
                const existing = triggerTimers.get(slot.time);
                if (existing)
                    clearTimeout(existing);
                const delay = msUntilTime(slot.time, slot.days);
                const timer = setTimeout(() => {
                    triggerSlot(slot).catch((err) => ctx.logger.error({ err, slot: slot.time }, "Trigger failed"));
                    // Reschedule for tomorrow
                    scheduleSlot(slot);
                }, delay);
                triggerTimers.set(slot.time, timer);
            }
            function scheduleAll() {
                for (const slot of timeSlots)
                    scheduleSlot(slot);
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
                    for (const timer of triggerTimers.values())
                        clearTimeout(timer);
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
