import { describe, expect, it, vi } from 'vitest';
import { AssetCache } from './AssetCache';

describe('AssetCache lifecycle', () => {
    it('keeps cache instances isolated even when keys collide', () => {
        const first = new AssetCache();
        const second = new AssetCache();

        first.set('shared-key', { owner: 'first' }, 'world');
        second.set('shared-key', { owner: 'second' }, 'world');

        expect(first.get<{ owner: string }>('shared-key')).toEqual({ owner: 'first' });
        expect(second.get<{ owner: string }>('shared-key')).toEqual({ owner: 'second' });

        first.release('shared-key');
        expect(first.has('shared-key')).toBe(false);
        expect(second.has('shared-key')).toBe(true);
    });

    it('is idempotent on set and disposes the retained value exactly once', () => {
        const cache = new AssetCache();
        const disposeRetained = vi.fn();
        const disposeRejected = vi.fn();
        const retained = { id: 1 };

        expect(cache.set('asset', retained, 'level', disposeRetained)).toBe(retained);
        expect(cache.set('asset', { id: 2 }, 'level', disposeRejected)).toBe(retained);
        expect(cache.size).toBe(1);

        cache.release('asset');
        cache.release('asset');
        expect(disposeRetained).toHaveBeenCalledOnce();
        expect(disposeRejected).not.toHaveBeenCalled();
    });

    it('honours reference counts while global entries survive release', () => {
        const cache = new AssetCache();
        const disposeWorld = vi.fn();
        const disposeGlobal = vi.fn();
        cache.set('world', {}, 'world', disposeWorld);
        cache.set('global', {}, 'global', disposeGlobal);

        expect(cache.acquire('world')).toBe(true);
        cache.release('world');
        expect(cache.has('world')).toBe(true);
        cache.release('world');
        expect(cache.has('world')).toBe(false);
        expect(disposeWorld).toHaveBeenCalledOnce();

        cache.release('global');
        expect(cache.has('global')).toBe(true);
        expect(disposeGlobal).not.toHaveBeenCalled();
    });

    it('clears only the requested tier and disposeAll drains the remainder', () => {
        const cache = new AssetCache();
        const disposeGlobal = vi.fn();
        const disposeWorld = vi.fn();
        const disposeLevel = vi.fn();
        cache.set('global', {}, 'global', disposeGlobal);
        cache.set('world', {}, 'world', disposeWorld);
        cache.set('level', {}, 'level', disposeLevel);

        cache.clearTier('level');
        expect(cache.has('level')).toBe(false);
        expect(cache.has('world')).toBe(true);
        expect(cache.has('global')).toBe(true);
        expect(disposeLevel).toHaveBeenCalledOnce();

        cache.disposeAll();
        cache.disposeAll();
        expect(cache.size).toBe(0);
        expect(disposeWorld).toHaveBeenCalledOnce();
        expect(disposeGlobal).toHaveBeenCalledOnce();
        expect(disposeLevel).toHaveBeenCalledOnce();
    });

    it('evicts only releasable non-global entries above the memory threshold', () => {
        const cache = new AssetCache(1);
        const disposeEvictable = vi.fn();
        const disposeHeld = vi.fn();
        const disposeGlobal = vi.fn();
        cache.set('evictable', {}, 'level', disposeEvictable);
        cache.set('held', {}, 'world', disposeHeld);
        cache.acquire('held');
        cache.set('global', {}, 'global', disposeGlobal);

        cache.evictIfNeeded(2);

        expect(cache.has('evictable')).toBe(false);
        expect(disposeEvictable).toHaveBeenCalledOnce();
        expect(cache.has('held')).toBe(true);
        expect(cache.has('global')).toBe(true);
        expect(disposeHeld).not.toHaveBeenCalled();
        expect(disposeGlobal).not.toHaveBeenCalled();
    });
});
