import { Matrix, MeshBuilder, NullEngine, Scene, StandardMaterial } from '@babylonjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createThinInstancePool } from './ThinInstancePool';

const engines: NullEngine[] = [];

function makeScene(): Scene {
    const engine = new NullEngine();
    engines.push(engine);
    return new Scene(engine);
}

afterEach(() => {
    for (const engine of engines.splice(0)) engine.dispose();
    vi.restoreAllMocks();
});

describe('ThinInstancePool lifecycle', () => {
    it('enforces capacity, reuses released slots and retains the peak', () => {
        const scene = makeScene();
        const pool = createThinInstancePool({
            scene,
            capacity: 2,
            createMaster: currentScene => MeshBuilder.CreateBox('thin-master', {}, currentScene),
        });

        expect(pool.stats()).toEqual({ alive: 0, free: 2, capacity: 2, peak: 0 });
        const first = pool.acquire();
        const second = pool.acquire();
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(pool.acquire()).toBeNull();
        expect(pool.stats()).toEqual({ alive: 2, free: 0, capacity: 2, peak: 2 });

        first!.release();
        first!.release();
        expect(pool.stats()).toEqual({ alive: 1, free: 1, capacity: 2, peak: 2 });
        expect(pool.acquire()).not.toBeNull();
        expect(pool.stats()).toEqual({ alive: 2, free: 0, capacity: 2, peak: 2 });
    });

    it('batches matrix updates into one GPU buffer notification per flush', () => {
        const scene = makeScene();
        let master = MeshBuilder.CreateBox('thin-batch-master', {}, scene);
        const pool = createThinInstancePool({
            scene,
            capacity: 2,
            createMaster: () => master,
        });
        const updated = vi.spyOn(master, 'thinInstanceBufferUpdated');
        const first = pool.acquire()!;
        const second = pool.acquire()!;

        first.setMatrix(Matrix.Translation(1, 2, 3));
        second.setMatrix(Matrix.Translation(4, 5, 6));
        pool.flush();
        pool.flush();
        expect(updated).toHaveBeenCalledOnce();

        first.setEnabled(false);
        first.release();
        first.setMatrix(Matrix.Translation(7, 8, 9));
        pool.flush();
        expect(updated).toHaveBeenCalledTimes(2);
        expect(pool.stats().alive).toBe(1);
    });

    it('disposes owned materials but leaves shared materials alive', () => {
        const sharedScene = makeScene();
        const sharedMaterial = new StandardMaterial('shared', sharedScene);
        const sharedDispose = vi.spyOn(sharedMaterial, 'dispose');
        const sharedMaster = MeshBuilder.CreateBox('shared-master', {}, sharedScene);
        sharedMaster.material = sharedMaterial;
        const sharedPool = createThinInstancePool({
            scene: sharedScene,
            capacity: 1,
            createMaster: () => sharedMaster,
        });
        sharedPool.dispose();
        sharedPool.dispose();
        expect(sharedMaster.isDisposed()).toBe(true);
        expect(sharedDispose).not.toHaveBeenCalled();
        expect(sharedPool.acquire()).toBeNull();

        const ownedScene = makeScene();
        const ownedMaterial = new StandardMaterial('owned', ownedScene);
        const ownedDispose = vi.spyOn(ownedMaterial, 'dispose');
        const ownedMaster = MeshBuilder.CreateBox('owned-master', {}, ownedScene);
        ownedMaster.material = ownedMaterial;
        const ownedPool = createThinInstancePool({
            scene: ownedScene,
            capacity: 1,
            createMaster: () => ownedMaster,
            ownsMaterial: true,
        });
        ownedPool.dispose();
        expect(ownedMaster.isDisposed()).toBe(true);
        expect(ownedDispose).toHaveBeenCalledOnce();
    });

    it('rejects non-positive capacities before allocating a master', () => {
        const scene = makeScene();
        const createMaster = vi.fn(() => MeshBuilder.CreateBox('invalid', {}, scene));
        expect(() => createThinInstancePool({ scene, capacity: 0, createMaster })).toThrow(/capacity/);
        expect(createMaster).not.toHaveBeenCalled();
    });
});
