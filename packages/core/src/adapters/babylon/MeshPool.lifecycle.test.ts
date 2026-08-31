import { MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    acquireFromPool,
    beginPrewarmBatch,
    getPoolStats,
    hideAllPrewarmed,
    prewarmPool,
    registerPoolType,
    releaseAllPools,
    resetPrewarmSelect,
    selectNewlyPrewarmedForRender,
} from './MeshPool';

const ownedScenes: Scene[] = [];
let keySerial = 0;

function makeScene(): Scene {
    const scene = new Scene(new NullEngine());
    ownedScenes.push(scene);
    return scene;
}

function uniqueKey(label: string): string {
    return `test-${label}-${keySerial++}`;
}

afterEach(() => {
    for (const scene of ownedScenes.splice(0)) {
        releaseAllPools(scene);
        scene.getEngine().dispose();
    }
    vi.restoreAllMocks();
});

describe('MeshPool lifecycle', () => {
    it('prewarms once, tracks the current batch and reuses released items', () => {
        const scene = makeScene();
        const key = uniqueKey('reuse');
        registerPoolType(key, {
            create: currentScene => ({ mesh: MeshBuilder.CreateBox(key, {}, currentScene) }),
        });

        beginPrewarmBatch(scene);
        expect(prewarmPool(scene, key, 2)).toBe(2);
        expect(prewarmPool(scene, key, 2)).toBe(0);
        expect(selectNewlyPrewarmedForRender(scene)).toBe(2);
        expect(scene.meshes.every(mesh => mesh.alwaysSelectAsActiveMesh)).toBe(true);
        resetPrewarmSelect(scene);
        expect(scene.meshes.every(mesh => !mesh.alwaysSelectAsActiveMesh)).toBe(true);

        hideAllPrewarmed(scene);
        const first = acquireFromPool(scene, key);
        expect(first).not.toBeNull();
        expect(first!.mesh.isEnabled()).toBe(true);
        expect(getPoolStats(scene)[key]).toEqual({ alive: 2, free: 1, peak: 1 });

        first!.release();
        first!.release();
        expect(first!.mesh.isEnabled()).toBe(false);
        expect(first!.mesh.position.y).toBe(-1000);
        expect(getPoolStats(scene)[key]).toEqual({ alive: 2, free: 2, peak: 1 });

        expect(acquireFromPool(scene, key)!.mesh).toBe(first!.mesh);
    });

    it('isolates pools belonging to different scenes', () => {
        const firstScene = makeScene();
        const secondScene = makeScene();
        const key = uniqueKey('scene-isolation');
        registerPoolType(key, {
            create: currentScene => ({ mesh: MeshBuilder.CreateSphere(key, {}, currentScene) }),
        });

        prewarmPool(firstScene, key, 1);
        prewarmPool(secondScene, key, 2);
        const firstItem = acquireFromPool(firstScene, key)!;

        expect(firstItem.mesh.getScene()).toBe(firstScene);
        expect(getPoolStats(firstScene)[key]).toEqual({ alive: 1, free: 0, peak: 1 });
        expect(getPoolStats(secondScene)[key]).toEqual({ alive: 2, free: 2, peak: 0 });

        releaseAllPools(firstScene);
        expect(getPoolStats(firstScene)).toEqual({});
        expect(getPoolStats(secondScene)[key]).toEqual({ alive: 2, free: 2, peak: 0 });
    });

    it('disposes pooled meshes, extras and live physics exactly once on teardown', () => {
        const scene = makeScene();
        const key = uniqueKey('dispose');
        const probeDispose = vi.fn();
        const liveDispose = vi.fn();
        let physicsBuilds = 0;
        registerPoolType(key, {
            create: currentScene => ({
                mesh: MeshBuilder.CreateBox(`${key}-main`, {}, currentScene),
                extras: [MeshBuilder.CreateBox(`${key}-extra`, {}, currentScene)],
            }),
            buildPhysics: () => ({
                dispose: physicsBuilds++ === 0 ? probeDispose : liveDispose,
            }) as never,
        });
        prewarmPool(scene, key, 1);
        expect(probeDispose).toHaveBeenCalledOnce();
        expect(liveDispose).not.toHaveBeenCalled();
        const acquired = acquireFromPool(scene, key)!;
        const main = acquired.mesh;
        const extra = acquired.extras[0]!;
        acquired.buildPhysics();

        releaseAllPools(scene);
        releaseAllPools(scene);

        expect(probeDispose).toHaveBeenCalledOnce();
        expect(liveDispose).toHaveBeenCalledOnce();
        expect(main.isDisposed()).toBe(true);
        expect(extra.isDisposed()).toBe(true);
        expect(getPoolStats(scene)).toEqual({});
    });

    it('replaces stale scene entries when a key is registered with a new factory', () => {
        const scene = makeScene();
        const key = uniqueKey('factory-swap');
        registerPoolType(key, {
            create: currentScene => ({ mesh: MeshBuilder.CreateBox('old', {}, currentScene) }),
        });
        prewarmPool(scene, key, 1);
        const oldMesh = scene.getMeshByName('old')!;

        registerPoolType(key, {
            create: currentScene => ({ mesh: MeshBuilder.CreateSphere('new', {}, currentScene) }),
        });
        expect(prewarmPool(scene, key, 1)).toBe(1);

        expect(oldMesh.isDisposed()).toBe(true);
        expect(scene.getMeshByName('new')).not.toBeNull();
        expect(getPoolStats(scene)[key]).toEqual({ alive: 1, free: 1, peak: 0 });
    });
});
