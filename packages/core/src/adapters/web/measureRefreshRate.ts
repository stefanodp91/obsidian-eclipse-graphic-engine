// Measures the real display refresh rate via requestAnimationFrame cadence.
//
// The browser exposes no standard screen.refreshRate. RAF firing rate == vsync
// == display refresh (ignoring background / power-save throttle). Samples N
// frames, computes Hz = 1000 / avgDelta, snaps to the nearest common refresh
// to avoid jitter (e.g. 59.94 → 60, 119.88 → 120).
//
// Call ONCE at boot. Result drives engine.maxFPS dynamically — no hardcoded
// 60/120/240 constants.

const SAMPLE_FRAMES   = 60;
const COMMON_REFRESH  = [60, 75, 90, 120, 144, 165, 240, 360];
const SNAP_TOLERANCE  = 0.08;

function snapToCommon(hz: number): number {
    for (const candidate of COMMON_REFRESH) {
        if (Math.abs(hz - candidate) / candidate < SNAP_TOLERANCE) return candidate;
    }
    return Math.round(hz);
}

export function measureRefreshRate(): Promise<number> {
    return new Promise((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        let collected = 0;

        const step = (now: number): void => {
            deltas.push(now - last);
            last = now;
            collected++;
            if (collected < SAMPLE_FRAMES) {
                requestAnimationFrame(step);
                return;
            }
            // Drop first frame (warmup) + extreme outliers (> 3× median).
            deltas.shift();
            deltas.sort((a, b) => a - b);
            const median = deltas[Math.floor(deltas.length / 2)]!;
            const filtered = deltas.filter((d) => d <= median * 3);
            const avg = filtered.reduce((s, d) => s + d, 0) / filtered.length;
            const hz = 1000 / avg;
            resolve(snapToCommon(hz));
        };

        requestAnimationFrame((t) => { last = t; requestAnimationFrame(step); });
    });
}
