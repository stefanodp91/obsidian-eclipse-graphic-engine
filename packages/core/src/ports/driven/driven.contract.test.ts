import { describe, expect, it, vi } from 'vitest';
import type {
    AsyncKeyValueStorage,
    Clock,
    InputSource,
    KeyValueStorage,
    NativeServices,
    PhysicsBackend,
    RefreshMode,
    RenderingBackend,
    ThermalState,
} from './index';

class MemoryStorage implements KeyValueStorage {
    private readonly values = new Map<string, string>();

    get(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    set(key: string, value: string): void {
        this.values.set(key, value);
    }

    remove(key: string): void {
        this.values.delete(key);
    }
}

class AsyncMemoryStorage implements AsyncKeyValueStorage {
    private readonly delegate = new MemoryStorage();

    async get(key: string): Promise<string | null> {
        return this.delegate.get(key);
    }

    async set(key: string, value: string): Promise<void> {
        this.delegate.set(key, value);
    }

    async remove(key: string): Promise<void> {
        this.delegate.remove(key);
    }
}

class DeterministicClock implements Clock {
    fixedDeltaMs: number | null = null;

    constructor(private measuredDeltaMs: number) {}

    deltaMs(): number {
        return this.fixedDeltaMs ?? this.measuredDeltaMs;
    }

    measure(deltaMs: number): void {
        this.measuredDeltaMs = deltaMs;
    }
}

class QueuedInput implements InputSource {
    lateral = 0;
    private jumpCount = 0;
    private attachedTarget: unknown = null;

    attach(target: unknown): () => void {
        this.attachedTarget = target;
        let attached = true;
        return () => {
            if (!attached) return;
            attached = false;
            this.attachedTarget = null;
        };
    }

    queueJump(): void {
        this.jumpCount++;
    }

    consumeJump(): boolean {
        if (this.jumpCount === 0) return false;
        this.jumpCount--;
        return true;
    }

    get target(): unknown {
        return this.attachedTarget;
    }
}

class WebNativeServices implements NativeServices {
    readonly isNative = false;
    readonly isAndroid = false;
    readonly prefs: AsyncKeyValueStorage = new AsyncMemoryStorage();
    private readonly thermalListeners = new Set<(state: ThermalState) => void>();

    async readBattery(): Promise<null> { return null; }
    async setRefreshMode(_mode: RefreshMode): Promise<boolean> { return false; }
    async getRefreshInfo(): Promise<null> { return null; }
    async readThermalState(): Promise<ThermalState> { return 'nominal'; }
    async readThermalHeadroom(_forecastSeconds?: number): Promise<null> { return null; }
    async requestWakeLock(): Promise<void> {}
    async releaseWakeLock(): Promise<void> {}

    onThermalStateChange(fn: (state: ThermalState) => void): () => void {
        this.thermalListeners.add(fn);
        return () => this.thermalListeners.delete(fn);
    }

    emitThermal(state: ThermalState): void {
        for (const listener of this.thermalListeners) listener(state);
    }
}

describe('driven port contracts', () => {
    it('keeps synchronous storage missing-value, overwrite and remove semantics', () => {
        const storage: KeyValueStorage = new MemoryStorage();
        expect(storage.get('missing')).toBeNull();
        storage.set('key', 'first');
        storage.set('key', 'second');
        expect(storage.get('key')).toBe('second');
        storage.remove('key');
        storage.remove('key');
        expect(storage.get('key')).toBeNull();
    });

    it('keeps asynchronous storage semantically equivalent to synchronous storage', async () => {
        const storage: AsyncKeyValueStorage = new AsyncMemoryStorage();
        expect(await storage.get('missing')).toBeNull();
        await storage.set('key', 'first');
        await storage.set('key', 'second');
        expect(await storage.get('key')).toBe('second');
        await storage.remove('key');
        await storage.remove('key');
        expect(await storage.get('key')).toBeNull();
    });

    it('lets deterministic fixed delta override measurements until released', () => {
        const clock: Clock & { measure(deltaMs: number): void } = new DeterministicClock(16);
        expect(clock.deltaMs()).toBe(16);
        clock.fixedDeltaMs = 20;
        clock.measure(8);
        expect(clock.deltaMs()).toBe(20);
        clock.fixedDeltaMs = null;
        expect(clock.deltaMs()).toBe(8);
    });

    it('queues discrete jumps and detaches input idempotently', () => {
        const input = new QueuedInput();
        const target = {};
        const detach = input.attach(target);
        input.lateral = -0.75;
        input.queueJump();
        input.queueJump();

        expect(input.target).toBe(target);
        expect(input.lateral).toBe(-0.75);
        expect(input.consumeJump()).toBe(true);
        expect(input.consumeJump()).toBe(true);
        expect(input.consumeJump()).toBe(false);

        detach();
        detach();
        expect(input.target).toBeNull();
    });

    it('defines safe web-native null behavior and detachable thermal subscriptions', async () => {
        const native = new WebNativeServices();
        const listener = vi.fn();
        const unsubscribe = native.onThermalStateChange(listener);

        expect(native.isNative).toBe(false);
        expect(native.isAndroid).toBe(false);
        expect(await native.readBattery()).toBeNull();
        expect(await native.setRefreshMode('60')).toBe(false);
        expect(await native.getRefreshInfo()).toBeNull();
        expect(await native.readThermalState()).toBe('nominal');
        expect(await native.readThermalHeadroom(10)).toBeNull();

        native.emitThermal('serious');
        unsubscribe();
        unsubscribe();
        native.emitThermal('critical');
        expect(listener).toHaveBeenCalledExactlyOnceWith('serious');
    });

    it('keeps rendering and physics lifecycle calls explicit at the boundary', () => {
        const setGating = vi.fn();
        const setStepRateHz = vi.fn();
        const disposeRendering = vi.fn();
        const disposePhysics = vi.fn();
        const rendering: RenderingBackend = { setGating, dispose: disposeRendering };
        const physics: PhysicsBackend = { setStepRateHz, dispose: disposePhysics };

        rendering.setGating(true, false);
        physics.setStepRateHz(60);
        rendering.dispose();
        physics.dispose();

        expect(setGating).toHaveBeenCalledExactlyOnceWith(true, false);
        expect(setStepRateHz).toHaveBeenCalledExactlyOnceWith(60);
        expect(disposeRendering).toHaveBeenCalledOnce();
        expect(disposePhysics).toHaveBeenCalledOnce();
    });
});
