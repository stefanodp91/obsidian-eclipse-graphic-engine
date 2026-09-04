// Central registry of scene-scoped, quality-dependent cache purgers.
//
// Any new WeakMap<Scene, …> (or scene-keyed module singleton) that holds
// tier/quality-dependent GPU state MUST register a purger here. The
// orchestrator (applyQualityChange) calls purgeAllSceneCaches() — it does
// NOT know the individual modules. This makes the invalidated set explicit
// and discoverable; a missing purger produces a silent stale-asset bug.
//
// Convention: infra purgers (MaterialLibrary, MeshPool, sharedShapes,
// shadow textures) are registered once at startup by the engine; content
// purgers (flora, shared level assets, application-specific caches) are
// registered by the consumer via registerScenePurge().

import type { Scene } from '@babylonjs/core';
import { getEngineIsDev } from '../../domain/engineConfig';

type ScenePurgeFn = (scene: Scene) => void;

const purgers: Array<{ label: string; fn: ScenePurgeFn }> = [];

/** Register a per-scene cache purger. `label` is used only for dev logging.
 *
 *  Returns a de-registration function. The registry is a MODULE-scoped array, so
 *  it lives as long as the bundle and not as long as the scene: a caller that
 *  registers per scene (or per world) without de-registering accumulated one
 *  entry per round, and every subsequent purge also ran all the closures of the
 *  previous worlds — which keep alive the very scenes they were supposed to free.
 *  A caller that registers once at boot (the expected case) can simply ignore the
 *  return value. */
export function registerScenePurge(label: string, fn: ScenePurgeFn): () => void {
    const entry = { label, fn };
    purgers.push(entry);
    return () => {
        const i = purgers.indexOf(entry);
        if (i >= 0) purgers.splice(i, 1);
    };
}

/** Dev-only: how many purgers are registered (sanity check from console). */
export function registeredPurgerCount(): number {
    return purgers.length;
}

/** Run every registered purger against `scene`. Each is isolated: a throwing
 *  purger is logged (dev) and skipped so one bad cache cannot abort the rest.
 *  In dev, logs the material/texture count delta. */
export function purgeAllSceneCaches(scene: Scene): void {
    const isDev = getEngineIsDev();
    const before = isDev
        ? { mats: scene.materials.length, texs: scene.textures.length }
        : null;

    for (const p of purgers) {
        try {
            p.fn(scene);
        } catch (e) {
            if (isDev) {
                // eslint-disable-next-line no-console
                console.warn(`[qualityPurge] purger "${p.label}" threw`, e);
            }
        }
    }

    if (isDev && before) {
        // eslint-disable-next-line no-console
        console.info(
            `[qualityPurge] ${purgers.length} purgers — `
            + `materials ${before.mats}→${scene.materials.length}, `
            + `textures ${before.texs}→${scene.textures.length}`,
        );
    }
}
