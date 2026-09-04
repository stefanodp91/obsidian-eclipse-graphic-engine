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

    // ⚠️ A callback that throws does so EVERY FRAME, not once.
    //
    // The previous version answered with an unconditional `console.error`: 60
    // stack traces a second on an Android WebView are a real cost item in the
    // frame — the error mitigation was itself becoming a performance problem,
    // precisely while something was already broken. And since it reached no sink,
    // the error never showed up in telemetry: it stayed visible only to whoever
    // happened to have a cable attached.
    //
    // Now: the FIRST occurrence per callback is reported (the one with the
    // diagnostic information), then it stops. The count travels with the next
    // report, so "it happened once" and "it has been happening for half an hour"
    // stay distinguishable.
    const REPORT_EVERY = 600;   // ~10 s at 60 fps
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
