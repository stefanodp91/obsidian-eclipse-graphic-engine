import { afterEach, describe, expect, it, vi } from 'vitest';
import { computePhysicsStepHz } from './computePhysicsStepHz';
import {
    BOOT_PROBE_MEASURE_FRAMES,
    BOOT_PROBE_PESSIMISM,
    LOD_DOWNGRADE_LO_RATIO,
    LOD_DOWNGRADE_MID_RATIO,
    MAX_DELTA_SUBSTEPS,
    PROBE_SKIP_FRAMES,
    PROBE_TIER_THRESHOLD_HI,
    PROBE_TIER_THRESHOLD_MID,
    WARMUP_PROBE_MEASURE_FRAMES,
} from './constants';
import { createEngineRuntimeConfig, getEngineIsDev, initEngine } from './engineConfig';
import { createEngineProfileRegistry, configureEngineProfileProvider, getActiveEngineProfile } from './engineProfile';
import { applyTerrainPose, clamp, lerp, randomInRange, toRadians } from './math';
import { fbm, valueNoise3 } from './proceduralNoise';
import { createSignal } from './signal';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('physics step policy', () => {
    it('caps an unverified display at 60 Hz', () => {
        expect(computePhysicsStepHz(120, false)).toBe(60);
        expect(computePhysicsStepHz(90, false)).toBe(60);
        expect(computePhysicsStepHz(60, false)).toBe(60);
        expect(computePhysicsStepHz(30, false)).toBe(30);
    });

    it('preserves the profile rate after high refresh was verified', () => {
        expect(computePhysicsStepHz(90, true)).toBe(90);
        expect(computePhysicsStepHz(120, true)).toBe(120);
    });
});

describe('pure math', () => {
    it('interpolates endpoints and deliberately permits extrapolation', () => {
        expect(lerp(10, 20, 0)).toBe(10);
        expect(lerp(10, 20, 1)).toBe(20);
        expect(lerp(10, 20, 0.25)).toBe(12.5);
        expect(lerp(10, 20, -0.5)).toBe(5);
        expect(lerp(10, 20, 1.5)).toBe(25);
    });

    it('clamps below, inside and above an inclusive range', () => {
        expect(clamp(-1, 0, 1)).toBe(0);
        expect(clamp(0, 0, 1)).toBe(0);
        expect(clamp(0.4, 0, 1)).toBe(0.4);
        expect(clamp(1, 0, 1)).toBe(1);
        expect(clamp(2, 0, 1)).toBe(1);
    });

    it('maps Math.random linearly into the requested interval', () => {
        vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.5);
        expect(randomInRange(-4, 6)).toBe(-4);
        expect(randomInRange(-4, 6)).toBe(1);
    });

    it('converts signed and full-turn angles to radians', () => {
        expect(toRadians(180)).toBeCloseTo(Math.PI);
        expect(toRadians(360)).toBeCloseTo(Math.PI * 2);
        expect(toRadians(-90)).toBeCloseTo(-Math.PI / 2);
    });

    it('applies pitch and roll without disturbing yaw', () => {
        const node = { rotation: { x: 0, y: 9, z: 0 } };
        applyTerrainPose(node, { rotX: 0.2, rotZ: -0.4 });
        expect(node.rotation).toEqual({ x: 0.2, y: 9, z: -0.4 });
    });
});

describe('procedural noise', () => {
    it('pins deterministic samples that procedural geometry depends on', () => {
        expect(valueNoise3(0, 0, 0)).toBe(0);
        expect(valueNoise3(1.25, -4.5, 9.75)).toBeCloseTo(0.3360942981716315, 14);
        expect(valueNoise3(-2.125, 3.75, 0.5)).toBeCloseTo(0.673805631144208, 14);
        expect(fbm(0.2, 0.3, 0.4, 4)).toBeCloseTo(0.4102988975572608, 14);
    });

    it('stays in the documented unit interval over positive and negative cells', () => {
        for (let x = -3; x <= 3; x += 0.375) {
            for (let y = -2; y <= 2; y += 0.5) {
                const value = valueNoise3(x, y, x - y * 0.25);
                expect(value).toBeGreaterThanOrEqual(0);
                expect(value).toBeLessThanOrEqual(1);
            }
        }
    });

    it('is continuous across lattice boundaries', () => {
        const epsilon = 1e-6;
        expect(Math.abs(valueNoise3(1 - epsilon, 0.3, -2.4) - valueNoise3(1 + epsilon, 0.3, -2.4)))
            .toBeLessThan(1e-8);
    });

    it('uses one octave as the base field and remains deterministic with more octaves', () => {
        expect(fbm(0.2, 0.3, 0.4, 1)).toBe(valueNoise3(0.2, 0.3, 0.4));
        expect(fbm(0.2, 0.3, 0.4, 8)).toBe(fbm(0.2, 0.3, 0.4, 8));
    });
});

describe('signals', () => {
    it('notifies subscribers only on actual changes', () => {
        const signal = createSignal('mid');
        const listener = vi.fn();
        signal.subscribe(listener);
        signal.set('mid');
        signal.set('hi');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith('hi');
    });

    it('supports multiple subscribers and idempotent unsubscribe', () => {
        const signal = createSignal(0);
        const first = vi.fn();
        const second = vi.fn();
        const unsubscribe = signal.subscribe(first);
        signal.subscribe(second);
        unsubscribe();
        unsubscribe();
        signal.set(1);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledOnce();
        expect(signal.get()).toBe(1);
    });

    it('allows a subscriber to detach itself during notification', () => {
        const signal = createSignal(0);
        const listener = vi.fn();
        let unsubscribe = (): void => undefined;
        unsubscribe = signal.subscribe((value) => {
            listener(value);
            unsubscribe();
        });
        signal.set(1);
        signal.set(2);
        expect(listener).toHaveBeenCalledExactlyOnceWith(1);
    });
});

describe('per-engine registries', () => {
    it('isolates runtime flags between engine contexts', () => {
        const first = createEngineRuntimeConfig();
        const second = createEngineRuntimeConfig();
        initEngine({ isDev: true }, first);
        expect(getEngineIsDev(first)).toBe(true);
        expect(getEngineIsDev(second)).toBe(false);
    });

    it('starts every quality registry with the documented mid profile', () => {
        const profile = getActiveEngineProfile('mobile-flagship', createEngineProfileRegistry());
        expect(profile).toEqual({
            qualityTier: 'mid',
            mipBias: 0.5,
            disableLighting: false,
            emissiveBoost: 1,
            physicsStepHz: 60,
        });
    });

    it('isolates providers and forwards the requested preset', () => {
        const first = createEngineProfileRegistry();
        const second = createEngineProfileRegistry();
        const provider = vi.fn((preset: 'mobile-flagship' | 'mobile-mid' | 'mobile-low') => ({
            qualityTier: preset === 'mobile-flagship' ? 'hi' as const : 'lo' as const,
            mipBias: 0,
            disableLighting: false,
            emissiveBoost: 1,
            physicsStepHz: 120 as const,
        }));
        configureEngineProfileProvider(provider, first);
        expect(getActiveEngineProfile('mobile-flagship', first).qualityTier).toBe('hi');
        expect(provider).toHaveBeenCalledExactlyOnceWith('mobile-flagship');
        expect(getActiveEngineProfile('mobile-flagship', second).qualityTier).toBe('mid');
    });
});

describe('domain constants', () => {
    it('keeps probe thresholds and downgrade ratios strictly ordered', () => {
        expect(PROBE_TIER_THRESHOLD_MID).toBeLessThan(PROBE_TIER_THRESHOLD_HI);
        expect(PROBE_TIER_THRESHOLD_HI).toBeLessThanOrEqual(1);
        expect(BOOT_PROBE_PESSIMISM).toBeLessThanOrEqual(1);
        expect(LOD_DOWNGRADE_MID_RATIO).toBeGreaterThan(1);
        expect(LOD_DOWNGRADE_LO_RATIO).toBeGreaterThan(LOD_DOWNGRADE_MID_RATIO);
    });

    it('keeps probe windows and the substep cap positive integers', () => {
        for (const value of [MAX_DELTA_SUBSTEPS, PROBE_SKIP_FRAMES, BOOT_PROBE_MEASURE_FRAMES, WARMUP_PROBE_MEASURE_FRAMES]) {
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThan(0);
        }
    });
});
