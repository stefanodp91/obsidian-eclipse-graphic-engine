// Shader-cache persistence (2026-07-02).
//
// Problem: Babylon Effects are ref-counted — when the last material using a
// variant is disposed (level-scoped materials: player skin, obstacles, per-level
// decor), the compiled GPU PROGRAM is removed from `engine._compiledEffects`. At
// the next level transition the same variants are recompiled from scratch:
// measured on the reference target, ~35 effects recompiled per transition (long
// task 0.6-1.1s on a flagship GPU, ~2-4s on mid) — the dominant contributor to
// transition freezes.
//
// Fix: `Effect.PersistentMode` (Babylon's official knob) makes a non-force
// `dispose()` a no-op → the compiled programs stay resident for the engine's
// lifetime. The cost is GPU/JS memory bounded by the number of unique variants
// (~100 for this game profile, a few MB); real teardown is still guaranteed by
// `engine.dispose()`/`releaseEffects()` (the force path).
import { Effect } from '@babylonjs/core';

/** Enables shader-cache persistence (idempotent). */
export function installPersistentShaderCache(): void {
    Effect.PersistentMode = true;
}

/** Restores standard ref-counting (test/teardown). */
export function uninstallPersistentShaderCache(): void {
    Effect.PersistentMode = false;
}
