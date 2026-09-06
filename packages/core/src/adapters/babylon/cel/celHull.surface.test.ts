import { afterEach, expect, it } from 'vitest';
import { Color3, Mesh, MeshBuilder, NullEngine, Scene, StandardMaterial, Vector3, VertexBuffer } from '@babylonjs/core';
import { organicTube } from '../RealismKit';
import { bakeCelHullIntoMesh } from './celHull';

const engines: NullEngine[] = [];
function scene() {
    const engine = new NullEngine();
    engines.push(engine);
    return new Scene(engine);
}
afterEach(() => engines.splice(0).forEach(engine => engine.dispose()));

function widths(mesh: Mesh) {
    const before = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
    expect(bakeCelHullIntoMesh(mesh, 0.035, Color3.Black())).toBe(true);
    const after = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    return before.filter((_, i) => i % 3 === 0).map((_, i) => Math.hypot(
        after[before.length + i * 3]! - before[i * 3]!,
        after[before.length + i * 3 + 1]! - before[i * 3 + 1]!,
        after[before.length + i * 3 + 2]! - before[i * 3 + 2]!,
    ));
}

it('finds an opposite face between sparse vertices on a long thin box', () => {
    const s = scene();
    const mesh = MeshBuilder.CreateBox('thin', { width: 1, height: 0.01, depth: 0.02 }, s);
    mesh.material = new StandardMaterial('body', s);
    for (const width of widths(mesh)) expect(width).toBeLessThanOrEqual(0.45 * 0.01 * Math.sqrt(3) + 1e-6);
});

it('does not measure a nested disconnected solid as the opposite wall', () => {
    const s = scene();
    function make() {
        const mesh = MeshBuilder.CreateIcoSphere('outer', { radius: 0.025, subdivisions: 2, flat: false }, s);
        mesh.material = new StandardMaterial('body', s);
        return mesh;
    }
    const expected = widths(make());
    const a = make();
    const b = MeshBuilder.CreateIcoSphere('inner', { radius: 0.005, subdivisions: 2, flat: false }, s);
    b.material = a.material;
    const merged = Mesh.MergeMeshes([a, b], true, true)!;
    const actual = widths(merged);
    for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 6);
});

it('limits extrusion on the narrow end of a tapered closed box', () => {
    const s = scene();
    const mesh = MeshBuilder.CreateBox('taper', { width: 0.03, height: 0.2, depth: 0.03 }, s);
    const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
    for (let i = 0; i < positions.length; i += 3) {
        const scale = positions[i + 1]! > 0 ? 0.1 : 1;
        positions[i] = positions[i]! * scale;
        positions[i + 2] = positions[i + 2]! * scale;
    }
    mesh.setVerticesData(VertexBuffer.PositionKind, positions);
    mesh.material = new StandardMaterial('body', s);
    const result = widths(mesh);
    for (let i = 0; i < result.length; i++) {
        if (positions[i * 3 + 1]! > 0) expect(result[i]).toBeLessThan(0.004);
    }
});

it('bakes a closed sphere with collapsed polar triangles', () => {
    const s = scene();
    const mesh = MeshBuilder.CreateSphere('closed', { diameter: 0.028, segments: 8 }, s);
    mesh.material = new StandardMaterial('body', s);
    expect(bakeCelHullIntoMesh(mesh, 0.035, Color3.Black())).toBe(true);
});

it('bounds the stroke on a sparse curved tapered tube including its caps', () => {
    const s = scene();
    const mesh = organicTube(s, 'tube', Vector3.Zero(), new Vector3(0, 1, 0),
        0.2, 0.016, 0.006, new Vector3(0.04, 0, 0), 'tube-contract', 3);
    mesh.material = new StandardMaterial('body', s);
    for (const width of widths(mesh)) expect(width).toBeLessThan(0.01);
});

it('keeps an open plane unbaked', () => {
    const s = scene();
    const mesh = MeshBuilder.CreatePlane('open', {}, s);
    mesh.material = new StandardMaterial('body', s);
    expect(bakeCelHullIntoMesh(mesh, 0.035, Color3.Black())).toBe(false);
});
