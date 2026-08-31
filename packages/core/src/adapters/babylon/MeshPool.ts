// Mesh pool — pre-allocates Babylon.js meshes per type so chunk recycling
// can reuse instances instead of dispose+recreate each spawn. Eliminates
// pop-in caused by GPU vertex buffer upload, shader pipeline binding on
// new mesh, and Havok PhysicsAggregate construction at runtime.
//
// Lifecycle:
//   1. registerPoolType(key, factory) — module load
//   2. prewarmPool(scene, key, count) — during warmup pipeline
//   3. one scene.render() with all instances visible off-screen → primes GPU
//   4. hideAllPrewarmed(scene) → disables all pooled instances
//   5. acquire/release at runtime as React components mount/unmount chunks
//   6. releaseAllPools(scene) on world teardown

import { AbstractMesh } from '@babylonjs/core';
import type { Scene, Mesh, PhysicsAggregate } from '@babylonjs/core';

const HIDDEN_POSITION_Y = -1000;
const PREWARM_OFFSCREEN_Y = -100;

export interface PoolFactoryResult {
    mesh: AbstractMesh;
    /** Additional meshes that move/render together (e.g. pendulum arm + head). */
    extras?: AbstractMesh[];
    /** LOD meshes attached via addLODLevel — disposed explicitly on pool cleanup. */
    lodMeshes?: AbstractMesh[];
}

export interface PoolFactory {
    create: (scene: Scene) => PoolFactoryResult;
    /**
     * Optional: create the single master mesh from which all pool items are instanced.
     * When provided, prewarmPool creates 1 master (geometry + material) and then spawns
     * InstancedMesh items sharing the same vertex buffer — 1 GPU draw-call per type.
     * Called only once per scene. If absent, falls back to the full-mesh path.
     */
    createMaster?: (scene: Scene) => PoolFactoryResult;
    /**
     * Optional: called after each instance group is created. Use to establish parent
     * relationships between main and extra instances (e.g. fan blade → hub instance).
     */
    setupInstance?: (main: AbstractMesh, extras: AbstractMesh[]) => void;
    /** Optional — called on each acquire to attach Havok body. Disposed on release. */
    buildPhysics?: (
        mesh: AbstractMesh,
        extras: AbstractMesh[],
        scene: Scene,
    ) => PhysicsAggregate | null;
    /** Optional — dispose hook for full-mesh pool items. NOT called for instanced items. */
    disposeItem?: (item: PooledItem, scene: Scene) => void;
    /** Optional — called once when the master mesh set is released. Disposes master geometry and releases materials. */
    disposeMaster?: (master: PoolFactoryResult, scene: Scene) => void;
}

export interface PooledItem {
    mesh: AbstractMesh;
    extras: AbstractMesh[];
    physicsAgg: PhysicsAggregate | null;
    inUse: boolean;
}

interface PoolEntry {
    factory: PoolFactory;
    items: PooledItem[];
    free: PooledItem[];
    peakInUse: number;
    /** Master mesh set for instanced pools. Present when factory.createMaster is used. */
    master?: PoolFactoryResult;
}

export interface AcquireResult {
    mesh: AbstractMesh;
    extras: AbstractMesh[];
    /**
     * Call this AFTER setting mesh.position / rotation / scaling and calling
     * mesh.computeWorldMatrix(true). Creates the Havok body at the correct
     * world transform. Returns null for types without physics (pendulum, etc.).
     * The aggregate is owned by the pool — do NOT dispose it separately;
     * release() handles disposal.
     */
    buildPhysics: () => PhysicsAggregate | null;
    release: () => void;
}

const pools = new WeakMap<Scene, Map<string, PoolEntry>>();
const factories = new Map<string, PoolFactory>();

// D-1 A3: instances created since the last beginPrewarmBatch(). Lets the warmup
// pipeline prime ONLY what it just allocated — a same-world next-level grows a
// few instances of already-compiled pool types, so re-rendering EVERY pooled
// mesh (selectAllForPrewarmRender) is wasted work and a ~235ms boundary long
// task. Priming only the new instances is near-free (shared master already
// compiled+uploaded; just the instance buffer).
const prewarmBatches = new WeakMap<Scene, PooledItem[]>();

function getMap(scene: Scene): Map<string, PoolEntry> {
    let m = pools.get(scene);
    if (!m) { m = new Map(); pools.set(scene, m); }
    return m;
}

export function registerPoolType(key: string, factory: PoolFactory): void {
    factories.set(key, factory);
}

export function getRegisteredPoolKeys(): string[] {
    return [...factories.keys()];
}

function setItemEnabled(item: PooledItem, enabled: boolean): void {
    item.mesh.setEnabled(enabled);
    for (const ex of item.extras) ex.setEnabled(enabled);
}

function parkItemHidden(item: PooledItem): void {
    item.mesh.position.y = HIDDEN_POSITION_Y;
    setItemEnabled(item, false);
}

function parkItemOffscreen(item: PooledItem): void {
    item.mesh.position.y = PREWARM_OFFSCREEN_Y;
    // Only park unparented extras directly. Parented extras inherit world
    // position from their parent chain (rooted at item.mesh) and would have
    // their LOCAL layout corrupted if we forced their .position.y here —
    // breaking, e.g., squid tentacles whose segments live at local y offsets
    // relative to their pivots.
    for (const ex of item.extras) {
        if (!ex.parent) ex.position.y = PREWARM_OFFSCREEN_Y;
    }
    setItemEnabled(item, true);
}

/** Start tracking newly-prewarmed instances for this scene. Call once at the
 *  top of a warmup pass; afterwards prewarmPool records every instance it
 *  creates so selectNewlyPrewarmedForRender can prime just those. */
export function beginPrewarmBatch(scene: Scene): void {
    prewarmBatches.set(scene, []);
}

/** Force ONLY the instances created since beginPrewarmBatch() into the active
 *  render list (so scene.render() compiles their variant + uploads buffers).
 *  Returns the count selected. On a world swap the batch holds every freshly
 *  built instance (≡ select-all); on a same-world next-level it holds just the
 *  grown few. Pair with resetPrewarmSelect() after the render(s). */
export function selectNewlyPrewarmedForRender(scene: Scene): number {
    const batch = prewarmBatches.get(scene);
    if (!batch) return 0;
    for (const item of batch) {
        item.mesh.alwaysSelectAsActiveMesh = true;
        for (const ex of item.extras) ex.alwaysSelectAsActiveMesh = true;
    }
    return batch.length;
}

/** Force all pooled meshes into the active render list regardless of frustum.
 *  Call before scene.render() during warmup; call resetPrewarmSelect after. */
export function selectAllForPrewarmRender(scene: Scene): void {
    const m = pools.get(scene);
    if (!m) return;
    for (const entry of m.values()) {
        for (const item of entry.items) {
            item.mesh.alwaysSelectAsActiveMesh = true;
            for (const ex of item.extras) ex.alwaysSelectAsActiveMesh = true;
        }
    }
}

/** Reset alwaysSelectAsActiveMesh after prewarm render(s) complete. */
export function resetPrewarmSelect(scene: Scene): void {
    const m = pools.get(scene);
    if (!m) return;
    for (const entry of m.values()) {
        for (const item of entry.items) {
            item.mesh.alwaysSelectAsActiveMesh = false;
            for (const ex of item.extras) ex.alwaysSelectAsActiveMesh = false;
        }
    }
}

let instSerial = 0;

function buildOne(scene: Scene, entry: PoolEntry): PooledItem {
    if (entry.master) {
        const masterMesh = entry.master.mesh as Mesh;
        const mesh = masterMesh.createInstance(`inst-${instSerial++}`);
        const extras = (entry.master.extras ?? []).map(
            ex => (ex as Mesh).createInstance(`inst-ex-${instSerial++}`),
        );
        entry.factory.setupInstance?.(mesh, extras);
        return { mesh, extras, physicsAgg: null, inUse: false };
    }
    const { mesh, extras = [] } = entry.factory.create(scene);
    return { mesh, extras, physicsAgg: null, inUse: false };
}

/** Grow pool `key` to `count` parked instances. Returns the number of NEW
 *  instances created this call (0 when the pool is already at/above `count`) —
 *  lets the warmup pipeline skip the (expensive) prewarm prime-render entirely
 *  on a same-world next-level where nothing new was allocated. */
export function prewarmPool(scene: Scene, key: string, count: number): number {
    const factory = factories.get(key);
    if (!factory) {
        // eslint-disable-next-line no-console
        console.warn(`[meshpool] no factory registered for key "${key}"`);
        return 0;
    }
    const m = getMap(scene);
    let entry = m.get(key);
    // World swap reassigns factories.set(key, newFactory) but does not touch
    // pool entries from prior worlds (releaseWorld only flushes pools tracked
    // in pooledTypes). If user warms a pool for a level whose obstacle set
    // doesn't include this key, the entry survives with the wrong factory →
    // master/instance meshes from the previous world keep rendering. Detect
    // factory mismatch here and dispose the stale entry before recreating.
    if (entry && entry.factory !== factory) {
        releaseTypeFromPool(scene, key);
        entry = undefined;
    }
    if (!entry) {
        entry = { factory, items: [], free: [], peakInUse: 0 };
        m.set(key, entry);
    }
    // Create master once per scene for instanced pools
    if (factory.createMaster && !entry.master) {
        const masterResult = factory.createMaster(scene);
        entry.master = masterResult;
        masterResult.mesh.setEnabled(false);
        masterResult.mesh.position.y = -2000;
        for (const ex of (masterResult.extras ?? [])) {
            ex.setEnabled(false);
            ex.position.y = -2000;
        }
    }
    const need = count - entry.items.length;
    const created = Math.max(0, need);
    for (let i = 0; i < need; i++) {
        const item = buildOne(scene, entry);
        // Bounding-sphere-only culling halves frustum check cost vs the default
        // sphere+AABB combo. Acceptable here because pool meshes are simple
        // primitives (box, cylinder, cone) where the sphere overshoot is small.
        item.mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_BOUNDINGSPHERE_ONLY;
        for (const ex of item.extras) {
            ex.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_BOUNDINGSPHERE_ONLY;
        }
        parkItemOffscreen(item);
        entry.items.push(item);
        entry.free.push(item);
        prewarmBatches.get(scene)?.push(item); // D-1 A3: track for select-new prime
    }
    // Warm the shared PhysicsShape for this pool key during the loading screen
    // (D-1 stage 1): build one throwaway aggregate on a parked item and dispose
    // it immediately — the body dies, the cached shape (sharedShapes) survives,
    // so the first real spawn skips the Havok geometry build.
    if (entry.factory.buildPhysics && entry.free.length > 0) {
        const probe = entry.free.at(-1)!;
        try {
            probe.mesh.computeWorldMatrix(true);
            const agg = entry.factory.buildPhysics(probe.mesh, probe.extras, scene);
            agg?.dispose();
        } catch { /* shape warm is best-effort */ }
    }
    return created;
}

/** Park every non-in-use pooled item at HIDDEN_POSITION_Y + setEnabled(false).
 *  Called once after warmup render frame so GPU has uploaded buffers. */
export function hideAllPrewarmed(scene: Scene): void {
    const m = pools.get(scene);
    if (!m) return;
    for (const entry of m.values()) {
        for (const item of entry.items) {
            if (!item.inUse) parkItemHidden(item);
        }
    }
}

export function acquireFromPool(scene: Scene, key: string): AcquireResult | null {
    const m = getMap(scene);
    let entry = m.get(key);
    const currentFactory = factories.get(key);
    // Same world-swap mismatch guard as in prewarmPool: if the registered
    // factory for this key no longer matches the entry's snapshot, the entry
    // belongs to a previous world and must be disposed before serving items.
    if (entry && currentFactory && entry.factory !== currentFactory) {
        releaseTypeFromPool(scene, key);
        entry = undefined;
    }
    if (!entry) {
        if (!currentFactory) return null;
        entry = { factory: currentFactory, items: [], free: [], peakInUse: 0 };
        m.set(key, entry);
    }

    let item: PooledItem;
    if (entry.free.length > 0) {
        item = entry.free.pop()!;
    } else {
        // Lazy fallback — pool sized too small. Warn so we can tune.
        // eslint-disable-next-line no-console
        console.warn(`[meshpool] pool "${key}" exhausted (alive=${entry.items.length}); growing lazily — consider raising prewarm count`);
        item = buildOne(scene, entry);
        entry.items.push(item);
    }

    item.inUse = true;
    setItemEnabled(item, true);
    item.physicsAgg = null; // cleared; component calls buildPhysics after positioning

    const inUse = entry.items.length - entry.free.length;
    if (inUse > entry.peakInUse) entry.peakInUse = inUse;

    const factory = entry.factory;
    return {
        mesh: item.mesh,
        extras: item.extras,
        buildPhysics: () => {
            if (!factory.buildPhysics) return null;
            item.physicsAgg = factory.buildPhysics(item.mesh, item.extras, scene);
            return item.physicsAgg;
        },
        release: () => releaseToPool(scene, key, item),
    };
}

function releaseToPool(scene: Scene, key: string, item: PooledItem): void {
    if (!item.inUse) return; // double-release guard
    item.inUse = false;
    if (item.physicsAgg) {
        item.physicsAgg.dispose();
        item.physicsAgg = null;
    }
    parkItemHidden(item);
    const m = pools.get(scene);
    const entry = m?.get(key);
    if (entry) entry.free.push(item);
}

export function releaseTypeFromPool(scene: Scene, key: string): void {
    const m = pools.get(scene);
    const entry = m?.get(key);
    if (!entry) return;
    for (const item of entry.items) {
        disposePooledItem(entry, item, scene);
    }
    // Dispose master geometry + release materials after all instances are gone.
    disposePoolMaster(entry, scene);
    m!.delete(key);
}

function disposePooledItem(entry: PoolEntry, item: PooledItem, scene: Scene): void {
    if (item.physicsAgg) { item.physicsAgg.dispose(); item.physicsAgg = null; }
    // Full-mesh pools may provide a custom disposer; the instanced path and the
    // default full-mesh path both just dispose the extras + mesh directly
    // (instanced: material is owned by the master, so there is nothing else to release).
    if (!entry.master && entry.factory.disposeItem) {
        entry.factory.disposeItem(item, scene);
    } else {
        for (const ex of item.extras) ex.dispose();
        item.mesh.dispose();
    }
}

function disposePoolMaster(entry: PoolEntry, scene: Scene): void {
    if (!entry.master) return;
    if (entry.factory.disposeMaster) {
        entry.factory.disposeMaster(entry.master, scene);
    } else {
        for (const lod of (entry.master.lodMeshes ?? [])) lod.dispose();
        for (const ex of (entry.master.extras ?? [])) ex.dispose();
        entry.master.mesh.dispose();
    }
}

export function releaseAllPools(scene: Scene): void {
    const m = pools.get(scene);
    if (!m) return;
    for (const key of m.keys()) releaseTypeFromPool(scene, key);
}

export interface PoolStats {
    alive: number;
    free: number;
    peak: number;
}

export function getPoolStats(scene: Scene): Record<string, PoolStats> {
    const m = pools.get(scene);
    if (!m) return {};
    const out: Record<string, PoolStats> = {};
    for (const [key, entry] of m.entries()) {
        out[key] = {
            alive: entry.items.length,
            free: entry.free.length,
            peak: entry.peakInUse,
        };
    }
    return out;
}
