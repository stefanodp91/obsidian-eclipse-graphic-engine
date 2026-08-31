// Realism kit — brand-agnostic toolkit for stylized-realistic procedural
// modelling (the R1–R8 realism guidelines: consumers document their own SSoT).
// "Realism" here is procedural anatomy + per-vertex gradients + ONE
// white-albedo matte material per model — never photo textures, never flat
// tints, never naive CSG. The kit hosts the reusable primitives; the per-model
// spine/girth idiom (a hand-written `spine(t): Vector3` curve + `girth(t)`
// radius profile fed to CreateTube.radiusFunction) stays in each builder —
// silhouettes are species-specific by design (R1).
//
// Build-time only: every helper runs once at mesh construction, zero per-frame
// cost. Noise comes from the deterministic `domain/proceduralNoise` fBm.

import {
    Scene, Mesh, MeshBuilder, Vector3, Color3, VertexBuffer, PBRMaterial,
} from '@babylonjs/core';

import { fbm } from '../../domain/proceduralNoise';

/** Per-tier organic LOD budget (R6). Drives ribbon/tube tessellation +
 *  displacement octaves so hi/mid/lo differ in DENSITY, never in silhouette. */
export interface RealismLodBudget {
    tubeTess: number;       // CreateTube radial segments
    ribbonRibs: number;     // membrane columns (fin rays)
    ribbonRows: number;     // membrane rows (root→margin)
    latheTess: number;      // lathe revolution segments
    octaves: number;        // fBm displacement octaves
}
export const REALISM_LOD: Record<'hi' | 'mid' | 'lo', RealismLodBudget> = {
    hi:  { tubeTess: 10, ribbonRibs: 11, ribbonRows: 6, latheTess: 22, octaves: 4 },
    mid: { tubeTess: 7,  ribbonRibs: 7,  ribbonRows: 4, latheTess: 14, octaves: 3 },
    lo:  { tubeTess: 5,  ribbonRibs: 5,  ribbonRows: 3, latheTess: 9,  octaves: 2 },
};

function seedOffsets(seed: string): [number, number, number] {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seed.length; i++) { h ^= seed.codePointAt(i) ?? 0; h = Math.imul(h, 16777619) >>> 0; }
    return [(h & 1023) / 7, ((h >>> 10) & 1023) / 7, ((h >>> 20) & 1023) / 7];
}

/** fBm displacement of PositionKind along vertex normals → organic asymmetry,
 *  pores + diameter variation (R2 — keep amplitudes small: 0.005–0.02 on
 *  bodies; higher only on rock/lava). Build-time only (zero per-frame cost).
 *  Optional `taper` scales the displacement per-vertex (0..1): pass it to pin
 *  a seam edge in place — two meshes sharing a welded edge would otherwise
 *  drift apart (each displaced along its own normal) and open a gap. */
export function fbmDisplace(
    mesh: Mesh, seed: string, amplitude: number, frequency: number, octaves = 3,
    taper?: (x: number, y: number, z: number) => number,
): void {
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
    const nrm = mesh.getVerticesData(VertexBuffer.NormalKind);
    if (!pos || !nrm) return;
    const [ox, oy, oz] = seedOffsets(seed);
    const n = pos.length / 3;
    for (let i = 0; i < n; i++) {
        const px = pos[i * 3]!, py = pos[i * 3 + 1]!, pz = pos[i * 3 + 2]!;
        const k = taper ? taper(px, py, pz) : 1;
        const d = (fbm(px * frequency + ox, py * frequency + oy, pz * frequency + oz, octaves) - 0.5) * amplitude * k;
        pos[i * 3]     = px + nrm[i * 3]!     * d;
        pos[i * 3 + 1] = py + nrm[i * 3 + 1]! * d;
        pos[i * 3 + 2] = pz + nrm[i * 3 + 2]! * d;
    }
    mesh.updateVerticesData(VertexBuffer.PositionKind, pos);
    mesh.createNormals(false);
}

/** Per-vertex Color4 paint (R3 — gradients, never flat tints). `fn` receives
 *  position + normal and returns the final RGB; alpha is 1. Prefer POSITIONAL
 *  zone masks over normal-based ones: post-fBm normals oscillate and dirty the
 *  zone borders. Writes ColorKind so the piece merges cleanly with painted
 *  siblings (MergeMeshes zeroes ColorKind on any source lacking it). */
export function paintVertexColor(
    mesh: Mesh, fn: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => Color3,
): void {
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
    const nrm = mesh.getVerticesData(VertexBuffer.NormalKind);
    if (!pos) return;
    const n = pos.length / 3;
    const colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
        const c = fn(
            pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!,
            nrm ? nrm[i * 3]! : 0, nrm ? nrm[i * 3 + 1]! : 1, nrm ? nrm[i * 3 + 2]! : 0,
        );
        colors[i * 4] = c.r; colors[i * 4 + 1] = c.g; colors[i * 4 + 2] = c.b; colors[i * 4 + 3] = 1;
    }
    mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

/** R8 canary: paint a part solid red BEFORE merge to bisect a visual artefact —
 *  if the canary inherits the pattern the bug is in the paint; if it stays
 *  solid it's material/lighting. Then bisect: bump → env → displacement → paint. */
export function paintCanary(mesh: Mesh): void {
    paintVertexColor(mesh, () => new Color3(1, 0, 0));
}

/** A smooth tapered tube along a fBm-wandered curve — a living horn / tail /
 *  neck, never a straight cylinder (R1). Local space. */
export function organicTube(
    scene: Scene, name: string, start: Vector3, dir: Vector3, len: number,
    rStart: number, rEnd: number, bend: Vector3, seed: string, tess: number,
): Mesh {
    const STEPS = 6;
    const [ox] = seedOffsets(seed);
    const path: Vector3[] = [];
    const radii: number[] = [];
    const end = start.add(dir.scale(len));
    for (let k = 0; k <= STEPS; k++) {
        const t = k / STEPS;
        const bow = bend.scale(Math.sin(t * Math.PI));
        const w = (fbm(t * 3 + ox, 0, 0, 2) - 0.5) * len * 0.10;
        path.push(Vector3.Lerp(start, end, t).add(bow).add(new Vector3(w, 0, w * 0.6)));
        radii.push(rStart + (rEnd - rStart) * t);
    }
    return MeshBuilder.CreateTube(name, {
        path, radius: 1, radiusFunction: (k) => radii[k]!,
        cap: Mesh.CAP_ALL, tessellation: tess, updatable: false,
    }, scene);
}

/** A ribbon membrane between an attach edge (root) and a free margin (tip),
 *  with an undulating margin for an organic frilly/webbed edge (R1). Used for
 *  fins, wings, flippers, hoods, leaves. baseFn/tipFn map u∈[0,1] along the
 *  edge; the margin ripples via cos lobes + fBm. Thin double-sided surface. */
export function organicMembrane(
    scene: Scene, name: string,
    baseFn: (u: number) => Vector3,
    tipFn: (u: number) => Vector3,
    ribs: number, rows: number, seed: string, lobes = 3, ripple = 0.05,
): Mesh {
    const [ox] = seedOffsets(seed);
    const paths: Vector3[][] = [];
    for (let r = 0; r <= rows; r++) {
        const v = r / rows;
        const row: Vector3[] = [];
        for (let i = 0; i <= ribs; i++) {
            const u = i / ribs;
            const p = Vector3.Lerp(baseFn(u), tipFn(u), v);
            const marginWave = (Math.sin(u * Math.PI * 2 * lobes) * 0.5
                + (fbm(u * 4 + ox, v * 4, 0, 2) - 0.5)) * ripple * v;
            row.push(new Vector3(p.x, p.y + marginWave, p.z + marginWave * 0.4));
        }
        paths.push(row);
    }
    const mesh = MeshBuilder.CreateRibbon(name, {
        pathArray: paths, closeArray: false, closePath: false,
        sideOrientation: Mesh.DOUBLESIDE,
    }, scene);
    mesh.createNormals(true);
    return mesh;
}

/** The canonical R5 material: ONE white-albedo matte PBR per model — the hue
 *  rides the baked per-vertex Color4 (→ 1 draw call, variants via albedo tint).
 *  Matte like PBR_PIRANHA_BODY/PBR_SHARK, built by hand:
 *  - NO NoiseProceduralTexture bump: on a merged-mesh UV atlas the tiled 256px
 *    noise renders as a repeating blotch grid, not grain (level=0 does NOT
 *    disable an assigned bump). Grain comes from fbmDisplace + vertex paint.
 *  - IBL capped (envIntensity 0.30 + roughness 0.80): low roughness / full env
 *    reflects the world HDR (per-world tints) and washes dark baked
 *    hues to pastel. The directional key + baked gradients carry the shading.
 *  ONE material family across every tier — `tier` gates GEOMETRY in the
 *  builders, never the material (a no-IBL Standard on `lo` read darker + more
 *  neutral than hi/mid and could never match the env fill). */
export function realismSkin(name: string, scene: Scene): PBRMaterial {
    const m = new PBRMaterial(name, scene);
    m.albedoColor = new Color3(1, 1, 1);          // hue rides the baked Color4
    m.metallic = 0.0;
    m.roughness = 0.80;
    m.emissiveColor = new Color3(0.03, 0.03, 0.03);
    m.environmentIntensity = 0.30;
    m.backFaceCulling = false;
    m.twoSidedLighting = true;
    return m;
}
