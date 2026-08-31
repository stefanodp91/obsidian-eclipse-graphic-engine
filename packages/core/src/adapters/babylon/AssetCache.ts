// 3-tier asset cache: global / world / level.
// - Global: full app session (shared shaders, common meshes).
// - World: one world context; disposed on world swap.
// - Level: thin; reuses global/world entries.
// LRU eviction fires when estimated heap exceeds the configured threshold.

type AssetTier = 'global' | 'world' | 'level';

interface CacheEntry<T> {
    value: T;
    lastUsed: number;
    refCount: number;
    tier: AssetTier;
    disposeCallback: (() => void) | undefined;
}

const GLOBAL_REF_SENTINEL = Infinity;

export class AssetCache {
    private readonly entries = new Map<string, CacheEntry<unknown>>();
    private readonly evictThresholdMb: number;

    constructor(evictThresholdMb = 200) {
        this.evictThresholdMb = evictThresholdMb;
    }

    /** Register an asset (idempotent — returns existing if key already present). */
    set<T>(key: string, value: T, tier: AssetTier, disposeCallback?: () => void): T {
        if (this.entries.has(key)) return this.get<T>(key)!;
        this.entries.set(key, {
            value,
            lastUsed: Date.now(),
            refCount: tier === 'global' ? GLOBAL_REF_SENTINEL : 1,
            tier,
            disposeCallback,
        });
        return value;
    }

    has(key: string): boolean {
        return this.entries.has(key);
    }

    get<T>(key: string): T | null {
        const e = this.entries.get(key);
        if (!e) return null;
        e.lastUsed = Date.now();
        return e.value as T;
    }

    acquire(key: string): boolean {
        const e = this.entries.get(key);
        if (!e) return false;
        if (e.refCount !== GLOBAL_REF_SENTINEL) e.refCount++;
        return true;
    }

    release(key: string): void {
        const e = this.entries.get(key);
        if (!e) return;
        if (e.refCount === GLOBAL_REF_SENTINEL) return;
        e.refCount--;
        if (e.refCount <= 0) {
            e.disposeCallback?.();
            this.entries.delete(key);
        }
    }

    clearTier(tier: AssetTier): void {
        for (const [key, entry] of this.entries) {
            if (entry.tier === tier) {
                entry.disposeCallback?.();
                this.entries.delete(key);
            }
        }
    }

    /** LRU eviction: dispose oldest non-global entries until below threshold.
     *  Caller must supply current estimated heap in MB. */
    evictIfNeeded(estimatedCurrentMb: number): void {
        if (estimatedCurrentMb <= this.evictThresholdMb) return;
        const evictable = [...this.entries.entries()]
            .filter(([, e]) => e.tier !== 'global' && e.refCount <= 1)
            .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
        for (const [key, entry] of evictable) {
            entry.disposeCallback?.();
            this.entries.delete(key);
            estimatedCurrentMb -= 0.5;
            if (estimatedCurrentMb <= this.evictThresholdMb * 0.8) break;
        }
    }

    get size(): number {
        return this.entries.size;
    }

    disposeAll(): void {
        for (const entry of this.entries.values()) entry.disposeCallback?.();
        this.entries.clear();
    }
}
