// Boot device probe — passive observer that measures frame time during the
// menu's first ~1s of rendering, derives a device-specific render-scale
// cap, persists it in localStorage. NO dedicated scene, NO loading screen
// extra: the menu is already a representative 3D workload the user sees
// anyway, so the probe is fully transparent UX-wise.
//
// First stage of the layered perf architecture. Cap = upper bound of the tier
// resolved at boot (later stages consume the persisted tierCap as an auto-detect
// input). The per-level warmup probe refines the scale applied at the
// next mount (ratchet down-only) — no runtime DRS.

import type { Scene } from '@babylonjs/core';
import { engineHandles } from './engineHandles';
import { reportEngineError } from './engineReporting';
import {
    PROBE_TIER_THRESHOLD_HI,
    PROBE_TIER_THRESHOLD_MID,
    BOOT_PROBE_PESSIMISM,
    PROBE_SKIP_FRAMES,
    BOOT_PROBE_MEASURE_FRAMES,
} from '../../domain/constants';

// ── Configuration ─────────────────────────────────────────────────────────────
// Call configureDeviceProbe at app-boot before first getDeviceCap.

interface DeviceProbeConfig {
    /** Storage key prefix used as fallback before kvStorage is ready. */
    storagePrefix: string;
    /** App version string. Re-probe when stored version mismatches. */
    appVersion: string;
}

let _cfg: DeviceProbeConfig = { storagePrefix: '', appVersion: '0.0.0' };

export function configureDeviceProbe(opts: DeviceProbeConfig): void {
    _cfg = opts;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Agnostic snapshot of the device-state signals that drive reprobe decisions. */
export interface DeviceProbeSignalSnapshot {
    thermalCriticalActive: boolean;
    thermalState: string;
    batterySaveActive: boolean;
    batteryPctPerHour: number | null;
    batteryLevel: number | null;
    batteryCharging: boolean | null;
}

/** Port: app-side implements this to feed thermal/battery signals into DeviceProbe.
 *  Keeps DeviceProbe free of store imports. */
export interface DeviceProbeSignalSource {
    getSnapshot(): DeviceProbeSignalSnapshot;
    subscribe(cb: (state: DeviceProbeSignalSnapshot) => void): () => void;
}

export type DeviceTierCap = 'hi' | 'mid' | 'lo';

export interface DeviceCap {
    /** Max scale axis sustainable at target fps (sqrt of pixel area ratio). */
    scaleCap: number;
    /** Tier classification derived from scaleCap. */
    tierCap: DeviceTierCap;
    /** App version when measured. Re-probe on mismatch. */
    version: string;
    /** Unix ms of measurement. */
    timestamp: number;
    /** Display refresh probed at boot (60/120/etc). */
    displayHz: number;
    /** Target fps used during probe (= min(engine.maxFPS, displayHz)). */
    targetFps: number;
}

// ── Storage helpers ───────────────────────────────────────────────────────────
// Key without brand prefix — engineHandles.kvStorage adds it via makeLocalStorageKVS(prefix).
// Before scene-ready (kvStorage not yet set) falls back to a prefixed key directly.

const STORAGE_KEY = 'device-cap';
function kvGet(key: string): string | null {
    const kv = engineHandles.kvStorage;
    if (kv) return kv.get(key);
    if (!_cfg.storagePrefix) return null;
    try { return localStorage.getItem(`${_cfg.storagePrefix}-${key}`); } catch { return null; }
}
function kvSet(key: string, value: string): void {
    const kv = engineHandles.kvStorage;
    if (kv) { kv.set(key, value); return; }
    if (!_cfg.storagePrefix) return;
    try { localStorage.setItem(`${_cfg.storagePrefix}-${key}`, value); } catch { /* quota */ }
}
function kvRemove(key: string): void {
    const kv = engineHandles.kvStorage;
    if (kv) { kv.remove(key); return; }
    if (!_cfg.storagePrefix) return;
    try { localStorage.removeItem(`${_cfg.storagePrefix}-${key}`); } catch { /* restricted */ }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Read cached device cap. Returns null if missing OR version mismatch. */
export function getDeviceCap(): DeviceCap | null {
    try {
        const raw = kvGet(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as DeviceCap;
        if (parsed.version !== _cfg.appVersion) return null;
        return parsed;
    } catch (err) {
        // Corrupt persisted cap (truncated/garbled JSON) — unexpected, not an
        // environmental localStorage denial. Report it (next boot re-probes).
        reportEngineError('deviceProbe', err, { op: 'getDeviceCap.parse' });
        return null;
    }
}

/** Clear cached cap → next boot will re-probe. Call on thermal critical /
 *  battery save toggle / user-triggered "reset perf" setting. */
export function invalidateDeviceCap(): void {
    kvRemove(STORAGE_KEY);
}

/** Read cap or fall back to 1.0 (= no cap). Used by adaptive runtime so
 *  callers don't have to nullcheck. */
export function getDeviceScaleCap(): number {
    return getDeviceCap()?.scaleCap ?? 1.0;
}

export function getDeviceTierCap(): DeviceTierCap {
    return getDeviceCap()?.tierCap ?? 'hi';
}

function saveDeviceCap(cap: DeviceCap): void {
    kvSet(STORAGE_KEY, JSON.stringify(cap));
}

function scaleToTier(scale: number): DeviceTierCap {
    if (scale >= PROBE_TIER_THRESHOLD_HI) return 'hi';
    if (scale >= PROBE_TIER_THRESHOLD_MID) return 'mid';
    return 'lo';
}

// ── Reprobe triggers ──────────────────────────────────────────────────────────
// See ../../../wiki/quality-and-device-profiling.md.

const REPROBE_COOLDOWN_MS = 30_000;
const BATTERY_DRAIN_THRESHOLD_PCT_H = 30;  // heavy drain (game-loaded baseline ~20-25%/h)
const BATTERY_LOW_LEVEL = 0.15;
const THERMAL_FAIR_SUSTAINED_MS = 10_000;  // ignore brief 'fair' blips — avoid flap

/** Attach subscribers: invalidate cached cap when thermal/battery signals
 *  indicate the prior probe is no longer trustworthy.
 *  Triggers: thermalCriticalActive rising edge, thermal=fair sustained >10s,
 *  batterySaveActive rising edge, batteryPctPerHour > 30, batteryLevel < 0.15.
 *  Cooldown 30s prevents ping-pong. Returns a disposer. Idempotent. */
let _reprobeAttached = false;
export function attachReprobeTriggers(signals: DeviceProbeSignalSource): () => void {
    if (_reprobeAttached) return () => {};
    _reprobeAttached = true;
    const snap0 = signals.getSnapshot();
    let prevThermal = snap0.thermalCriticalActive;
    let prevBattery = snap0.batterySaveActive;
    let thermalFairSinceMs: number | null = null;
    let thermalFairFired = false;
    let lastReprobeMs = 0;
    const fireReprobe = (reason: string): void => {
        const now = performance.now();
        if (now - lastReprobeMs < REPROBE_COOLDOWN_MS) return;
        lastReprobeMs = now;
        invalidateDeviceCap();
        // eslint-disable-next-line no-console
        console.warn(`[deviceProbe] re-probe trigger ${reason} → cache invalidated`);
    };
    const unsub = signals.subscribe((state) => {
        const now = performance.now();
        const thermalRising = !prevThermal && state.thermalCriticalActive;
        const batterySaveRising = !prevBattery && state.batterySaveActive;
        const heavyDrain = state.batteryPctPerHour !== null
            && state.batteryPctPerHour > BATTERY_DRAIN_THRESHOLD_PCT_H
            && !state.batteryCharging;
        const lowBattery = state.batteryLevel !== null
            && state.batteryLevel < BATTERY_LOW_LEVEL
            && !state.batteryCharging;
        if (state.thermalState === 'fair') {
            thermalFairSinceMs ??= now;
        } else {
            thermalFairSinceMs = null;
            thermalFairFired = false;
        }
        if (thermalRising) fireReprobe('thermal=critical');
        else if (batterySaveRising) fireReprobe('battery=save');
        else if (heavyDrain) fireReprobe(`drain=${state.batteryPctPerHour?.toFixed(1)}%/h`);
        else if (lowBattery) fireReprobe(`level=${((state.batteryLevel ?? 0) * 100).toFixed(0)}%`);
        prevThermal = state.thermalCriticalActive;
        prevBattery = state.batterySaveActive;
    });
    const fairTickInterval = setInterval(() => {
        if (thermalFairSinceMs === null || thermalFairFired) return;
        const now = performance.now();
        if ((now - thermalFairSinceMs) > THERMAL_FAIR_SUSTAINED_MS) {
            thermalFairFired = true;
            fireReprobe(`thermal=fair sustained ${((now - thermalFairSinceMs) / 1000).toFixed(1)}s`);
        }
    }, THERMAL_FAIR_SUSTAINED_MS / 2);
    return () => {
        unsub();
        clearInterval(fairTickInterval);
        _reprobeAttached = false;
    };
}

/** Update only the learned scaleCap. Preserves other fields from the original probe.
 *  Debounce externally (don't write every frame). */
export function persistLearnedCap(learnedScaleCap: number): void {
    const current = getDeviceCap();
    if (!current) return;
    if (Math.abs(current.scaleCap - learnedScaleCap) < 0.01) return;
    const updated: DeviceCap = {
        ...current,
        scaleCap: learnedScaleCap,
        tierCap: scaleToTier(learnedScaleCap),
    };
    saveDeviceCap(updated);
}

/** Run the probe. No-op if cache already populated for this version.
 *  Attaches to scene.onAfterRenderObservable, measures, detaches, saves.
 *  Returns the derived DeviceCap (cached or freshly probed). */
export async function runDeviceProbe(scene: Scene, displayHzOverride?: number): Promise<DeviceCap> {
    const cached = getDeviceCap();
    if (cached) return cached;

    const engine = scene.getEngine();
    const displayHz = displayHzOverride ?? 60;
    const rawMaxFps = engine.maxFPS;
    const maxFps = typeof rawMaxFps === 'number' && rawMaxFps > 0 && Number.isFinite(rawMaxFps)
        ? rawMaxFps
        : displayHz;
    const targetFps = Math.min(maxFps, displayHz);
    const targetMs = 1000 / targetFps;

    const frameTimes: number[] = [];
    let skipped = 0;
    let prev = performance.now();

    // ⚠️ Il probe si risolve su un evento di RENDER, e il render può fermarsi:
    // it is enough for the user to send the app to the background, or for the
    // render gate to close the loop, while the first frames are being counted.
    // With no deadline the promise NEVER resolves, the observer stays attached,
    // and boot — which awaits it — hangs on a loading screen with no error
    // anywhere. It is the kind of stall that does not reproduce on a development machine and
    // only comes from real devices.
    //
    // The deadline is generous (the frames take ~1s at 60Hz): whatever hits it is
    // a stopped render, not a slow device. On expiry it measures with whatever was
    // collected, and if that is not enough it falls back to the target — i.e. "no
    // cap", which is the prudent default: the per-level probe will refine it
    // anyway.
    const PROBE_DEADLINE_MS = 8_000;

    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            scene.onAfterRenderObservable.remove(obs);
            resolve();
        };
        const timer = setTimeout(() => {
            reportEngineError('deviceProbe', new Error('boot probe timed out'), {
                op: 'runDeviceProbe.deadline',
                framesCollected: frameTimes.length,
                framesWanted: BOOT_PROBE_MEASURE_FRAMES,
            });
            finish();
        }, PROBE_DEADLINE_MS);
        const obs = scene.onAfterRenderObservable.add(() => {
            const now = performance.now();
            const dt = now - prev;
            prev = now;
            if (skipped < PROBE_SKIP_FRAMES) {
                skipped += 1;
                return;
            }
            frameTimes.push(dt);
            if (frameTimes.length >= BOOT_PROBE_MEASURE_FRAMES) finish();
        });
    });

    // Un campione scarso è peggio di nessun campione: la mediana di 3 frame
    // collected while the app went to the background measures the stall, not the
    // device, and would be PERSISTED as a cap for the whole version. Below a third
    // of the expected frames it falls back to the target (= no cap) and leaves the
    // verdict to the per-level probe, which measures the real load.
    const MIN_USABLE_FRAMES = Math.ceil(BOOT_PROBE_MEASURE_FRAMES / 3);
    const usable = frameTimes.length >= MIN_USABLE_FRAMES;
    const sorted = usable ? [...frameTimes].sort((a, b) => a - b) : [];
    const medianMs = sorted[Math.floor(sorted.length / 2)] ?? targetMs;
    const ratio = (targetMs / medianMs) * BOOT_PROBE_PESSIMISM;
    const scaleCap = ratio >= 1 ? 1.0 : Math.max(0.3, Math.sqrt(ratio));
    const tierCap = scaleToTier(scaleCap);

    const cap: DeviceCap = {
        scaleCap,
        tierCap,
        version: _cfg.appVersion,
        timestamp: Date.now(),
        displayHz,
        targetFps,
    };
    // ONLY a valid measurement is persisted. A cap written from an insufficient
    // sample would be indistinguishable from a good one at the next boot
    // (`getDeviceCap` looks at the version, not at the sample's quality) and would
    // stay nailed there for the whole version, never retrying. By writing nothing,
    // the next start re-measures.
    if (usable) saveDeviceCap(cap);
    // eslint-disable-next-line no-console
    console.warn(`[deviceProbe] frames=${frameTimes.length} medianMs=${medianMs.toFixed(2)} targetMs=${targetMs.toFixed(2)} scaleCap=${scaleCap.toFixed(3)} tier=${tierCap}${usable ? '' : ' (insufficient sample — not persisted)'}`);
    return cap;
}
