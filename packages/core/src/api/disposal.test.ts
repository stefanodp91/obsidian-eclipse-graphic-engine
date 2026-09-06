import { describe, expect, it, vi } from 'vitest';
import { EnginePhase } from '../domain';
import type { GraphicEngine } from '../ports/driving';
import { createGraphicEngine, type CreateGraphicEngineOptions } from './index';

const writes: [string, (engine: GraphicEngine) => unknown][] = [
    ['phase.transition', (engine) => engine.phase.transition(EnginePhase.Active)],
    ['quality.update', (engine) => engine.quality.update('mobile-low')],
    ['frame.add', (engine) => engine.frame.add(() => {})],
    ['assets.set', (engine) => engine.assets.set('asset', 42, 'level')],
    ['assets.acquire', (engine) => engine.assets.acquire('asset')],
    ['assets.release', (engine) => engine.assets.release('asset')],
    ['assets.clearTier', (engine) => engine.assets.clearTier('level')],
    ['materials.acquire', (engine) => engine.materials.acquire('material', () => {})],
    ['materials.acquireTiered', (engine) => engine.materials.acquireTiered('material', () => {}, () => {})],
    ['materials.release', (engine) => engine.materials.release('material')],
    ['pools.register', (engine) => engine.pools.register('pool', {})],
    ['pools.acquire', (engine) => engine.pools.acquire('pool')],
    ['pools.releaseType', (engine) => engine.pools.releaseType('pool')],
    ['pools.prewarm', (engine) => engine.pools.prewarm('pool', 2)],
    ['input.attach', (engine) => engine.input.attach({})],
    ['input.consumeJump', (engine) => engine.input.consumeJump()],
];

function fixture(wired: boolean) {
    const write = vi.fn();
    const unsubscribe = vi.fn();
    const options: CreateGraphicEngineOptions = {
        keyPrefix: 'disposal-test',
        rendering: { scene: {} },
        quality: {
            get: () => 'mobile-mid',
            update: () => { write(); return true; },
            subscribe: () => unsubscribe,
        },
    };
    if (wired) {
        Object.assign(options, {
            phase: write,
            phaseSource: { get: () => EnginePhase.Halted, subscribe: () => unsubscribe },
            tier: { get: () => null, subscribe: () => unsubscribe },
            frame: { add: () => { write(); return unsubscribe; } },
            assets: {
                set: <T>(_key: string, value: T): T => { write(); return value; },
                get: <T>(): T | null => null,
                acquire: () => { write(); return true; },
                release: write,
                clearTier: write,
                has: () => false,
                size: 0,
            },
            materials: {
                acquire: <M>(): M => { write(); return {} as M; },
                acquireTiered: <S, P>(): S | P => { write(); return {} as S; },
                release: write,
            },
            pools: {
                register: write,
                acquire: <R>(): R | null => { write(); return null; },
                releaseType: write,
                prewarm: write,
            },
            input: {
                attach: () => { write(); return unsubscribe; },
                lateral: 0.5,
                consumeJump: () => { write(); return true; },
            },
        } satisfies Partial<CreateGraphicEngineOptions>);
    }
    return { options, write, unsubscribe };
}

describe.each([true, false])('facade disposal (optional ports wired: %s)', (wired) => {
    it.each(writes)('rejects %s after disposal without reaching the host', (_name, invoke) => {
        const { options, write } = fixture(wired);
        const engine = createGraphicEngine(options);
        expect(() => invoke(engine)).not.toThrow();
        if (wired) expect(write).toHaveBeenCalledOnce();
        engine.dispose();
        write.mockClear();

        expect(() => invoke(engine)).toThrow(/engine already disposed/);
        expect(write).not.toHaveBeenCalled();
    });

    it('keeps reads, subscriptions and previously returned cleanup functions callable', () => {
        const { options, write, unsubscribe } = fixture(wired);
        const engine = createGraphicEngine(options);
        const cleanup = [engine.frame.add(() => {}), engine.input.attach({})];
        engine.dispose();
        write.mockClear();

        expect(engine.phase.get()).toBe(wired ? EnginePhase.Halted : null);
        expect(engine.tier.get()).toBeNull();
        expect(engine.quality.get()).toBe('mobile-mid');
        expect(engine.assets.get('asset')).toBeNull();
        expect(engine.assets.has('asset')).toBe(false);
        expect(engine.assets.size).toBe(0);
        expect(engine.input.lateral).toBe(wired ? 0.5 : 0);
        cleanup.push(engine.phase.subscribe(() => {}), engine.tier.subscribe(() => {}),
            engine.quality.subscribe(() => {}));
        cleanup.forEach((stop) => stop());
        expect(unsubscribe).toHaveBeenCalledTimes(wired ? 5 : 1);
        expect(write).not.toHaveBeenCalled();
    });
});

it('marks the facade disposed before host cleanup, even when cleanup fails', () => {
    const { options, write } = fixture(true);
    const error = new Error('host cleanup failed');
    const onDispose = vi.fn(() => {
        expect(() => engine.assets.set('late', {}, 'level')).toThrow(/already disposed/);
        engine.dispose();
        throw error;
    });
    const engine = createGraphicEngine({ ...options, onDispose });
    expect(() => engine.dispose()).toThrow(error);
    expect(() => engine.dispose()).not.toThrow();
    expect(onDispose).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
});
