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
                    // Half a vsync frame of tolerance.
                    //
                    // The blunt comparison `now - last < 1000/cap` looks correct
                    // and it is not: rAF arrives on multiples of the panel's refresh,
                    // so a frame landing ONE MILLISECOND before the deadline is
                    // skipped and the next one arrives a whole refresh later. At
                    // 60Hz with a cap of 40 the result is not 40 fps but 30 — a
                    // whole step lost, in the form of beating. Granting half a
                    // refresh period makes the decision fall on the right side.
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

    // ⚠️ The timer has to be kept and cancelled at teardown. Without that, an
    // unmount in the window between the request and the callback leaves the timer
    // alive: it fires after everything has been disposed and RESTARTS a render
    // loop on a dead engine. The symptom is a crash inside Babylon with no
    // visible relation to the unmount that caused it.
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
            // The gate SWITCHED this loop on: switching it off is part of its
            // teardown.
            if (loopRunning) {
                engine.stopRenderLoop();
                loopRunning = false;
            }
        },
    };
}
