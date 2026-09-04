// SRP use case: suppress known cosmetic log bursts at scene-ready.
// Patches Babylon Logger.Warn + console.warn/error + WebGPU uncaptured-error
// so swap-chain-resize spam and instanced-mesh material warnings never reach
// DevTools. Logger must be patched because Babylon captures the original
// console.warn at module load — a console override alone won't intercept it.

import type { AbstractEngine } from '@babylonjs/core';
import { Logger } from '@babylonjs/core';

const SWAP_CHAIN_NOISE  = 'WebgpuSwapChainTexture';
const INSTANCE_MAT_NOISE = 'Setting material on an instanced mesh';

// ⚠️ This module writes to GLOBAL objects that do not belong to it (`console`,
// Babylon's `Logger`). Three properties make that acceptable for a library, and
// all three have to be maintained:
//
//  1. IDEMPOTENCE — two calls must not stack two filters. There used to be no
//     guard: a second call (scene remount, hot quality change, StrictMode)
//     wrapped the previous wrapper, and every cycle added a layer. The cost grows
//     with each round and the patterns accumulate forever.
//  2. REVERSIBILITY — whoever switches it on has to be able to switch it off.
//     Without that, a disposed engine leaves the host application's console
//     filtered forever, and the filter's closures keep dead engines and patterns
//     alive.
//  3. ADDITIVITY of the patterns — subsequent calls with different patterns
//     accumulate them in the same filter instead of replacing it.
//
// The filter applied to `console.error` remains the most invasive part: it
// intercepts the host's errors too. It is limited to a substring match on the
// first string argument, and the patterns are explicit — no heuristics.
interface NoiseState {
    patterns: Set<string>;
    restore: () => void;
}

let state: NoiseState | null = null;

export function suppressLogNoise(engine: AbstractEngine, additionalPatterns: string[] = []): void {
    // Already installed: only the new patterns are added to the existing filter.
    if (state) {
        for (const p of additionalPatterns) state.patterns.add(p);
        return;
    }

    const patterns = new Set<string>([SWAP_CHAIN_NOISE, INSTANCE_MAT_NOISE, ...additionalPatterns]);
    const isNoisy = (text: string): boolean => {
        for (const p of patterns) if (text.includes(p)) return true;
        return false;
    };

    const origLoggerWarn = Logger.Warn;
    Logger.Warn = (message, limit) => {
        let text: string;
        if (typeof message === 'string') text = message;
        else if (Array.isArray(message)) text = message.join(' ');
        else text = String(message);
        if (isNoisy(text)) return;
        origLoggerWarn(message, limit);
    };

    // eslint-disable-next-line no-console
    const origWarn = console.warn;
    // eslint-disable-next-line no-console
    const origError = console.error;

    const filterFn = (orig: (...args: unknown[]) => void) =>
        (...args: unknown[]) => {
            const first = args[0];
            if (typeof first === 'string' && isNoisy(first)) return;
            orig(...args);
        };
    // eslint-disable-next-line no-console
    console.warn  = filterFn(origWarn.bind(console));
    // eslint-disable-next-line no-console
    console.error = filterFn(origError.bind(console));

    const webgpuDevice = (engine as unknown as { _device?: {
        addEventListener?: (t: string, fn: (e: Event) => void) => void;
        removeEventListener?: (t: string, fn: (e: Event) => void) => void;
    } })._device;
    const onUncaptured = (e: Event): void => {
        const msg = (e as { error?: { message?: string } }).error?.message ?? '';
        if (msg.includes(SWAP_CHAIN_NOISE)) {
            e.stopImmediatePropagation?.();
        }
    };
    if (webgpuDevice?.addEventListener) {
        webgpuDevice.addEventListener('uncapturederror', onUncaptured);
    }

    state = {
        patterns,
        restore: () => {
            Logger.Warn = origLoggerWarn;
            // eslint-disable-next-line no-console
            console.warn = origWarn;
            // eslint-disable-next-line no-console
            console.error = origError;
            webgpuDevice?.removeEventListener?.('uncapturederror', onUncaptured);
        },
    };
}

/** Restores `console` and `Logger` to their previous state. To be called at
 *  engine teardown: without it, the host application's console stays filtered
 *  (and the filter's closures keep the engine alive) even after the dispose. */
export function restoreLogNoise(): void {
    state?.restore();
    state = null;
}
