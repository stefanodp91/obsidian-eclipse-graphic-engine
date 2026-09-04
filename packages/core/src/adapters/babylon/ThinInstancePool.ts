// Thin-instance pool — single-draw-call counterpart to MeshPool.
//
// MeshPool returns InstancedMesh objects (one draw call per instance, shared
// vertex buffer). ThinInstancePool keeps the same idea — pre-allocate slots,
// reuse on acquire/release — but stores per-slot transforms in the master
// mesh's `thinInstance` matrix buffer. All live slots render in a SINGLE
// draw call, regardless of count.
//
// Use it for visual-only mesh types where:
//   - per-instance picking is not needed (no `scene.pick` per slot)
//   - per-instance physics body is not needed (one Havok collider tops, on
//     the master, OR no collider at all — the typical decor case)
//   - per-instance material variation is not needed (all share master mat)
//
// Decor obstacles, particle-like collectible visuals, ambient props are the
// natural consumers. The chunk-recycled MeshPool stays the right tool for
// anything that needs a Havok aggregate per instance or stencil pick.
//
// Migration is intentionally opt-in. Audit each consumer before switching:
// instances that need individual picking, collision bodies, materials, or
// animation state must remain regular meshes. Visual-only decor and trails
// are the strongest thin-instance candidates.

import type { Mesh, Scene } from '@babylonjs/core';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core';

/** Park unused slots well below any visible Y so they survive frustum +
 *  occlusion culls without rendering pixels. Scale 0 collapses the thin
 *  instance to a point so it's degenerate anywhere — even cheaper than
 *  off-screen, and depth-test still discards it. */
const HIDDEN_MATRIX = Matrix.Compose(
    Vector3.Zero(),         // scale = 0
    Quaternion.Identity(),  // no rotation
    new Vector3(0, -1e4, 0), // far below scene
);

export interface ThinInstancePoolOptions {
    /** Babylon scene that owns the master mesh. */
    scene: Scene;
    /** Factory for the single master mesh + material. Called once at
     *  pool construction. The returned mesh MUST have its material set
     *  before this call returns. */
    createMaster: (scene: Scene) => Mesh;
    /** Maximum live thin-instance slots. Buffer is allocated once at this
     *  size; growing it later requires a copy + GPU re-upload, which we
     *  forbid in the scaffold — set conservatively. */
    capacity: number;
    /** The pool OWNS the master's material and destroys it on dispose.
     *
     *  Default `false`, and that is the safe default: a material coming from the
     *  MaterialLibrary is SHARED and ref-counted, so destroying it here pulls it
     *  out from under every other user — and the ref count is left pointing at a
     *  live material that no longer exists. The symptom (black surfaces elsewhere
     *  in the scene) bears no visible relation to the disposed pool. Whoever
     *  builds a dedicated material inside `createMaster` sets `true` and takes
     *  ownership of it. */
    ownsMaterial?: boolean;
}

/** Handle returned to acquire() — opaque holder of the slot index. */
export interface ThinInstanceHandle {
    /** Update this slot's world matrix. Buffer flush is deferred until the
     *  next `flush()` call so a batched update only triggers one GPU upload. */
    setMatrix: (matrix: Matrix) => void;
    /** Park the slot at the hidden matrix without releasing it. Useful when
     *  a consumer wants to temporarily hide a mesh (eg. collect animation
     *  finished) and respawn it later without going through the free list. */
    setEnabled: (enabled: boolean) => void;
    /** Return the slot to the free list and park it hidden. Subsequent
     *  `setMatrix` calls are no-ops. */
    release: () => void;
}

export interface ThinInstancePool {
    /** Acquire an unused slot. Returns null when the pool is exhausted —
     *  caller should warn + lazily grow upstream (e.g. raise prewarm
     *  count in chunk generation), since this scaffold does NOT auto-grow. */
    acquire: () => ThinInstanceHandle | null;
    /** Push any pending matrix changes from acquire/setMatrix to the GPU.
     *  Call once per frame AFTER all the per-slot mutations have run.
     *  Skipping a frame is OK — the slot keeps its previous matrix. */
    flush: () => void;
    /** Snapshot of usage for telemetry. */
    stats: () => { alive: number; free: number; capacity: number; peak: number };
    /** Dispose the master mesh + material. After this the pool throws on
     *  any further acquire(). */
    dispose: () => void;
}

interface InternalState {
    master: Mesh;
    matrices: Float32Array;
    free: number[];
    inUse: Set<number>;
    dirty: boolean;
    peak: number;
    disposed: boolean;
}

function writeMatrixAt(buffer: Float32Array, slot: number, matrix: Matrix): void {
    matrix.copyToArray(buffer, slot * 16);
}

export function createThinInstancePool(opts: ThinInstancePoolOptions): ThinInstancePool {
    const { scene, createMaster, capacity, ownsMaterial = false } = opts;
    if (capacity <= 0) {
        throw new Error('[ThinInstancePool] capacity must be > 0');
    }

    const master = createMaster(scene);
    const matrices = new Float32Array(capacity * 16);

    // Park every slot hidden up front so the GPU upload covers the full
    // buffer in one go and subsequent `thinInstanceCount` reads cleanly.
    for (let i = 0; i < capacity; i++) {
        writeMatrixAt(matrices, i, HIDDEN_MATRIX);
    }
    master.thinInstanceSetBuffer('matrix', matrices, 16, false);
    master.thinInstanceCount = capacity;
    // The master bounds cover only its creation position, while instances can
    // move anywhere and refreshing bounds on every matrix write is expensive.
    // Keep the master active so Babylon does not cull the complete batch when
    // those original bounds leave the frustum.
    master.alwaysSelectAsActiveMesh = true;
    master.isPickable = false;

    const state: InternalState = {
        master,
        matrices,
        free: Array.from({ length: capacity }, (_, i) => capacity - 1 - i),
        inUse: new Set(),
        dirty: false,
        peak: 0,
        disposed: false,
    };

    function flushIfDirty(): void {
        if (!state.dirty || state.disposed) return;
        state.master.thinInstanceBufferUpdated('matrix');
        state.dirty = false;
    }

    function makeHandle(slot: number): ThinInstanceHandle {
        let released = false;
        return {
            setMatrix: (matrix) => {
                if (released || state.disposed) return;
                writeMatrixAt(state.matrices, slot, matrix);
                state.dirty = true;
            },
            setEnabled: (enabled) => {
                if (released || state.disposed) return;
                if (!enabled) {
                    writeMatrixAt(state.matrices, slot, HIDDEN_MATRIX);
                    state.dirty = true;
                }
                // enabled=true is a no-op: caller must call setMatrix with
                // the desired world transform. Avoids stashing a "last
                // visible" matrix that would conflict with respawn flows.
            },
            release: () => {
                if (released || state.disposed) return;
                released = true;
                state.inUse.delete(slot);
                state.free.push(slot);
                writeMatrixAt(state.matrices, slot, HIDDEN_MATRIX);
                state.dirty = true;
            },
        };
    }

    return {
        acquire: () => {
            if (state.disposed) return null;
            const slot = state.free.pop();
            if (slot == null) return null;
            state.inUse.add(slot);
            if (state.inUse.size > state.peak) state.peak = state.inUse.size;
            return makeHandle(slot);
        },
        flush: flushIfDirty,
        stats: () => ({
            alive: state.inUse.size,
            free: state.free.length,
            capacity,
            peak: state.peak,
        }),
        dispose: () => {
            if (state.disposed) return;
            state.disposed = true;
            state.inUse.clear();
            state.free.length = 0;
            const mat = state.master.material;
            state.master.dispose();
            if (ownsMaterial) mat?.dispose();
        },
    };
}
