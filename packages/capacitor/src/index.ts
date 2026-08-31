// TS facade implementing the engine's `NativeServices` driven port, backed by
// Capacitor plugins (thermal, display-refresh, battery, prefs, wake-lock).
//
// The TS facade is shipped as a built ESM package. Capacitor remains a peer so
// the host supplies one bridge instance and its bundler owns async chunks.
// Plugin imports are plain dynamic imports so the game's webpack bundles them
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

// ── Error sink ───────────────────────────────────────────────────────────────
// Ogni fallimento nativo qui sotto è dietro un `catch` che ricade sul
// comportamento web. Il fallback è la scelta giusta — l'app non deve morire
// perché manca un plugin — ma finora era anche MUTO, e i due esiti più costosi
// sono indistinguibili a occhio: `prefs` che ricade su localStorage significa
// progressi NON durevoli (una pulizia cache della WebView li cancella), e
// `readThermalState` che ricade su 'nominal' significa governor termico disarmato.
//
// Stesso contratto dell'ErrorSink del motore: no-op finché l'host non inietta
// nulla, così il package resta silenzioso e senza dipendenze di default.
type PluginErrorSink = (domain: string, error: unknown, context?: Record<string, string | number | boolean | null>) => void;

let _errorSink: PluginErrorSink | null = null;

/** Inietta (o azzera) il sink di errore dell'host. Da chiamare una volta al boot. */
export function setNativeErrorSink(sink: PluginErrorSink | null): void {
    _errorSink = sink;
}

function reportNativeError(domain: string, error: unknown, context?: Record<string, string | number | boolean | null>): void {
    if (!_errorSink) return;
    try { _errorSink(domain, error, context); } catch { /* un sink rotto non deve destabilizzare il bridge */ }
}

// ── Proxy dei plugin custom, risolti una volta sola ──────────────────────────
// `registerPlugin` costruisce un Proxy a ogni chiamata. Le funzioni termiche
// sotto sono POLLATE (il governor le interroga a intervalli, il PerfHud pure):
// risolverle a ogni lettura significava un Proxy nuovo per campione. Memoizzate
// qui come già faceva `getDisplayRefreshPlugin`.
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

/** Sottoscrive un evento del plugin termico senza perdere l'unsubscribe.
 *
 *  ⚠️ `addListener` è asincrona e l'unsubscribe è sincrono: chi si disiscrive
 *  PRIMA che la registrazione risolva trovava `handle` ancora null, la sua
 *  chiamata non faceva nulla, e il listener restava agganciato per sempre —
 *  continuando a spingere eventi dentro un consumatore già smontato. Il flag
 *  `cancelled` chiude il buco in entrambi i versi: se l'annullamento arriva
 *  prima, è la registrazione stessa a rimuoversi appena atterra. */
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
// ⚠️ Su NATIVO il fallback a localStorage non è equivalente: le Preferences sono
// KV nativo durevole, localStorage vive nella WebView e sparisce con una pulizia
// cache. Un fallimento silenzioso qui rende i progressi del giocatore NON
// durevoli senza che nulla, a schermo o in console, lo dica. Il fallback resta
// (meglio salvare da qualche parte che non salvare), ma smette di essere muto:
// una volta sola per operazione, così un errore ricorrente non diventa una
// tempesta di telemetria.
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
            // Un fallback muto a 'nominal' legge come "device freddo" e disarma
            // il governor termico: è esattamente il caso in cui il silenzio costa.
            reportNativeError('native.thermal', err, { op: 'getState' });
        }
    }
    return 'nominal';
}

export function onThermalStateChange(cb: (state: ThermalState) => void): Unsubscribe {
    return subscribeThermalEvent<{ state: ThermalState }>('thermalStateChange', (d) => cb(d.state));
}

// ── Device temperature (same ThermalState plugin) ─────────────────────────────
// Android: temperatura BATTERIA in °C (sticky ACTION_BATTERY_CHANGED — l'unica
// temperatura che Android espone a un'app non privilegiata; CPU/skin richiedono
// privilegi device-owner). iOS: platform-honest → null (nessuna API pubblica;
// il segnale termico iOS resta readThermalState). Web: null.
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
// Android API 30+: 0..1 = frazione del budget termico consumata (1.0 = throttling
// severo), opzionalmente PREVISTA a `forecastSeconds` nel futuro. È l'unico
// segnale termico continuo e anticipatorio: `readThermalState` è a gradini e
// arriva tardi (misurato su A25: MODERATE dopo 16 min di gioco, SEVERE dopo 22).
//
// null = "non lo so", MAI 0 — API < 30, iOS (nessun equivalente Apple), web,
// oppure NaN restituito dall'OS quando lo si interroga troppo spesso (contratto:
// non più di una volta ogni ~10s). Uno zero verrebbe letto come "device freddo".
/** Intervallo minimo fra due interrogazioni dell'headroom, dal contratto Android
 *  (`PowerManager.getThermalHeadroom`): sotto i ~10s l'OS restituisce NaN. Un po'
 *  di margine sopra il minimo documentato, perché la finestra è misurata dall'OS
 *  e non dal nostro orologio. */
const HEADROOM_MIN_INTERVAL_MS = 11_000;

let headroomLast: { at: number; value: number | null; forecast: number } | null = null;

export async function readThermalHeadroom(forecastSeconds = 0): Promise<number | null> {
    // ⚠️ Il rate-limit non è un'ottimizzazione: senza, un chiamante troppo
    // frequente riceve NaN dall'OS, che qui diventa null — cioè "segnale non
    // disponibile". Il governor lo legge come "non lo so" e si disarma, e il
    // sintomo (nessuna mitigazione termica) non somiglia affatto alla causa
    // (polling troppo fitto). Restituire l'ULTIMO valore buono dentro la
    // finestra è più onesto che restituire un null autoinflitto.
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
