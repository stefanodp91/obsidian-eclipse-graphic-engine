// Babylon-9-correct readers for draw calls / active triangles / active vertices.
//
// Babylon 9 removed the public mirrors these diagnostics used to read:
//   - `engine.drawCalls` (PerfCounter) → only private `engine._drawCalls` remains
//   - `scene.activeIndices` (number property) → method `scene.getActiveIndices()`
//   - `scene.getActiveVerticesCount()` → never public; sum per active mesh

import type { AbstractEngine, Scene } from '@babylonjs/core';

type EngineWithPrivateDrawCalls = AbstractEngine & {
    _drawCalls?: { current: number };
};

/** Draw calls for the last frame. Reads the private `_drawCalls` PerfCounter
 *  (the public `drawCalls` mirror was removed in Babylon 9). 0 if absent. */
export function readDrawCalls(engine: AbstractEngine): number {
    return (engine as EngineWithPrivateDrawCalls)._drawCalls?.current ?? 0;
}

/** Active index count for the last frame (3× active triangles). Method form;
 *  the `scene.activeIndices` property mirror was removed in Babylon 9. */
export function readActiveIndices(scene: Scene): number {
    return scene.getActiveIndices();
}

/** Active triangles = active indices / 3, rounded. */
export function readActiveTriangles(scene: Scene): number {
    return Math.round(readActiveIndices(scene) / 3);
}

/** Sum vertex counts across all currently active meshes. Zero-closure hot path. */
export function sumActiveVerts(scene: Scene): number {
    const active = scene.getActiveMeshes();
    let total = 0;
    for (let i = 0; i < active.length; i++) {
        total += active.data[i]!.getTotalVertices();
    }
    return total;
}
