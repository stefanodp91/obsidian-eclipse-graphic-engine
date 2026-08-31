// SRP use case: render-loop gating by external active-state signal.
// Reactylon installs its render loop after onSceneReady returns; the 1 s
// setTimeout lets it flush all in-flight submits before we may stop.
// Game-specific logic (which FSM phase = renderLoopActive, audio suspend/resume)
// is injected via RenderLoopGateOpts — this module knows nothing about game
// phases, stores, or audio.

import type { AbstractEngine, Scene } from '@babylonjs/core';

export interface RenderLoopGateOpts {
    /** Returns true when the render loop should be running. */
    isRenderActive(): boolean;
    /** Subscribe to state changes that may affect render-active. Returns unsub fn. */
    onRenderActiveChange(cb: () => void): () => void;
    /** Subscribe to app foreground/background transitions. Returns unsub fn. */
    onAppActiveChange(cb: (isActive: boolean) => void): () => void;
    /** Optional per-frame fps cap (null/undefined = uncapped / full vsync). Read
     *  LIVE inside the loop each frame — so a phase change that lowers the cap
     *  takes effect without re-registering the loop. Enforced by skipping the
     *  `scene.render()` (frame-skip), NOT by touching `engine.maxFPS` (which has
     *  other owners). Used to throttle non-interactive phases behind opaque
     *  overlays (loading/interlude/ready) for battery. */
    targetFps?(): number | null;
}

export function setupRenderLoopGate(
    engine: AbstractEngine,
    scene: Scene,
    opts: RenderLoopGateOpts,
): { cleanup: () => void } {
    let loopRunning = true;
    let lastRenderMs = 0;
    let disposed = false;

    const resolveRenderLoop = () => {
        if (disposed) return;
        const want = opts.isRenderActive();
        if (!want) {
            if (loopRunning) {
                engine.stopRenderLoop();
                loopRunning = false;
            }
            return;
        }
        if (!loopRunning) {
            engine.runRenderLoop(() => {
                const cap = opts.targetFps?.();
                if (cap != null && cap > 0) {
                    const now = performance.now();
                    // Tolleranza di mezzo frame di vsync.
                    //
                    // Il confronto secco `now - last < 1000/cap` sembra corretto e
                    // non lo è: il rAF arriva su multipli del refresh del pannello,
                    // quindi un frame che cade UN MILLISECONDO prima della scadenza
                    // viene saltato e il successivo arriva un refresh intero dopo.
                    // A 60Hz con cap 40 il risultato non è 40 fps ma 30 — un intero
                    // gradino perso, sotto forma di battimento. Concedere metà
                    // periodo di refresh fa cadere la decisione dalla parte giusta.
                    const period = 1000 / cap;
                    const tolerance = period * 0.5;
                    if (now - lastRenderMs < period - tolerance) return;   // skip: throttle
                    lastRenderMs = now;
                }
                if (scene.activeCamera) scene.render();
            });
            loopRunning = true;
        }
    };

    // ⚠️ Il timer va tenuto e annullato al teardown. Senza, uno smontaggio nel
    // primo secondo di vita (cambio livello rapido, boot annullato, StrictMode)
    // lascia il timer vivo: scatta dopo che tutto è stato disposto e RIAVVIA un
    // render loop su un engine morto. Il sintomo è un crash dentro Babylon che
    // non ha alcun rapporto visibile con lo smontaggio che l'ha causato.
    const bootTimer = setTimeout(resolveRenderLoop, 1000);

    const unsubRender = opts.onRenderActiveChange(resolveRenderLoop);
    const unsubApp = opts.onAppActiveChange(() => { resolveRenderLoop(); });

    return {
        cleanup: () => {
            if (disposed) return;
            disposed = true;
            clearTimeout(bootTimer);
            unsubRender();
            unsubApp();
            // Il gate ha ACCESO questo loop: spegnerlo è parte del suo teardown.
            // Lasciarlo girare significa continuare a renderizzare (e a consumare
            // batteria) dopo che il proprietario se n'è andato.
            if (loopRunning) {
                engine.stopRenderLoop();
                loopRunning = false;
            }
        },
    };
}
