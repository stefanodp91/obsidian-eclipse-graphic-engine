// sharedShapes — one Havok PhysicsShape per (key, material), shared across all
// PhysicsBody instances of that key.
//
// Why: every pooled-obstacle acquire and every chunk recycle used to build a
// fresh PhysicsAggregate(mesh, BOX, opts) — and the aggregate constructor
// builds a brand-new Havok shape (WASM geometry alloc) each time, even though
// all instances of a pool key / chunk floor type have identical box dims. The
// shape build is the expensive half of the aggregate; the body is cheap.
//
// Verified drop-in (node_modules/@babylonjs/core/Physics/v2/physicsAggregate.js):
// the PhysicsAggregate ctor accepts a pre-built PhysicsShape as `type`, sets
// `_disposeShapeWhenDisposed = false`, so `aggregate.dispose()` destroys ONLY
// the body — the cached shape survives for the next acquire/recycle. The ctor
// also rewrites `shape.material = {friction, restitution}` on every build, so
// the cache key MUST include both → rewrites are idempotent.
//
// G4 safety: the shape replicates PhysicsAggregate's own BOX sizing math
// (bounding box × absolute scaling), so collider geometry is bit-identical to
// the previous per-instance shapes. New shapes must respect the frictionless
// doctrine for player-touchable colliders (material comes from the caller's
// opts — GAP_RAIL_PHYSICS vs STATIC_PHYSICS split falls out of the key).
//
import {
    Mesh, PhysicsAggregate, PhysicsShape, PhysicsShapeBox, Quaternion, Scene,
    TransformNode, Vector3,
} from '@babylonjs/core';
import { getEngineIsDev } from '../../domain/engineConfig';

export interface SharedShapeOpts {
    mass: number;
    restitution: number;
    friction: number;
}

interface CacheEntry { shape: PhysicsShape; extents: Vector3 }

const shapeCache = new WeakMap<Scene, Map<string, CacheEntry>>();

function getSceneCache(scene: Scene): Map<string, CacheEntry> {
    let m = shapeCache.get(scene);
    if (!m) {
        m = new Map();
        shapeCache.set(scene, m);
        // Shapes are not owned by any aggregate (dispose-body-only) — free them
        // with the scene.
        scene.onDisposeObservable.addOnce(() => {
            const entries = shapeCache.get(scene);
            if (entries) for (const e of entries.values()) e.shape.dispose();
            shapeCache.delete(scene);
        });
    }
    return m;
}

/** Free all cached collision shapes for `scene` without waiting for scene
 *  dispose. Used by the hot quality-change purge: shapes are tier-independent
 *  geometry but the cache outlives a GameScene remount, so it's cleared to
 *  keep the purge total (the next run rebuilds shapes lazily on first spawn). */
export function purgeShapeCache(scene: Scene): void {
    const entries = shapeCache.get(scene);
    if (entries) {
        for (const e of entries.values()) e.shape.dispose();
        shapeCache.delete(scene);
    }
}

// Replicates PhysicsAggregate._addSizeOptions BOX math so the shared shape is
// geometrically identical to what the aggregate would have auto-built.
function computeBoxFor(mesh: Mesh | TransformNode): { center: Vector3; extents: Vector3 } {
    mesh.computeWorldMatrix(true);
    const bi = (mesh as Mesh).getBoundingInfo ? (mesh as Mesh).getBoundingInfo() : null;
    const scaling = mesh.absoluteScaling;
    if (!bi) {
        return { center: Vector3.Zero(), extents: new Vector3(1, 1, 1) };
    }
    const ext = bi.boundingBox.extendSize;
    const ctr = bi.boundingBox.center;
    return {
        center: new Vector3(ctr.x * scaling.x, ctr.y * scaling.y, ctr.z * scaling.z),
        extents: new Vector3(
            Math.abs(ext.x * 2 * scaling.x),
            Math.abs(ext.y * 2 * scaling.y),
            Math.abs(ext.z * 2 * scaling.z),
        ),
    };
}

/**
 * PhysicsAggregate with a CACHED, shared BOX PhysicsShape.
 *
 * `cacheKey` must identify a class of geometrically identical meshes (a pool
 * key, or a quantized chunk-floor dims key). friction/restitution are folded
 * into the cache key so the ctor's material rewrite is idempotent. The
 * returned aggregate is drop-in (`.body`, `.dispose()` = body-only).
 */
export function sharedBoxAggregate(
    mesh: Mesh | TransformNode,
    opts: SharedShapeOpts,
    scene: Scene,
    cacheKey: string,
): PhysicsAggregate {
    const cache = getSceneCache(scene);
    const key = `${cacheKey}|f${opts.friction}|r${opts.restitution}`;
    let entry = cache.get(key);
    if (!entry) {
        const { center, extents } = computeBoxFor(mesh);
        entry = {
            shape: new PhysicsShapeBox(center, Quaternion.Identity(), extents, scene),
            extents,
        };
        cache.set(key, entry);
    } else if (getEngineIsDev()) {
        // Guard: a key must never cover meshes with diverging dims — that would
        // silently give an instance the wrong collider (G4 hazard).
        const { extents } = computeBoxFor(mesh);
        if (Math.abs(extents.x - entry.extents.x) > 1e-3
            || Math.abs(extents.y - entry.extents.y) > 1e-3
            || Math.abs(extents.z - entry.extents.z) > 1e-3) {
            // eslint-disable-next-line no-console
            console.warn(`[sharedShapes] dims mismatch for key "${key}": cached ${entry.extents.toString()} vs ${extents.toString()}`);
        }
    }
    return new PhysicsAggregate(mesh, entry.shape, opts, scene);
}

/** Quantized dims key for chunk floors/rails — same box dims → same shape,
 *  regardless of chunk slot. 1e-3 quantization on metre-scale dims. */
export function dimsKeyFor(mesh: Mesh | TransformNode, prefix: string): string {
    const { extents } = computeBoxFor(mesh);
    const q = (v: number): number => Math.round(v * 1000) / 1000;
    return `${prefix}|${q(extents.x)}x${q(extents.y)}x${q(extents.z)}`;
}
