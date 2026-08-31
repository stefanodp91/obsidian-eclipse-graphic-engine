// Dev-only pool telemetry. Logs pool.stats every TELEMETRY_INTERVAL_MS so
// we can spot prewarm sizes that are too small (peak > alive) or too large
// (peak << alive). No-op when isDev=false (initEngine not called with isDev).

import type { Scene } from '@babylonjs/core';
import { getPoolStats } from './MeshPool';
import { getEngineIsDev } from '../../domain/engineConfig';

const TELEMETRY_INTERVAL_MS = 10_000;

let intervalId: number | null = null;

export function startPoolTelemetry(scene: Scene): void {
    if (!getEngineIsDev()) return;
    if (intervalId !== null) return;
    intervalId = window.setInterval(() => {
        const stats = getPoolStats(scene);
        const rows = Object.entries(stats)
            .map(([key, s]) => `${key}: alive=${s.alive} free=${s.free} peak=${s.peak}`)
            .join(' | ');
        // eslint-disable-next-line no-console
        console.log('[meshpool]', rows);
    }, TELEMETRY_INTERVAL_MS);
}

export function stopPoolTelemetry(): void {
    if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
    }
}
