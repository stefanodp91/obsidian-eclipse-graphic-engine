// Singleton controller for transient MotionBlur bursts (e.g. jump/turbo).
// The owner creates the MotionBlurPostProcess and registers it here; gameplay
// calls triggerMotionBlur() on the rising edge of a fast action.
// motionStrength defaults to 0 (invisible) — the velocity prepass still runs but
// produces an unchanged output, so the feature should be gated to tiers that can
// afford the prepass cost (~0.5ms).

import type { MotionBlurPostProcess } from '@babylonjs/core/PostProcesses/motionBlurPostProcess';

const BLUR_STRENGTH = 1.8;
const DECAY_MS      = 200;

let process: MotionBlurPostProcess | null = null;
let decayTimer: ReturnType<typeof setTimeout> | null = null;

export function registerMotionBlurProcess(mb: MotionBlurPostProcess): void {
    process = mb;
    process.motionStrength = 0;
}

export function unregisterMotionBlurProcess(): void {
    if (decayTimer !== null) {
        clearTimeout(decayTimer);
        decayTimer = null;
    }
    process = null;
}

export function triggerMotionBlur(durationMs: number = DECAY_MS): void {
    if (!process) return;
    process.motionStrength = BLUR_STRENGTH;
    if (decayTimer !== null) clearTimeout(decayTimer);
    decayTimer = setTimeout(() => {
        if (process) process.motionStrength = 0;
        decayTimer = null;
    }, durationMs);
}
