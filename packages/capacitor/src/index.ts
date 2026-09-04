// TS facade implementing the engine's `NativeServices` driven port, backed by
// Capacitor plugins (thermal, display-refresh, battery, prefs, wake-lock).
//
// The TS facade is shipped as a built ESM package. Capacitor remains a peer so
// the host supplies one bridge instance and its bundler owns async chunks.
// Plugin imports are plain dynamic imports so a consumer's webpack build bundles them
// into async chunks: a WebView (capacitor:// / file://) cannot resolve a bare
// npm specifier at runtime, so `webpackIgnore` would leave them unresolvable on
// device and silently fall back to web behavior. `@capacitor/core` is aliased.
//
// Native Android/iOS sources ship with this package and are discovered by
// `npx cap sync`; the engine core never imports them.

import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type {
    AsyncKeyValueStorage,
    BatteryStatus,
    NativeServices,
    RefreshInfo,
    RefreshMode,
    ThermalState,
    Unsubscribe,
} from 'obsidian-eclipse-graphic-engine';

// Observability contracts are dependency-free. Firebase implementations live
// on the explicit `/firebase` subpath so importing the native facade never
// forces a web consumer to install or bundle Firebase.
export type { AnalyticsTracker, CrashContext, CrashReporter, PerfTraceHandle, PerfTracer } from './observability/contracts';

const isNativePlatform = (): boolean => {
    try { return Capacitor.isNativePlatform(); } catch { return false; }
};

// Every native failure below is behind a `catch` that falls back to the web
// behavior. The fallback is the right choice — the app must not die because a
// plugin is missing — but until now it was also SILENT, and the two costliest
// outcomes are indistinguishable by eye: `prefs` falling back to localStorage
// means progress is NOT durable (a WebView cache clear wipes it), and
// `readThermalState` falling back to 'nominal' means a disarmed thermal governor.
//
// Same contract as the engine's ErrorSink: a no-op until the host injects
// anything, so the package stays silent and dependency-free by default.
type PluginErrorSink = (domain: string, error: unknown, context?: Record<string, string | number | boolean | null>) => void;

let _errorSink: PluginErrorSink | null = null;

/** Injects (or clears) the host's error sink. To be called once at boot. */
export function setNativeErrorSink(sink: PluginErrorSink | null): void {
    _errorSink = sink;
}

function reportNativeError(domain: string, error: unknown, context?: Record<string, string | number | boolean | null>): void {
    if (!_errorSink) return;
    try { _errorSink(domain, error, context); } catch { /* a broken sink must not destabilize the bridge */ }
}

// ── Custom plugin proxies, resolved once ─────────────────────────────────────
// `registerPlugin` builds a Proxy on every call. The thermal functions below are
// POLLED (the governor queries them at intervals, and so does a perf HUD does too):
// resolving them on every read meant a new Proxy per sample. Memoized here, as
// `getDisplayRefreshPlugin` already did.
interface ThermalStateNativePlugin {
    getState(): Promise<{ state: ThermalState }>;
    getTemperature(): Promise<{ batteryC: number | null }>;
    getThermalHeadroom(opts: { forecastSeconds: number }): Promise<{ headroom: number | null }>;
    getPowerSaveMode(): Promise<{ enabled: boolean }>;
    addListener(event: string, fn: (d: never) => void): Promise<PluginListenerHandle>;
}

let thermalPlugin: ThermalStateNativePlugin | null = null;
function getThermalPlugin(): ThermalStateNativePlugin | null {
    if (!isNativePlatform()) return null;
    if (!thermalPlugin) {
        try { thermalPlugin = registerPlugin<ThermalStateNativePlugin>('ThermalState'); }
        catch (err) { reportNativeError('native.thermal', err, { op: 'registerPlugin' }); return null; }
    }
    return thermalPlugin;
}

/** Subscribes to a thermal plugin event without losing the unsubscribe.
 *
 *  ⚠️ `addListener` is asynchronous and the unsubscribe is synchronous: whoever
 *  unsubscribed BEFORE the registration resolved found `handle` still null, their
 *  call did nothing, and the listener stayed attached forever — still pushing
 *  events into an already unmounted consumer. The `cancelled` flag closes the gap
 *  in both directions: if the cancellation arrives first, the registration itself
 *  removes it as soon as it lands. */
function subscribeThermalEvent<T>(event: string, cb: (data: T) => void): Unsubscribe {
    const plugin = getThermalPlugin();
    if (!plugin) return () => {};
    let cancelled = false;
    let handle: PluginListenerHandle | null = null;
    void (async () => {
        try {
            const h = await plugin.addListener(event, ((d: T) => cb(d)) as (d: never) => void);
            if (cancelled) { void h.remove(); return; }
            handle = h;
        } catch (err) {
            reportNativeError('native.thermal', err, { op: `addListener:${event}` });
        }
    })();
    return () => {
        cancelled = true;
        void handle?.remove();
        handle = null;
    };
}

/** Live (not memoized) — Capacitor bridge readiness can lag module load on
 *  Android 14+ with the modern message-channel bridge. */
const isAndroidNativeNow = (): boolean => {
    try { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'; } catch { return false; }
};

// ── Battery (Capacitor Device → web Battery API fallback) ────────────────────
interface WebBatteryManager { level: number; charging: boolean; }
interface NavigatorWithBattery extends Navigator { getBattery?: () => Promise<WebBatteryManager> }
let webBatteryMgr: WebBatteryManager | null = null;

export async function readBatteryStatus(): Promise<BatteryStatus | null> {
    if (isNativePlatform()) {
        try {
            const { Device } = await import('@capacitor/device');
            const info = await Device.getBatteryInfo();
            if (typeof info.batteryLevel === 'number') {
                return { level: info.batteryLevel, charging: info.isCharging ?? false };
            }
        } catch { /* fall through to web */ }
    }
    if (webBatteryMgr) return { level: webBatteryMgr.level, charging: webBatteryMgr.charging };
    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery === 'function') {
        try {
            webBatteryMgr = await nav.getBattery();
            return { level: webBatteryMgr.level, charging: webBatteryMgr.charging };
        } catch { /* unsupported */ }
    }
    return null;
}

// ── Preferences (Capacitor Preferences → localStorage fallback) ──────────────
// ⚠️ On NATIVE the localStorage fallback is not equivalent: Preferences are
// durable native KV, localStorage lives in the WebView and disappears with a
// cache clear. A silent failure here makes the player's progress NOT durable
// without anything, on screen or in the console, saying so. The fallback stays
// (better to save somewhere than not to save), but it stops being silent: once
// per operation, so that a recurring error does not turn into a telemetry
// storm.
const prefsFallbackReported = new Set<string>();

function reportPrefsFallback(op: string, err: unknown): void {
    if (!isNativePlatform()) return;   // su web localStorage È il backing previsto
    if (prefsFallbackReported.has(op)) return;
    prefsFallbackReported.add(op);
    reportNativeError('native.prefs', err, { op, fallback: 'localStorage', durable: false });
}

export const prefs: AsyncKeyValueStorage = {
    async get(key) {
        if (isNativePlatform()) {
            try {
                const { Preferences } = await import('@capacitor/preferences');
                const { value } = await Preferences.get({ key });
                return value;
            } catch (err) { reportPrefsFallback('get', err); }
        }
        try { return localStorage.getItem(key); } catch { return null; }
    },
    async set(key, value) {
        if (isNativePlatform()) {
            try {
                const { Preferences } = await import('@capacitor/preferences');
                await Preferences.set({ key, value });
                return;
            } catch (err) { reportPrefsFallback('set', err); }
        }
        try { localStorage.setItem(key, value); } catch (err) { reportNativeError('native.prefs', err, { op: 'set.localStorage' }); }
    },
    async remove(key) {
        if (isNativePlatform()) {
            try {
                const { Preferences } = await import('@capacitor/preferences');
                await Preferences.remove({ key });
                return;
            } catch (err) { reportPrefsFallback('remove', err); }
        }
        try { localStorage.removeItem(key); } catch { /* ignore */ }
    },
};

// ── Wake lock (Capacitor KeepAwake → navigator.wakeLock fallback) ────────────
let wakeLockSentinel: WakeLockSentinel | null = null;

export async function requestWakeLock(): Promise<void> {
    if (isNativePlatform()) {
        try {
            const { KeepAwake } = await import('@capacitor-community/keep-awake');
            await KeepAwake.keepAwake();
            return;
        } catch { /* plugin not installed */ }
    }
    try {
        if ('wakeLock' in navigator) {
            wakeLockSentinel = await (navigator as Navigator & { wakeLock: { request: (type: string) => Promise<WakeLockSentinel> } }).wakeLock.request('screen');
        }
    } catch { /* permission denied or unavailable */ }
}

export async function releaseWakeLock(): Promise<void> {
    if (isNativePlatform()) {
        try {
            const { KeepAwake } = await import('@capacitor-community/keep-awake');
            await KeepAwake.allowSleep();
            return;
        } catch { /* plugin not installed */ }
    }
    try { await wakeLockSentinel?.release(); wakeLockSentinel = null; } catch { /* ignore */ }
}

// ── Thermal state (custom ThermalState plugin: Android PowerManager / iOS ProcessInfo) ──
export async function readThermalState(): Promise<ThermalState> {
    const plugin = getThermalPlugin();
    if (plugin) {
        try {
            const { state } = await plugin.getState();
            return state;
        } catch (err) {
            // A silent fallback to 'nominal' reads as "cold device" and disarms
            // the thermal governor: it is exactly the case where silence costs.
            reportNativeError('native.thermal', err, { op: 'getState' });
        }
    }
    return 'nominal';
}

export function onThermalStateChange(cb: (state: ThermalState) => void): Unsubscribe {
    return subscribeThermalEvent<{ state: ThermalState }>('thermalStateChange', (d) => cb(d.state));
}

// ── Device temperature (same ThermalState plugin) ─────────────────────────────
// Android: BATTERY temperature in °C (sticky ACTION_BATTERY_CHANGED — the only
// temperature Android exposes to a non-privileged app; CPU/skin require
// device-owner privileges). iOS: platform-honest → null (no public API; the iOS
// thermal signal remains readThermalState). Web: null.
export async function readDeviceTemperature(): Promise<number | null> {
    const plugin = getThermalPlugin();
    if (plugin) {
        try {
            const { batteryC } = await plugin.getTemperature();
            return typeof batteryC === 'number' ? batteryC : null;
        } catch (err) {
            reportNativeError('native.thermal', err, { op: 'getTemperature' });
        }
    }
    return null;
}

// ── Thermal headroom (same ThermalState plugin) ───────────────────────────────
// Android API 30+: 0..1 = fraction of the thermal budget consumed (1.0 = severe
// throttling), optionally FORECAST `forecastSeconds` into the future. It is the
// only continuous, anticipatory thermal signal: `readThermalState` is stepped and
// arrives late (measured on a Galaxy A25: MODERATE after 16 min of play, SEVERE after 22).
//
// null = "I don't know", NEVER 0 — API < 30, iOS (no Apple equivalent), web, or
// NaN returned by the OS when queried too often (contract: no more than once
// every ~10s). A zero would be read as "cold device".
/** Minimum interval between two headroom queries, from the Android contract
 *  (`PowerManager.getThermalHeadroom`): below ~10s the OS returns NaN. A little
 *  margin above the documented minimum, because the window is measured by the OS
 *  and not by our clock. */
const HEADROOM_MIN_INTERVAL_MS = 11_000;

let headroomLast: { at: number; value: number | null; forecast: number } | null = null;

export async function readThermalHeadroom(forecastSeconds = 0): Promise<number | null> {
    // ⚠️ The rate limit is not an optimization: without it, a caller that polls
    // too frequently gets NaN from the OS, which becomes null here — i.e. "signal
    // unavailable". The governor reads that as "I don't know" and disarms itself,
    // and the symptom (no thermal mitigation) looks nothing like the cause
    // (polling too tightly). Returning the LAST good value inside the window is
    // more honest than returning a self-inflicted null.
    const now = Date.now();
    if (headroomLast?.forecast === forecastSeconds
        && now - headroomLast.at < HEADROOM_MIN_INTERVAL_MS) {
        return headroomLast.value;
    }
    const plugin = getThermalPlugin();
    if (!plugin) return null;
    try {
        const { headroom } = await plugin.getThermalHeadroom({ forecastSeconds });
        const value = typeof headroom === 'number' && Number.isFinite(headroom) ? headroom : null;
        headroomLast = { at: now, value, forecast: forecastSeconds };
        return value;
    } catch (err) {
        reportNativeError('native.thermal', err, { op: 'getThermalHeadroom', forecastSeconds });
        return null;
    }
}

// ── Power-save / low-power mode (same ThermalState plugin: Android Battery Saver
//    via PowerManager.isPowerSaveMode / iOS Low Power Mode via ProcessInfo) ──────
export async function readPowerSaveMode(): Promise<boolean> {
    const plugin = getThermalPlugin();
    if (plugin) {
        try {
            const { enabled } = await plugin.getPowerSaveMode();
            return enabled;
        } catch (err) {
            reportNativeError('native.thermal', err, { op: 'getPowerSaveMode' });
        }
    }
    return false;
}

export function onPowerSaveModeChange(cb: (enabled: boolean) => void): Unsubscribe {
    return subscribeThermalEvent<{ enabled: boolean }>('powerSaveModeChange', (d) => cb(d.enabled));
}

// ── Display refresh (custom DisplayRefresh plugin, Android-only today) ────────
type DisplayRefreshPlugin = {
    setRefreshMode(opts: { mode: RefreshMode }): Promise<{ mode: string }>;
    getRefreshInfo(): Promise<RefreshInfo>;
};
let displayRefreshPlugin: DisplayRefreshPlugin | null = null;
function getDisplayRefreshPlugin(): DisplayRefreshPlugin | null {
    if (!isAndroidNativeNow()) return null;
    if (!displayRefreshPlugin) {
        try { displayRefreshPlugin = registerPlugin<DisplayRefreshPlugin>('DisplayRefresh'); }
        catch { displayRefreshPlugin = null; }
    }
    return displayRefreshPlugin;
}

export async function setRefreshMode(mode: RefreshMode): Promise<boolean> {
    const plugin = getDisplayRefreshPlugin();
    if (!plugin) return false;
    try { await plugin.setRefreshMode({ mode }); return true; } catch { return false; }
}

export async function getRefreshInfo(): Promise<RefreshInfo | null> {
    const plugin = getDisplayRefreshPlugin();
    if (!plugin) return null;
    try { return await plugin.getRefreshInfo(); } catch { return null; }
}

/** Compose the engine's NativeServices port from the Capacitor-backed functions
 *  above. The game injects this into the engine (engineHandles.nativeServices). */
export function createCapacitorNativeServices(): NativeServices {
    return {
        get isNative() { return isNativePlatform(); },
        get isAndroid() { return isAndroidNativeNow(); },
        readBattery: readBatteryStatus,
        setRefreshMode,
        getRefreshInfo,
        readThermalState,
        onThermalStateChange,
        readThermalHeadroom,
        requestWakeLock,
        releaseWakeLock,
        prefs,
    };
}
