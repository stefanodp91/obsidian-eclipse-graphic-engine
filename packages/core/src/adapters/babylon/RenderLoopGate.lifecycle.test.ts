import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NullEngine, Scene, type AbstractEngine } from '@babylonjs/core';
import { setupRenderLoopGate } from './RenderLoopGate';

function fixture(active = true) {
    const loops = new Set<() => void>();
    const hostRender = vi.fn();
    loops.add(hostRender);
    const stopRenderLoop = vi.fn(() => loops.clear());
    const runRenderLoop = vi.fn((callback: () => void) => { loops.add(callback); });
    const render = vi.fn();
    const scene = { activeCamera: {} as object | null, render };
    let wanted = active;
    let renderChanged: () => void = () => {};
    let appChanged: (active: boolean) => void = () => {};
    const unsubRender = vi.fn();
    const unsubApp = vi.fn();
    let cap: number | null = null;
    const targetFps = vi.fn(() => cap);
    const gate = setupRenderLoopGate(
        { stopRenderLoop, runRenderLoop } as unknown as AbstractEngine,
        scene as unknown as Scene,
        {
            isRenderActive: () => wanted,
            onRenderActiveChange: (cb) => { renderChanged = cb; return unsubRender; },
            onAppActiveChange: (cb) => { appChanged = cb; return unsubApp; },
            targetFps,
        },
    );
    return {
        loops, hostRender, render, scene, gate, targetFps, stopRenderLoop, runRenderLoop,
        unsubRender, unsubApp,
        setCap: (value: number | null) => { cap = value; },
        notify: (value = wanted) => { wanted = value; renderChanged(); },
        app: (value: boolean) => { wanted = value; appChanged(value); },
        tick: () => { for (const callback of [...loops]) callback(); },
    };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => vi.useRealTimers());

describe('render-loop ownership', () => {
    it('replaces the host loop on active boot and consults the cap in the first session', () => {
        const f = fixture();
        f.setCap(2);
        vi.advanceTimersByTime(1000);
        expect(f.loops.size).toBe(1);
        expect(f.loops.has(f.hostRender)).toBe(false);
        f.tick();
        vi.advanceTimersByTime(16);
        f.tick();
        expect(f.targetFps).toHaveBeenCalledTimes(2);
        expect(f.render).toHaveBeenCalledOnce();
        expect(f.hostRender).not.toHaveBeenCalled();
        f.gate.cleanup();
    });

    it('stops the host loop when boot settles inactive', () => {
        const f = fixture(false);
        vi.advanceTimersByTime(1000);
        expect(f.loops.size).toBe(0);
        f.tick();
        expect(f.hostRender).not.toHaveBeenCalled();
        expect(f.render).not.toHaveBeenCalled();
        f.gate.cleanup();
    });

    it('takes ownership on the first notification without a prior inactive transition', () => {
        const f = fixture();
        f.notify();
        expect(f.loops.size).toBe(1);
        expect(f.loops.has(f.hostRender)).toBe(false);
        f.tick();
        expect(f.render).toHaveBeenCalledOnce();
        expect(f.hostRender).not.toHaveBeenCalled();
        f.gate.cleanup();
    });

    it.each([true, false])('reconciles late host registration after an early notification (active: %s)', (active) => {
        const f = fixture(active);
        f.notify();
        f.loops.add(f.hostRender); // The host registers after its scene-ready callback returns.
        vi.advanceTimersByTime(1000);
        expect(f.loops.has(f.hostRender)).toBe(false);
        expect(f.loops.size).toBe(active ? 1 : 0);
        f.tick();
        expect(f.hostRender).not.toHaveBeenCalled();
        expect(f.render).toHaveBeenCalledTimes(active ? 1 : 0);
        f.gate.cleanup();
    });

    it('deduplicates repeated notifications and resumes one gated callback', () => {
        const f = fixture();
        vi.advanceTimersByTime(1000);
        const callback = [...f.loops][0];
        f.notify();
        f.notify();
        f.app(true);
        expect([...f.loops]).toEqual([callback]);
        f.app(false);
        expect(f.loops.size).toBe(0);
        f.app(true);
        f.notify();
        expect(f.loops.size).toBe(1);
        expect(f.loops.has(f.hostRender)).toBe(false);
        f.tick();
        expect(f.render).toHaveBeenCalledOnce();
        f.gate.cleanup();
    });

    it('reads cap changes live and renders only with an active camera', () => {
        const f = fixture();
        vi.advanceTimersByTime(1000);
        f.setCap(2);
        f.tick();
        vi.advanceTimersByTime(16);
        f.tick();
        expect(f.render).toHaveBeenCalledOnce();
        f.setCap(null);
        f.tick();
        expect(f.render).toHaveBeenCalledTimes(2);
        f.scene.activeCamera = null;
        f.tick();
        expect(f.render).toHaveBeenCalledTimes(2);
        f.gate.cleanup();
    });

    it.each([true, false])('cancels pending startup and subscriptions on early cleanup (active: %s)', (active) => {
        const f = fixture(active);
        f.notify();
        f.loops.add(f.hostRender);
        f.gate.cleanup();
        f.gate.cleanup();
        vi.advanceTimersByTime(2000);
        f.notify(true); // A notification captured before unsubscription must also be harmless.
        f.app(true);
        expect(f.loops.size).toBe(0);
        expect(f.unsubRender).toHaveBeenCalledOnce();
        expect(f.unsubApp).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('makes an already captured render callback harmless after stop and cleanup', () => {
        const f = fixture();
        vi.advanceTimersByTime(1000);
        const callback = [...f.loops][0]!;
        expect(callback).not.toBe(f.hostRender);
        f.notify(false);
        callback();
        expect(f.render).not.toHaveBeenCalled();
        f.gate.cleanup();
        callback();
        f.notify(true);
        expect(f.render).not.toHaveBeenCalled();
        expect(f.loops.size).toBe(0);
    });
});

it('replaces callbacks in the real Babylon engine without leaving an uncapped loop', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const hostRender = vi.fn();
    const targetFps = vi.fn(() => 2);
    engine.runRenderLoop(hostRender);
    let notify = () => {};
    const gate = setupRenderLoopGate(engine, scene, {
        isRenderActive: () => true,
        onRenderActiveChange: (cb) => { notify = cb; return () => {}; },
        onAppActiveChange: () => () => {},
        targetFps,
    });
    try {
        notify();
        expect(engine.activeRenderLoops).toHaveLength(1);
        expect(engine.activeRenderLoops).not.toContain(hostRender);
        engine.activeRenderLoops[0]!();
        expect(targetFps).toHaveBeenCalledOnce();
        expect(hostRender).not.toHaveBeenCalled();
        notify();
        expect(engine.activeRenderLoops).toHaveLength(1);
        gate.cleanup();
        expect(engine.activeRenderLoops).toHaveLength(0);
    } finally {
        gate.cleanup();
        scene.dispose();
        engine.dispose();
    }
});
