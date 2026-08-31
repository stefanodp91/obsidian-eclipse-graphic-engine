// ── Render interpolation for a single mesh (fixed-timestep frame-pacing) ──────
//
// Problem: physics runs at a FIXED step (Havok plugin built with useDelta=false)
// paired with Babylon's accumulator-driven sub-stepping. A render frame lands at
// an arbitrary point BETWEEN two physics steps. Drawing the mesh at the raw
// post-step transform makes it appear to jump from step to step while the camera
// glides ("scattoso / vibrante / no-vsync" feel at 45-60 fps).
//
// Fix (classic fixed-timestep render interpolation, single-mesh variant): each
// substep record prev + cur transform; each render frame draw at
// lerp(prev, cur, alpha) where alpha = Scene._physicsTimeAccumulator / subStep.
// To keep gameplay authoritative, the interpolated transform is applied to the
// mesh ONLY for the draw (onBeforeRender, after every gameplay observer has read
// the true position) and RESTORED to the true transform immediately after the
// draw (onAfterRender, before the next physics pre-step). Collisions, death,
// win, etc. read the real physics position during the master tick.

import { Vector3, Quaternion } from '@babylonjs/core';
import type { Scene, Mesh } from '@babylonjs/core';

export interface MeshRenderInterpolationHandle {
    /** Interpolated render position for this frame, written into `out`. Falls
     *  back to the mesh's true position when interpolation is inactive (disabled,
     *  no substep recorded yet, or sub-stepping disabled). */
    getRenderPositionToRef(out: Vector3): Vector3;
    dispose(): void;
}

interface SubSteppable { getSubTimeStep(): number }

/**
 * Attach render interpolation to the scene for the mesh returned by `getMesh`
 * (or null while it is unmounted / mid-respawn). `enabled=false` makes the
 * handle a no-op passthrough (always renders at the raw physics transform).
 */
export function attachMeshRenderInterpolation(
    scene: Scene,
    getMesh: () => Mesh | null,
    enabled = true,
    /**
     * Optional VERTICAL render offset, sampled per draw at the mesh's (x, z). Lets a
     * consumer make the mesh visually ride a terrain height-field (e.g. an undulating
     * floor) WITHOUT touching the physics body: the offset is added to the drawn
     * transform and to `getRenderPositionToRef` (so a follow-camera tracks it), then
     * wiped by `restore` (which puts back the true physics pos). Brand-agnostic.
     */
    renderYOffset?: (x: number, z: number) => number,
): MeshRenderInterpolationHandle {
    // Last two physics-step transforms (the segment we interpolate across).
    const prevPos = new Vector3();
    const curPos = new Vector3();
    const prevRot = new Quaternion();
    const curRot = new Quaternion();
    let hasRot = false;
    let primed = false;       // at least one substep captured this run

    // True transform saved at apply-time so the draw can be restored exactly.
    const savedPos = new Vector3();
    const savedRot = new Quaternion();
    let applied = false;
    let appliedRot = false;

    const subTimeMs = (): number => {
        const pe = scene.getPhysicsEngine() as unknown as SubSteppable | null;
        return pe ? pe.getSubTimeStep() : 0;
    };

    const inactive = (): boolean =>
        !enabled || !primed || subTimeMs() <= 0;

    const alpha = (): number => {
        const sub = subTimeMs();
        if (sub <= 0) return 1;
        const acc = (scene as unknown as { _physicsTimeAccumulator?: number })._physicsTimeAccumulator ?? 0;
        const a = acc / sub;
        return Math.min(1, Math.max(0, a));
    };

    // Per-substep capture (fires inside the accumulator loop, after the body has
    // synced → mesh). Shift cur → prev, sample the fresh transform.
    const onAfterPhys = (): void => {
        const mesh = getMesh();
        if (!mesh) { primed = false; hasRot = false; return; }
        prevPos.copyFrom(curPos);
        curPos.copyFrom(mesh.position);
        if (mesh.rotationQuaternion) {
            if (hasRot) prevRot.copyFrom(curRot);
            else prevRot.copyFrom(mesh.rotationQuaternion);
            curRot.copyFrom(mesh.rotationQuaternion);
            hasRot = true;
        }
        // First capture: collapse the segment so the first interpolated frame
        // sits exactly on the body instead of lerping from a stale origin.
        if (!primed) { prevPos.copyFrom(curPos); primed = true; }
    };

    // Just before the draw: swap in the interpolated transform.
    //
    // NOTE: `renderYOffset` is deliberately NOT gated by `inactive()`.
    // Interpolation and the vertical offset are two independent render-space
    // corrections that merely share this hook: the first smooths between physics
    // steps, the second makes the mesh ride a visible height-field the collider
    // does not have. Gating both on one predicate meant a host that never
    // configured sub-stepping (`getSubTimeStep() === 0`) silently lost the offset
    // as well — and a character drawn on the flat collider plane under an
    // undulating deck gets swallowed by the ground. That is what shipped on
    // three separate worlds until 2026-08-21. Smoothness is a nicety; sinking through the
    // floor is not.
    const apply = (): void => {
        const mesh = getMesh();
        if (!mesh) return;
        const interpolating = !inactive();
        if (!interpolating && !renderYOffset) return;
        savedPos.copyFrom(mesh.position);
        if (interpolating) Vector3.LerpToRef(prevPos, curPos, alpha(), mesh.position);
        if (renderYOffset) mesh.position.y += renderYOffset(mesh.position.x, mesh.position.z);
        if (interpolating && hasRot && mesh.rotationQuaternion) {
            savedRot.copyFrom(mesh.rotationQuaternion);
            Quaternion.SlerpToRef(prevRot, curRot, alpha(), mesh.rotationQuaternion);
            appliedRot = true;
        }
        applied = true;
    };

    // Just after the draw: restore the authoritative physics transform so the
    // next physics pre-step and the next gameplay tick read the truth.
    const restore = (): void => {
        if (!applied) return;
        const mesh = getMesh();
        if (mesh) {
            mesh.position.copyFrom(savedPos);
            // Only when `apply` actually interpolated the rotation: with the
            // vertical correction alone `savedRot` was never rewritten, and
            // restoring it would put back a frame-old orientation.
            if (appliedRot && hasRot && mesh.rotationQuaternion) mesh.rotationQuaternion.copyFrom(savedRot);
        }
        applied = false;
        appliedRot = false;
    };

    const getRenderPositionToRef = (out: Vector3): Vector3 => {
        const mesh = getMesh();
        if (inactive()) {
            // `applied` = we are between apply and restore, so `mesh.position`
            // ALREADY carries the offset: starting from it would add it twice.
            if (applied) out.copyFrom(savedPos);
            else if (mesh) out.copyFrom(mesh.position);
            else return out;
        } else {
            Vector3.LerpToRef(prevPos, curPos, alpha(), out);
        }
        if (renderYOffset) out.y += renderYOffset(out.x, out.z);
        return out;
    };

    const afterPhysObs = scene.onAfterPhysicsObservable?.add(onAfterPhys) ?? null;
    // apply runs AFTER the master-tick observer (registered at scene-ready), so
    // every gameplay/camera observer has already read the true position.
    const beforeRenderObs = scene.onBeforeRenderObservable.add(apply);
    const afterRenderObs = scene.onAfterRenderObservable.add(restore);

    return {
        getRenderPositionToRef,
        dispose() {
            if (afterPhysObs) scene.onAfterPhysicsObservable?.remove(afterPhysObs);
            scene.onBeforeRenderObservable.remove(beforeRenderObs);
            scene.onAfterRenderObservable.remove(afterRenderObs);
            // If unmounted mid-frame with the interp transform applied, put the
            // truth back so a lingering mesh is not left displaced.
            restore();
        },
    };
}
