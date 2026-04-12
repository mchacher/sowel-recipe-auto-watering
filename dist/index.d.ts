/**
 * Sowel Recipe: Auto Watering
 *
 * Scheduled irrigation with up to 3 time slots, rain-aware skip logic.
 * Uses z2m's "on with timed off" pattern ({state:"ON",on_time:N}).
 *
 * All slots use standard core types (time, duration, equipment, number,
 * boolean) — no custom slot types needed.
 */
interface RecipeSlotDef {
    id: string;
    name: string;
    description: string;
    type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key";
    required: boolean;
    list?: boolean;
    defaultValue?: unknown;
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
export declare function createRecipe(): RecipeDefinition;
export {};
