/**
 * Sowel Recipe: Auto Watering
 *
 * Scheduled irrigation with up to 3 time slots, rain-aware skip logic.
 * Uses z2m's "on with timed off" pattern ({state:"ON",on_time:N}).
 *
 * Each slot has an optional per-weekday filter (a `select` + `list` slot).
 * No day selected = every day, so pre-1.2.0 instances behave exactly as before.
 */
interface RecipeSlotDef {
    id: string;
    name: string;
    description: string;
    type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key" | "select";
    required: boolean;
    list?: boolean;
    defaultValue?: unknown;
    options?: {
        value: string;
        label: string;
    }[];
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
    createInstance(params: Record<string, unknown>, ctx: RecipeContext): RecipeInstanceHandle;
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
    orderBindings: {
        alias: string;
        [key: string]: unknown;
    }[];
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
    executeOrder(equipmentId: string, alias: string, value: unknown): Promise<{
        success: boolean;
        error?: string;
    }>;
}
interface RecipeContext {
    eventBus: {
        onType(type: string, handler: (event: unknown) => void): () => void;
    };
    equipmentManager: EquipmentManager;
    zoneManager: {
        getById(id: string): unknown | null;
    };
    logger: {
        info(obj: Record<string, unknown>, msg: string): void;
        warn(obj: Record<string, unknown>, msg: string): void;
        error(obj: Record<string, unknown>, msg: string): void;
        debug(obj: Record<string, unknown>, msg: string): void;
    };
    state: RecipeStateStore;
    log: (message: string, level?: "info" | "warn" | "error") => void;
    helpers: {
        parseDuration(value: unknown): number;
    };
}
interface TimeSlot {
    time: string;
    durationMin: number;
    days: Set<number>;
}
/** Options for the per-slot weekday `select` (English fallback labels;
 *  localized labels come from the recipe i18n `options` map). */
export declare const WEEKDAY_OPTIONS: {
    value: string;
    label: string;
}[];
/**
 * Parse a weekday parameter (comma string "mon,wed" or an array) into a set of
 * getDay() values. Unknown tokens are ignored. An empty set means "every day".
 */
export declare function parseDays(raw: unknown): Set<number>;
/**
 * ms delay from `now` to the next occurrence of HH:MM on an allowed weekday.
 * `days` empty = every day (reduces to the today-or-tomorrow behavior). Scans up
 * to 8 calendar days so a weekly recurrence is always found. Weekday and hours
 * are evaluated in the process timezone (Sowel sets TZ=Europe/Paris).
 */
export declare function msUntilTime(time: string, days: Set<number>, now?: Date): number;
/** Find the soonest scheduled slot across their weekday filters. */
export declare function findNextSlot(slots: TimeSlot[], now?: Date): TimeSlot | null;
export declare function createRecipe(): RecipeDefinition;
export {};
