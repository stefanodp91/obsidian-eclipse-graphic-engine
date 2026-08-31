// Probe actual rAF cadence to derive the display refresh rate. Engine maxFPS
// can be configured higher than the display can render (e.g. ultra preset sets
// 240 to disable Babylon's throttle), so it's not a reliable HUD ceiling.
// Sampling rAF deltas is — vsync paces them to the real refresh rate.
//
// Continuous re-probing: the initial 60-frame probe at boot can land during
// the LTPO transition window (Samsung A25: display starts at 120Hz, the
// preferredRefreshRate=60 hint triggers a transition to 60Hz mid-probe →
// median lands ~19.5ms = 51Hz). Re-probe every PROBE_INTERVAL_MS so the
// HUD reflects the settled refresh rate after boot.

const SAMPLE_COUNT = 60;
const PROBE_INTERVAL_MS = 5000;   // re-probe every 5s
// Stop re-probing once the cadence has settled. The boot probe can land mid
// LTPO transition (A25: 120→60 hint), and attachRefreshPreference caps maxFPS
// after boot, so the first 1-2 reads may differ; once N consecutive probes
// agree the refresh is stable and the perpetual rAF loop is pure battery drain
// (it wakes the main thread at vsync even when the render loop is idled).
const STABLE_PROBES_TO_SETTLE = 3;
const COMMON_REFRESH_HZ: readonly number[] = [60, 75, 90, 120, 144, 165, 240];
const SNAP_TOLERANCE = 8;

let probedHz: number | null = null;
let probing = false;
let probeStartTimer: ReturnType<typeof setTimeout> | null = null;
let lastProbedHz: number | null = null;
let stableProbeCount = 0;

// Highest refresh ever observed (monotonic). The first probe at boot runs
// uncapped (engine.maxFPS=240), so it captures the panel's true max even
// before attachRefreshPreference caps maxFPS to 60 on iOS/web. Later capped
// probes read 60, but this max stays put — that's what "is this device
// high-refresh capable?" needs on platforms without a native query (iOS/web).
let displayMaxHz: number | null = null;
const maxHzListeners = new Set<(hz: number) => void>();

function snapToCommonRefresh(hz: number): number {
    let best = COMMON_REFRESH_HZ[0]!;
    let bestDelta = Math.abs(hz - best);
    for (const candidate of COMMON_REFRESH_HZ) {
        const d = Math.abs(hz - candidate);
        if (d < bestDelta) { best = candidate; bestDelta = d; }
    }
    return bestDelta <= SNAP_TOLERANCE ? best : Math.round(hz);
}

function runOneProbe(): void {
    if (probing) return;
    probing = true;

    const deltas: number[] = [];
    let prev = performance.now();

    const tick = (): void => {
        const now = performance.now();
        const dt = now - prev;
        prev = now;
        if (dt > 0 && dt < 1000) deltas.push(dt);

        if (deltas.length >= SAMPLE_COUNT) {
            const sorted = [...deltas].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)]!;
            const rawHz = 1000 / median;
            probedHz = snapToCommonRefresh(rawHz);
            if (displayMaxHz === null || probedHz > displayMaxHz) {
                displayMaxHz = probedHz;
                for (const cb of maxHzListeners) cb(displayMaxHz);
            }
            probing = false;
            // Settle detection: stop the perpetual re-probe once consecutive
            // reads agree. Until then keep re-probing to ride out the boot/cap
            // transition window.
            if (probedHz === lastProbedHz) stableProbeCount++;
            else { stableProbeCount = 1; lastProbedHz = probedHz; }
            if (stableProbeCount < STABLE_PROBES_TO_SETTLE) {
                probeStartTimer = setTimeout(runOneProbe, PROBE_INTERVAL_MS);
            } else {
                probeStartTimer = null;   // settled — no more rAF wakeups
            }
            return;
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

export function startProbeDisplayRefresh(): void {
    if (probing || probeStartTimer !== null) return;
    runOneProbe();
}

export function getProbedDisplayRefresh(): number | null {
    return probedHz;
}

/** Highest refresh rate ever observed (monotonic). Use for high-refresh
 *  capability detection on iOS/web (Android has a native query). */
export function getDisplayMaxHz(): number | null {
    return displayMaxHz;
}

/** Notify when the observed max refresh increases (fires immediately if a
 *  value is already known). Returns an unsubscribe fn. */
export function onDisplayMaxHz(cb: (hz: number) => void): () => void {
    maxHzListeners.add(cb);
    if (displayMaxHz !== null) cb(displayMaxHz);
    return () => { maxHzListeners.delete(cb); };
}
