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
// Helpers
// ============================================================
function parseValveIds(raw) {
    if (typeof raw === "string")
        return raw.split(",").filter(Boolean);
    if (Array.isArray(raw))
        return raw.map(String);
    return [];
}
/** Compute ms delay from now to the next occurrence of HH:MM today or tomorrow. */
function msUntilTime(time) {
    const [h, m] = time.split(":").map(Number);
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1);
    }
    return target.getTime() - now.getTime();
}
/** Find the soonest scheduled slot. */
function findNextSlot(slots) {
    if (slots.length === 0)
        return null;
    let best = null;
    let bestMs = Infinity;
    for (const slot of slots) {
        const ms = msUntilTime(slot.time);
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
        // Slot 2 (optional)
        { id: "slot2_time", name: "Time", description: "Watering time",
            type: "time", required: false, group: "slot2" },
        { id: "slot2_duration", name: "Duration (min)", description: "Duration in minutes",
            type: "number", required: false,
            constraints: { min: 1, max: 120 }, group: "slot2" },
        // Slot 3 (optional)
        { id: "slot3_time", name: "Time", description: "Watering time",
            type: "time", required: false, group: "slot3" },
        { id: "slot3_duration", name: "Duration (min)", description: "Duration in minutes",
            type: "number", required: false,
            constraints: { min: 1, max: 120 }, group: "slot3" },
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
const FR = {
    name: "Arrosage Auto",
    description: "Arrosage programmé avec créneaux horaires et gestion intelligente de la pluie",
    slots: {
        zone: { name: "Zone", description: "Zone d'arrosage" },
        valves: { name: "Vannes d'arrosage", description: "Vannes à piloter" },
        slot1_time: { name: "Heure", description: "Heure d'arrosage" },
        slot1_duration: { name: "Durée (min)", description: "Durée en minutes" },
        slot2_time: { name: "Heure", description: "Heure d'arrosage" },
        slot2_duration: { name: "Durée (min)", description: "Durée en minutes" },
        slot3_time: { name: "Heure", description: "Heure d'arrosage" },
        slot3_duration: { name: "Durée (min)", description: "Durée en minutes" },
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
                // Open all valves simultaneously
                ctx.state.set("status", "watering");
                ctx.state.set("currentSlot", slot.time);
                ctx.state.set("lastSkipReason", null);
                const summary = [];
                for (const vId of valveIds) {
                    const name = valveName(vId);
                    try {
                        await ctx.equipmentManager.executeOrder(vId, "state", {
                            state: "ON",
                            on_time: durMin * 60,
                        });
                        ctx.log(`${name} ouverte pour ${durMin} min`);
                        summary.push(`${name} ${durMin}min`);
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        ctx.log(`Erreur ouverture ${name}: ${msg}`, "error");
                    }
                }
                ctx.log(`Arrosage créneau ${slot.time} — ${summary.join(", ")}`);
                // Schedule completion
                if (completionTimer)
                    clearTimeout(completionTimer);
                completionTimer = setTimeout(() => {
                    ctx.state.set("status", "idle");
                    ctx.state.set("currentSlot", null);
                    updateNextSlot();
                    ctx.log(`Arrosage créneau ${slot.time} terminé`);
                    completionTimer = null;
                }, durMin * 60 * 1000);
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
                const delay = msUntilTime(slot.time);
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
            ctx.state.set("status", "idle");
            ctx.state.set("currentSlot", null);
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
                    ctx.state.set("status", "idle");
                    ctx.state.set("currentSlot", null);
                    ctx.log("Recette arrêtée");
                },
            };
        },
    };
}
