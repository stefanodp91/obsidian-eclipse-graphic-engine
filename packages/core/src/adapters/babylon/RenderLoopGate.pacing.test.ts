import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AbstractEngine, Scene } from '@babylonjs/core';
import { setupRenderLoopGate } from './RenderLoopGate';

function fixture(initialCap: number | null = 30) {
    let now = 0;
    let cap = initialCap;
    let active = true;
    let callback: (() => void) | undefined;
    let notify = () => {};
    const rendered: number[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const scene = { activeCamera: {}, render: () => { rendered.push(now); } };
    const engine = {
        stopRenderLoop: () => { callback = undefined; },
        runRenderLoop: (cb: () => void) => { callback = cb; },
    };
    const gate = setupRenderLoopGate(engine as unknown as AbstractEngine, scene as unknown as Scene, {
        isRenderActive: () => active,
        onRenderActiveChange: (cb) => { notify = cb; return () => {}; },
        onAppActiveChange: () => () => {},
        targetFps: () => cap,
    });
    notify();
    return {
        rendered,
        frame: (timestamp: number) => { now = timestamp; callback?.(); },
        setCap: (value: number | null) => { cap = value; },
        setActive: (value: boolean) => { active = value; notify(); },
        cleanup: gate.cleanup,
    };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });

const scenarios = [60, 90, 120].flatMap((hz) =>
    [2, 20, 30, 40, 60].flatMap((cap) => [false, true].map((jitter) => ({ hz, cap, jitter }))));

describe('render-loop cap precision', () => {
    it.each(scenarios)('delivers target $cap on $hz Hz (jitter: $jitter)', ({ hz, cap, jitter }) => {
        const f = fixture(cap);
        const seconds = 12;
        const offsets = [0, -1.3, 0.9, -0.6, 1.1, 0.2, -0.8];
        for (let i = 0; i < hz * seconds; i++) {
            f.frame(i * 1000 / hz + (jitter ? offsets[i % offsets.length]! : 0));
        }
        // Initial phase and display quantization may account for at most two frames.
        expect(Math.abs(f.rendered.length - cap * seconds)).toBeLessThanOrEqual(2);
        f.cleanup();
    });

    it('renders every available frame when the display is slower than the cap', () => {
        const f = fixture(60);
        for (let i = 0; i < 240; i++) f.frame(i * 1000 / 24);
        expect(f.rendered).toHaveLength(240);
        f.cleanup();
    });

    it('does not progressively undershoot a target that does not divide the display rate', () => {
        const f = fixture(40);
        for (let i = 0; i < 3600; i++) f.frame(i * 1000 / 60);
        expect(Math.abs(f.rendered.length - 2400)).toBeLessThanOrEqual(2);
        f.cleanup();
    });

    it('takes a new target immediately and keeps its own deadline', () => {
        const f = fixture(2);
        f.frame(0);
        f.frame(100);
        expect(f.rendered).toEqual([0]);
        f.setCap(30);
        f.frame(110);
        f.frame(120);
        f.frame(145);
        expect(f.rendered).toEqual([0, 110, 145]);
        f.setCap(2);
        f.frame(150);
        f.frame(600);
        f.frame(650);
        expect(f.rendered).toEqual([0, 110, 145, 150, 650]);
        f.cleanup();
    });

    it.each([null, 0, -1, NaN, Infinity])('treats %s as uncapped and rearms a later positive target', (cap) => {
        const f = fixture(2);
        f.frame(0);
        f.setCap(cap);
        f.frame(10);
        f.frame(20);
        f.setCap(2);
        f.frame(30);
        f.frame(40);
        expect(f.rendered).toEqual([0, 10, 20, 30]);
        f.cleanup();
    });

    it('drops missed work after a long stall instead of rendering a catch-up burst', () => {
        const f = fixture(30);
        f.frame(0);
        f.frame(1000);
        f.frame(1001);
        f.frame(1010);
        f.frame(1034);
        expect(f.rendered).toEqual([0, 1000, 1034]);
        f.cleanup();
    });

    it('starts a fresh pacing interval when resumed, even during a low-fps period', () => {
        const f = fixture(2);
        f.frame(0);
        f.setActive(false);
        f.frame(50);
        f.setActive(true);
        f.frame(100);
        f.frame(110);
        f.frame(600);
        expect(f.rendered).toEqual([0, 100, 600]);
        f.cleanup();
    });
});
