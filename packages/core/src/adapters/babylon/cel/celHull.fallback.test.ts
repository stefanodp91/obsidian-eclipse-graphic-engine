import { afterEach, expect, it } from 'vitest';
import { MeshBuilder, NullEngine, Scene, StandardMaterial, PBRMaterial } from '@babylonjs/core';
import { setCelOutlineHullMode, markCelOutlineEssential, markCelOutlineNoHullFallback } from './CelOutlinePostProcess';
import { isCelHullBaked } from './celHull';

const scenes: Scene[] = [];
function fixture(pbr = false) {
    const scene = new Scene(new NullEngine());
    scenes.push(scene);
    const mesh = MeshBuilder.CreateBox('hero', {}, scene);
    mesh.material = pbr ? new PBRMaterial('dynamic', scene) : new StandardMaterial('cel', scene);
    markCelOutlineEssential(mesh);
    return { scene, mesh };
}
afterEach(() => {
    for (const scene of scenes.splice(0)) {
        setCelOutlineHullMode(scene, false);
        scene.getEngine().dispose();
    }
});

it('keeps a declared essential PBR fallback and stops it when disabled', () => {
    const { scene, mesh } = fixture(true);
    const material = mesh.material;
    setCelOutlineHullMode(scene, true, 0.035, undefined, 0, true);
    expect(mesh.renderOutline).toBe(true);
    expect(isCelHullBaked(mesh)).toBe(false);
    expect(mesh.material).toBe(material);
    setCelOutlineHullMode(scene, false, 0.035, undefined, 0, true);
    expect(mesh.renderOutline).toBe(false);
});

it('removes the old per-mesh pass when switching to a baked hull', () => {
    const { scene, mesh } = fixture();
    setCelOutlineHullMode(scene, true);
    expect(mesh.renderOutline).toBe(true);
    setCelOutlineHullMode(scene, true, 0.035, undefined, 0, true);
    expect(isCelHullBaked(mesh)).toBe(true);
    expect(mesh.renderOutline).toBe(false);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.renderOutline).toBe(false);
});

it('honors the explicit no-fallback marker', () => {
    const { scene, mesh } = fixture(true);
    markCelOutlineNoHullFallback(mesh);
    setCelOutlineHullMode(scene, true, 0.035, undefined, 0, true);
    expect(mesh.renderOutline).toBe(false);
    expect(isCelHullBaked(mesh)).toBe(false);
});
