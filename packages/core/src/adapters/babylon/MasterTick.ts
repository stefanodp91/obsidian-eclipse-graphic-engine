// SRP use case: monkey-patch scene.registerBeforeRender / unregisterBeforeRender
// so every caller routes through ONE master Observable callback dispatching a
// flat array iteration instead of Babylon's per-observer bookkeeping.
// Net gain: 80+ Observable hops → 1 per frame (~3-5 ms saved on Pixel 9 Pro WebView).
// Same semantics: callbacks fire in registration order, errors caught per-callback.

import type { Scene } from '@babylonjs/core';
import { reportEngineError } from './engineReporting';

export interface MasterTickOpts {
    /** Called after each registered callback fires with its label and elapsed ms.
     *  When provided, callback names are inferred via stack trace. */
    onCallbackTick?(name: string, dtMs: number): void;
    /** Called once per frame after all callbacks have fired. */
    onFrameEnd?(): void;
}

export function installMasterTick(scene: Scene, opts?: MasterTickOpts): void {
    interface NamedCb { fn: () => void; name: string }
    const callbacks: NamedCb[] = [];
    let masterAttached = false;
    const instrumented = Boolean(opts?.onCallbackTick);

    const inferName = (fn: () => void): string => {
        if (fn.name) return fn.name;
        try {
            const stack = new Error('master-tick name probe').stack ?? '';
            const lines = stack.split('\n').slice(2, 7);
            for (const l of lines) {
                const name = /at\s+([A-Za-z_$][\w$.]*)/.exec(l)?.[1];
                if (name && !/^(Object|Module|HTMLDocument|attachMaster)/.test(name)) {
                    return name;
                }
            }
        } catch { /* ignore */ }
        return 'anon';
    };

    // ⚠️ Un callback che lancia lo fa a OGNI FRAME, non una volta.
    //
    // La versione precedente rispondeva con `console.error` incondizionato: 60
    // stack trace al secondo su una WebView Android sono una voce di costo reale
    // nel frame — la mitigazione dell'errore diventava essa stessa un problema di
    // performance, proprio mentre qualcosa era già rotto. E non arrivando a
    // nessun sink, l'errore non compariva in telemetria: restava visibile solo a
    // chi avesse per caso un cavo attaccato.
    //
    // Ora: si riporta la PRIMA occorrenza per callback (quella con l'informazione
    // diagnostica), poi si smette. Il conteggio viaggia col report successivo, così
    // "è successo una volta" e "succede da mezz'ora" restano distinguibili.
    const REPORT_EVERY = 600;   // ~10 s a 60 fps
    const failures = new Map<string, number>();

    const onCallbackError = (name: string, e: unknown): void => {
        const seen = (failures.get(name) ?? 0) + 1;
        failures.set(name, seen);
        if (seen === 1 || seen % REPORT_EVERY === 0) {
            reportEngineError('masterTick', e, { callback: name || 'anon', occurrences: seen });
        }
    };

    const attachMaster = () => {
        if (masterAttached) return;
        if (instrumented) {
            scene.onBeforeRenderObservable.add(() => {
                const list = callbacks;
                for (let i = 0; i < list.length; i++) {
                    const cb = list[i];
                    if (!cb) continue;
                    const t0 = performance.now();
                    try { cb.fn(); }
                    catch (e) { onCallbackError(cb.name, e); }
                    opts!.onCallbackTick!(cb.name, performance.now() - t0);
                }
                opts!.onFrameEnd?.();
            });
        } else {
            scene.onBeforeRenderObservable.add(() => {
                const list = callbacks;
                for (let i = 0; i < list.length; i++) {
                    const cb = list[i];
                    if (!cb) continue;
                    try { cb.fn(); }
                    catch (e) { onCallbackError(cb.name, e); }
                }
            });
        }
        masterAttached = true;
    };

    const sceneAny = scene as unknown as {
        registerBeforeRender: (fn: () => void) => void;
        unregisterBeforeRender: (fn: () => void) => void;
    };
    sceneAny.registerBeforeRender = (fn: () => void) => {
        callbacks.push({ fn, name: instrumented ? inferName(fn) : '' });
        attachMaster();
    };
    sceneAny.unregisterBeforeRender = (fn: () => void) => {
        const i = callbacks.findIndex((c) => c.fn === fn);
        if (i >= 0) callbacks.splice(i, 1);
    };
}
