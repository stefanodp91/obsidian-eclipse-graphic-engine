import { describe, expect, it } from 'vitest';
import { createEngineHandles, engineHandles } from './engineHandles';

describe('engine handle ownership', () => {
    it('creates independent per-engine bags without aliasing the compatibility singleton', () => {
        const first = createEngineHandles();
        const second = createEngineHandles();
        first.applyRefreshPref = () => {};
        expect(first).not.toBe(second);
        expect(first).not.toBe(engineHandles);
        expect(second.applyRefreshPref).toBeNull();
        expect(engineHandles.applyRefreshPref).toBeNull();
    });
});
