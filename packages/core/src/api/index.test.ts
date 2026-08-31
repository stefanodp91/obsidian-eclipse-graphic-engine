import { describe, expect, it, vi } from 'vitest';
import { EnginePhase } from '../domain';
import type { GraphicEngine } from '../ports/driving';
import { createGraphicEngine, type CreateGraphicEngineOptions } from './index';

const graphicEngineResources = {
    phase: true,
    tier: true,
    quality: true,
    frame: true,
    assets: true,
    materials: true,
    pools: true,
    input: true,
    dispose: true,
} satisfies Record<keyof GraphicEngine, true>;

const phaseApi = { transition: true, get: true, subscribe: true } satisfies Record<keyof GraphicEngine['phase'], true>;
const tierApi = { get: true, subscribe: true } satisfies Record<keyof GraphicEngine['tier'], true>;
const qualityApi = { get: true, update: true, subscribe: true } satisfies Record<keyof GraphicEngine['quality'], true>;
const frameApi = { add: true } satisfies Record<keyof GraphicEngine['frame'], true>;
const assetsApi = { set: true, get: true, acquire: true, release: true, clearTier: true, has: true, size: true } satisfies Record<keyof GraphicEngine['assets'], true>;
const materialsApi = { acquire: true, acquireTiered: true, release: true } satisfies Record<keyof GraphicEngine['materials'], true>;
const poolsApi = { register: true, acquire: true, releaseType: true, prewarm: true } satisfies Record<keyof GraphicEngine['pools'], true>;
const inputApi = { attach: true, lateral: true, consumeJump: true } satisfies Record<keyof GraphicEngine['input'], true>;

const baseOptions = (): CreateGraphicEngineOptions => ({
    keyPrefix: 'test',
    rendering: { scene: {} },
    quality: {
        get: () => 'mobile-mid',
        update: () => true,
        subscribe: () => () => {},
    },
});

describe('createGraphicEngine', () => {
    it('rejects incomplete adoption configuration', () => {
        expect(() => createGraphicEngine({ ...baseOptions(), keyPrefix: '' })).toThrow(/keyPrefix/);
        expect(() => createGraphicEngine({ ...baseOptions(), rendering: { scene: null as unknown as object } })).toThrow(/rendering\.scene/);
    });

    it('provides safe defaults for optional ports', () => {
        const engine = createGraphicEngine(baseOptions());
        expect(engine.phase.get()).toBeNull();
        expect(engine.tier.get()).toBeNull();
        expect(engine.assets.get('missing')).toBeNull();
        expect(engine.assets.size).toBe(0);
        expect(engine.input.lateral).toBe(0);
        expect(engine.input.consumeJump()).toBe(false);
    });

    it('delegates writes and disposes exactly once', () => {
        const transition = vi.fn();
        const update = vi.fn(() => true);
        const onDispose = vi.fn();
        const engine = createGraphicEngine({
            ...baseOptions(),
            phase: transition,
            quality: { ...baseOptions().quality, update },
            onDispose,
        });

        engine.phase.transition(EnginePhase.Active);
        expect(transition).toHaveBeenCalledWith(EnginePhase.Active);
        expect(engine.quality.update('mobile-low')).toBe(true);
        expect(update).toHaveBeenCalledWith('mobile-low', null);

        engine.dispose();
        engine.dispose();
        expect(onDispose).toHaveBeenCalledTimes(1);
        expect(() => engine.phase.transition(EnginePhase.Halted)).toThrow(/already disposed/);
        expect(engine.quality.get()).toBe('mobile-mid');
    });

    it('exercises the complete public GraphicEngine API surface', () => {
        const phase = { get: vi.fn(() => EnginePhase.Active), subscribe: vi.fn(() => () => {}) };
        const tierValue = {
            preset: 'mobile-mid', reason: 'static-tier', baseTier: 'mid', effectiveTier: 'mid',
            renderScaleOverride: null, probedMedianMs: null,
        } as const;
        const tier = { get: vi.fn(() => tierValue), subscribe: vi.fn(() => () => {}) };
        const quality = {
            get: vi.fn(() => 'mobile-mid' as const),
            update: vi.fn(() => true),
            subscribe: vi.fn(() => () => {}),
        };
        const frame = { add: vi.fn(() => () => {}) };
        const assets = {
            set: vi.fn(<T>(_key: string, value: T): T => value),
            get: vi.fn(<T>(): T | null => ({ cached: true }) as T),
            acquire: vi.fn(() => true),
            release: vi.fn(),
            clearTier: vi.fn(),
            has: vi.fn(() => true),
            size: 1,
        } as unknown as NonNullable<CreateGraphicEngineOptions['assets']>;
        const materials = {
            acquire: vi.fn(<M>(_key: string, factory: (material: M) => void): M => {
                const material = {} as M;
                factory(material);
                return material;
            }),
            acquireTiered: vi.fn(<S, P>(_key: string, standard: (material: S) => void): S | P => {
                const material = {} as S;
                standard(material);
                return material;
            }),
            release: vi.fn(),
        } as unknown as NonNullable<CreateGraphicEngineOptions['materials']>;
        const pools = {
            register: vi.fn(),
            acquire: vi.fn(<R>(): R | null => ({ pooled: true }) as R),
            releaseType: vi.fn(),
            prewarm: vi.fn(),
        } as unknown as NonNullable<CreateGraphicEngineOptions['pools']>;
        const input = {
            attach: vi.fn(() => () => {}),
            lateral: 0.5,
            consumeJump: vi.fn(() => true),
        };
        const transition = vi.fn();
        const onDispose = vi.fn();
        const engine = createGraphicEngine({
            ...baseOptions(), phase: transition, phaseSource: phase, tier, quality, frame,
            assets, materials, pools, input, onDispose,
        });

        expect(Object.keys(engine).sort()).toEqual(Object.keys(graphicEngineResources).sort());
        expect(Object.keys(engine.phase).sort()).toEqual(Object.keys(phaseApi).sort());
        expect(Object.keys(engine.tier).sort()).toEqual(Object.keys(tierApi).sort());
        expect(Object.keys(engine.quality).sort()).toEqual(Object.keys(qualityApi).sort());
        expect(Object.keys(engine.frame).sort()).toEqual(Object.keys(frameApi).sort());
        expect(Object.keys(engine.assets).sort()).toEqual(Object.keys(assetsApi).sort());
        expect(Object.keys(engine.materials).sort()).toEqual(Object.keys(materialsApi).sort());
        expect(Object.keys(engine.pools).sort()).toEqual(Object.keys(poolsApi).sort());
        expect(Object.keys(engine.input).sort()).toEqual(Object.keys(inputApi).sort());

        const unsubscribers = [
            engine.phase.subscribe(() => {}),
            engine.tier.subscribe(() => {}),
            engine.quality.subscribe(() => {}),
            engine.frame.add(() => {}, 10),
            engine.input.attach({}),
        ];
        engine.phase.transition(EnginePhase.Reduced);
        expect(engine.phase.get()).toBe(EnginePhase.Active);
        expect(engine.tier.get()).toEqual(tierValue);
        expect(engine.quality.get()).toBe('mobile-mid');
        expect(engine.quality.update('mobile-low', null)).toBe(true);
        expect(engine.assets.set('asset', 42, 'level')).toBe(42);
        expect(engine.assets.get('asset')).toEqual({ cached: true });
        expect(engine.assets.acquire('asset')).toBe(true);
        engine.assets.release('asset');
        engine.assets.clearTier('level');
        expect(engine.assets.has('asset')).toBe(true);
        expect(engine.assets.size).toBe(1);
        expect(engine.materials.acquire('material', () => {})).not.toBeNull();
        expect(engine.materials.acquireTiered('material', () => {}, () => {})).not.toBeNull();
        engine.materials.release('material');
        engine.pools.register('pool', {});
        expect(engine.pools.acquire('pool')).toEqual({ pooled: true });
        engine.pools.releaseType('pool');
        engine.pools.prewarm('pool', 2);
        expect(engine.input.lateral).toBe(0.5);
        expect(engine.input.consumeJump()).toBe(true);
        for (const unsubscribe of unsubscribers) unsubscribe();
        engine.dispose();

        expect(transition).toHaveBeenCalledOnce();
        expect(onDispose).toHaveBeenCalledOnce();
        expect(frame.add).toHaveBeenCalledOnce();
        expect(materials.acquireTiered).toHaveBeenCalledOnce();
        expect(pools.prewarm).toHaveBeenCalledWith('pool', 2);
    });
});
