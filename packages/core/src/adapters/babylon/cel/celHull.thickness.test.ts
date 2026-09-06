import { afterEach, describe, expect, it } from 'vitest';
import { Color3, MeshBuilder, NullEngine, Scene, StandardMaterial, VertexBuffer, type Mesh } from '@babylonjs/core';
import { bakeCelHullIntoMesh, celBodyBoxOf } from './celHull';
import { acquireFromPool, registerPoolType, releaseAllPools } from '../MeshPool';

const scenes: Scene[] = [];
function scene() { const s = new Scene(new NullEngine()); scenes.push(s); return s; }
afterEach(() => { for (const s of scenes.splice(0)) { releaseAllPools(s); s.getEngine().dispose(); } });
function sphere(s: Scene, segments: number, diameter = 0.028, inverted = false) {
    const mesh = MeshBuilder.CreateIcoSphere('part', { subdivisions: segments, radius: diameter / 2, flat: false }, s);
    mesh.material = new StandardMaterial('body', s);
    if (inverted) {
        const indices = Array.from(mesh.getIndices()!);
        for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
        mesh.setIndices(indices);
        mesh.setVerticesData(VertexBuffer.NormalKind, Array.from(mesh.getVerticesData(VertexBuffer.NormalKind)!, n => -n));
    }
    return mesh;
}
function bake(mesh: Mesh) {
    const before = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
    expect(bakeCelHullIntoMesh(mesh, 0.035, Color3.Black())).toBe(true);
    const after = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBeCloseTo(before[i]!, 7);
    return after.slice(before.length);
}
describe('baked hull local thickness', () => {
    it.each([1, 2, 3])('preserves the same thin hull when winding and normals are inverted (%i subdivisions)', segments => {
        const s = scene();
        const canonical = bake(sphere(s, segments));
        const inverted = bake(sphere(s, segments, 0.028, true));
        expect(inverted).toHaveLength(canonical.length);
        for (let i = 0; i < canonical.length; i++) expect(inverted[i]).toBeCloseTo(canonical[i]!, 6);
        // A 14 mm radius must not grow by the requested 35 mm stroke.
        for (let i = 0; i < inverted.length; i += 3) {
            expect(Math.hypot(inverted[i]!, inverted[i + 1]!, inverted[i + 2]!)).toBeLessThan(0.028);
        }
    });
    it('keeps the requested stroke on a thick solid', () => {
        const s = scene();
        for (const inverted of [false, true]) {
            const hull = bake(sphere(s, 2, 2, inverted));
            for (let i = 0; i < hull.length; i += 3) expect(Math.hypot(hull[i]!, hull[i + 1]!, hull[i + 2]!)).toBeCloseTo(1.035, 4);
        }
    });
    it('preserves body bounds and hull geometry across pool reuse', () => {
        const s = scene();
        const direct = sphere(s, 2, 0.028, true);
        const expected = bake(direct);
        registerPoolType('cel-thickness-reuse', { create: current => ({ mesh: sphere(current, 2, 0.028, true) }) });
        const item = acquireFromPool(s, 'cel-thickness-reuse')!;
        const mesh = item.mesh as Mesh;
        expect(bake(mesh)).toEqual(expected);
        expect(celBodyBoxOf(mesh)).toEqual(celBodyBoxOf(direct));
        expect(celBodyBoxOf(mesh)!.max[0]).toBeLessThanOrEqual(0.014001);
        const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
        item.release();
        const reused = acquireFromPool(s, 'cel-thickness-reuse')!;
        expect(reused.mesh).toBe(mesh);
        expect(bakeCelHullIntoMesh(mesh, 0.035, Color3.Black())).toBe(false);
        expect(Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!)).toEqual(positions);
    });
});
