// SRP use case: suppress known cosmetic log bursts at scene-ready.
// Patches Babylon Logger.Warn + console.warn/error + WebGPU uncaptured-error
// so swap-chain-resize spam and instanced-mesh material warnings never reach
// DevTools. Logger must be patched because Babylon captures the original
// console.warn at module load — a console override alone won't intercept it.

import type { AbstractEngine } from '@babylonjs/core';
import { Logger } from '@babylonjs/core';

const SWAP_CHAIN_NOISE  = 'WebgpuSwapChainTexture';
const INSTANCE_MAT_NOISE = 'Setting material on an instanced mesh';

// ⚠️ Questo modulo scrive su oggetti GLOBALI che non gli appartengono
// (`console`, `Logger` di Babylon). Tre proprietà lo rendono accettabile per una
// libreria, e vanno mantenute tutte e tre:
//
//  1. IDEMPOTENZA — due chiamate non devono impilare due filtri. Prima non
//     c'era guardia: una seconda chiamata (rimonto della scena, hot quality-change,
//     StrictMode) avvolgeva il wrapper precedente, e ogni ciclo aggiungeva uno
//     strato. Il costo cresce a ogni giro e i pattern si sommano per sempre.
//  2. REVERSIBILITÀ — chi accende deve poter spegnere. Senza, un motore disposto
//     lascia la `console` dell'applicazione ospite dirottata a vita, verso
//     chiusure che tengono in piedi engine e pattern morti.
//  3. ADDITIVITÀ dei pattern — chiamate successive con pattern diversi li
//     accumulano nello stesso filtro invece di sostituirlo.
//
// Il filtro applicato a `console.error` resta la parte più invasiva: intercetta
// anche gli errori dell'ospite. È limitato al confronto per sottostringa sul
// primo argomento stringa, e i pattern sono espliciti — nessuna euristica.
interface NoiseState {
    patterns: Set<string>;
    restore: () => void;
}

let state: NoiseState | null = null;

export function suppressLogNoise(engine: AbstractEngine, additionalPatterns: string[] = []): void {
    // Già installato: si aggiungono solo i pattern nuovi al filtro esistente.
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

/** Ripristina `console` e `Logger` allo stato precedente. Da chiamare al teardown
 *  del motore: senza, la console dell'applicazione ospite resta filtrata (e le
 *  chiusure del filtro tengono vivo l'engine) anche dopo il dispose. */
export function restoreLogNoise(): void {
    state?.restore();
    state = null;
}
