// Engine-wide runtime config. Call initEngine() once at app startup
// before any engine module is used.

export interface EngineRuntimeConfig {
    isDev: boolean;
}

/** Per-engine runtime flags. The default instance preserves the current API
 * while new consumers can own an isolated configuration. */
export function createEngineRuntimeConfig(): EngineRuntimeConfig {
    return { isDev: false };
}

const defaultRuntimeConfig = createEngineRuntimeConfig();

export interface InitEngineOptions {
    isDev: boolean;
}

/** Call once at app startup (before first engine module use). Sets
 *  cross-cutting runtime flags (dev assertions, telemetry). */
export function initEngine(opts: InitEngineOptions, config: EngineRuntimeConfig = defaultRuntimeConfig): void {
    config.isDev = opts.isDev;
}

/** Read by engine modules for dev-only assertions. */
export function getEngineIsDev(config: EngineRuntimeConfig = defaultRuntimeConfig): boolean {
    return config.isDev;
}
