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
     *  overlays (loading/interlude/ready) for battery.
     *  Positive finite targets use cumulative deadlines: with enough display
     *  callbacks, the average approaches the target. Individual intervals are
     *  display-quantized, not a strict minimum spacing. Invalid targets uncap.
     *  Changes/resume render immediately; long stalls discard accumulated debt. */
    targetFps?(): number | null;
}

export function setupRenderLoopGate(
    engine: AbstractEngine,
    scene: Scene,
    opts: RenderLoopGateOpts,
): { cleanup: () => void } {
    // null means ownership is not established: an existing host loop is not
    // evidence that OUR callback is installed. runRenderLoop adds callbacks.
    let loopRunning: boolean | null = null;
    let previousCap: number | null = null;
    let nextRenderMs = 0;
    let disposed = false;

    const render = () => {
        // Babylon may already have captured a callback when teardown occurs.
        if (disposed || !loopRunning) return;
        const cap = opts.targetFps?.();
        if (cap != null && Number.isFinite(cap) && cap > 0) {
            const now = performance.now();
            const period = 1000 / cap;
            if (cap !== previousCap) {
                previousCap = cap;
                nextRenderMs = now;
            }
            if (now < nextRenderMs) return;
            // Advance the scheduled deadline, not "now + period": display
            // quantization and jitter must not accumulate into a lower rate.
            // Allow one missed slot to settle on a later display callback;
            // discard longer backlogs instead of producing catch-up bursts.
            nextRenderMs = now - nextRenderMs >= 2 * period
                ? now + period : nextRenderMs + period;
        } else {
            previousCap = null;
        }
        if (scene.activeCamera) scene.render();
    };

    const resolveRenderLoop = () => {
        if (disposed) return;
        const want = opts.isRenderActive();
        if (loopRunning === want) return;
        // This adapter exclusively owns rendering for the adopted engine.
        // Remove the host callback before installing the gated one, including
        // when the first observed state is already active.
        engine.stopRenderLoop();
        loopRunning = false;
        previousCap = null;
        if (want) {
            engine.runRenderLoop(render);
            loopRunning = true;
        }
    };

    // ⚠️ The timer has to be kept and cancelled at teardown. Without that, an
    // unmount in the window between the request and the callback leaves the timer
    // alive: it fires after everything has been disposed and RESTARTS a render
    // loop on a dead engine. The symptom is a crash inside Babylon with no
    // visible relation to the unmount that caused it.
    const bootTimer = setTimeout(() => {
        if (disposed) return;
        // A notification may have arrived before the host registered its loop
        // after scene-ready. Reconcile once more at the end of the boot window.
        loopRunning = null;
        resolveRenderLoop();
    }, 1000);

    const unsubRender = opts.onRenderActiveChange(resolveRenderLoop);
    const unsubApp = opts.onAppActiveChange(() => { resolveRenderLoop(); });

    return {
        cleanup: () => {
            if (disposed) return;
            disposed = true;
            clearTimeout(bootTimer);
            unsubRender();
            unsubApp();
            // Stop even before ownership is established, or after an inactive
            // notification: the host may have registered during the boot window.
            engine.stopRenderLoop();
            loopRunning = false;
        },
    };
}
