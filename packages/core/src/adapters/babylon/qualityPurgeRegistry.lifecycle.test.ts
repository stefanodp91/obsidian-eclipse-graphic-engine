import type { Scene } from '@babylonjs/core';
import { describe, expect, it, vi } from 'vitest';
import {
    purgeAllSceneCaches,
    registerScenePurge,
    registeredPurgerCount,
} from './qualityPurgeRegistry';

const fakeScene = (): Scene => ({ materials: [], textures: [] }) as unknown as Scene;

describe('quality purge registry lifecycle', () => {
    it('registers, invokes and deregisters a purger idempotently', () => {
        const baseline = registeredPurgerCount();
        const purge = vi.fn();
        const deregister = registerScenePurge('test-idempotent', purge);
        expect(registeredPurgerCount()).toBe(baseline + 1);

        const scene = fakeScene();
        purgeAllSceneCaches(scene);
        expect(purge).toHaveBeenCalledExactlyOnceWith(scene);

        deregister();
        deregister();
        expect(registeredPurgerCount()).toBe(baseline);
        purgeAllSceneCaches(scene);
        expect(purge).toHaveBeenCalledOnce();
    });

    it('isolates failures so later purgers still run', () => {
        const order: string[] = [];
        const removeThrowing = registerScenePurge('test-throwing', () => {
            order.push('throwing');
            throw new Error('expected contract probe');
        });
        const removeHealthy = registerScenePurge('test-healthy', () => {
            order.push('healthy');
        });

        try {
            expect(() => purgeAllSceneCaches(fakeScene())).not.toThrow();
            expect(order).toEqual(['throwing', 'healthy']);
        } finally {
            removeThrowing();
            removeHealthy();
        }
    });
});
