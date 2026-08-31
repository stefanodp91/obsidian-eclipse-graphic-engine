// Shadow caster/receiver registry — one primary caster + a receiver set, with a
// scripted-shadow fallback toggled by ShadowGenerator presence.
//
// When a real ShadowGenerator is active, scripted (blob) shadow meshes are
// hidden and the registered receivers get `receiveShadows = true`; the primary
// caster is added to the generator. When no generator is active, scripted blob
// shadows show and receivers are cleared.

import type { AbstractMesh, ShadowGenerator } from '@babylonjs/core';

let currentSG: ShadowGenerator | null = null;
let primaryCaster: AbstractMesh | null = null;
const receivers = new Set<AbstractMesh>();
const scriptedShadowMeshes = new Set<AbstractMesh>();

export function setShadowGenerator(sg: ShadowGenerator | null): void {
    if (currentSG && currentSG !== sg) {
        for (const m of receivers) {
            m.receiveShadows = false;
        }
    }
    currentSG = sg;
    // Scripted blob shadows visible only when ShadowGenerator is off.
    const scriptedVisible = !sg;
    for (const m of scriptedShadowMeshes) {
        m.setEnabled(scriptedVisible);
    }
    if (!sg) return;

    if (primaryCaster) {
        sg.addShadowCaster(primaryCaster, true);
    }
    for (const m of receivers) {
        m.receiveShadows = true;
    }
}

export function registerScriptedShadow(mesh: AbstractMesh): void {
    mesh.setEnabled(!currentSG);
    scriptedShadowMeshes.add(mesh);
}

export function unregisterScriptedShadow(mesh: AbstractMesh): void {
    scriptedShadowMeshes.delete(mesh);
}

export function setPrimaryShadowCaster(mesh: AbstractMesh | null): void {
    if (primaryCaster && currentSG) {
        currentSG.removeShadowCaster(primaryCaster, true);
    }
    primaryCaster = mesh;
    if (mesh && currentSG) {
        currentSG.addShadowCaster(mesh, true);
    }
}

export function getShadowReceivers(): ReadonlySet<AbstractMesh> {
    return receivers;
}

export function addShadowReceiver(mesh: AbstractMesh): void {
    receivers.add(mesh);
    if (currentSG) mesh.receiveShadows = true;
}

export function removeShadowReceiver(mesh: AbstractMesh): void {
    receivers.delete(mesh);
    mesh.receiveShadows = false;
}
