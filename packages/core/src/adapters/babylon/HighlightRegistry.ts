// Highlight layer registry — single source of truth for which meshes have a
// transient outline. The owner (scene setup) holds the HighlightLayer instance;
// consumers add/remove meshes via this module. The indirection lets the layer be
// torn down + rebuilt (e.g. on preset change) without orphaning subscribers.

import type { AbstractMesh, HighlightLayer } from '@babylonjs/core';
import { Color3 } from '@babylonjs/core';

let currentLayer: HighlightLayer | null = null;
const activeMeshes = new Map<AbstractMesh, Color3>();

const DEFAULT_HIGHLIGHT = new Color3(0.6, 0.85, 1.0);

export function setHighlightLayer(layer: HighlightLayer | null): void {
    if (currentLayer === layer) return;
    if (currentLayer) {
        for (const mesh of activeMeshes.keys()) {
            try { currentLayer.removeMesh(mesh as never); } catch { /* mesh maybe disposed */ }
        }
    }
    currentLayer = layer;
    if (!layer) return;
    for (const [mesh, color] of activeMeshes) {
        try { layer.addMesh(mesh as never, color); } catch { /* mesh maybe disposed */ }
    }
}

export function addHighlightedMesh(mesh: AbstractMesh, color?: Color3): void {
    // Babylon HighlightLayer.addMesh accepts only Mesh, not InstancedMesh or
    // thin-instance masters. Guard against instanced meshes — caller path will
    // silently no-op for unsupported mesh types.
    if ((mesh as { sourceMesh?: unknown }).sourceMesh !== undefined) return;
    const c = color ?? DEFAULT_HIGHLIGHT;
    activeMeshes.set(mesh, c);
    if (currentLayer) {
        currentLayer.addMesh(mesh as never, c);
    }
}

export function removeHighlightedMesh(mesh: AbstractMesh): void {
    activeMeshes.delete(mesh);
    if (currentLayer) {
        try { currentLayer.removeMesh(mesh as never); } catch { /* mesh maybe disposed */ }
    }
}

export function clearHighlights(): void {
    if (currentLayer) {
        for (const mesh of activeMeshes.keys()) {
            try { currentLayer.removeMesh(mesh as never); } catch { /* mesh maybe disposed */ }
        }
    }
    activeMeshes.clear();
}
