// Per-vertex lighting bake — runs once at master-mesh construction.
//
// Drives a directional sun + ambient hemispheric contribution into the mesh's
// vertex-color buffer so a StandardMaterial with `disableLighting = true` (the
// 'low' quality preset) still reads as if lit. The fragment shader stays at
// "albedo * vertexColor + emissive" — zero per-light math per fragment.

import type { AbstractMesh, Color3, FloatArray } from '@babylonjs/core';
import { VertexBuffer } from '@babylonjs/core';
import { getDecorShadingMode } from './MaterialLibrary';

interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** Default floor for the diffuse contribution — vertices facing fully away from
 *  the sun retain enough fill to read against the sky (real hemispheric ambient
 *  sits around 0.15–0.25). */
const DEFAULT_AMBIENT_FLOOR = 0.18;

function normalize(v: Vec3): Vec3 {
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Centroid + positions for the cavity term. Returns null when the mesh has no
 *  position buffer (the caller then skips occlusion entirely). */
function prepareCavity(
    mesh: AbstractMesh,
    vCount: number,
): { positions: FloatArray; cx: number; cy: number; cz: number } | null {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) return null;
    let cx = 0, cy = 0, cz = 0;
    for (let v = 0; v < vCount; v++) {
        cx += positions[v * 3]!; cy += positions[v * 3 + 1]!; cz += positions[v * 3 + 2]!;
    }
    return { positions, cx: cx / vCount, cy: cy / vCount, cz: cz / vCount };
}

/** Cheap per-vertex ambient occlusion, WITHOUT the sun bake — for meshes that
 *  keep dynamic lighting (every preset today: `useBakedVertexColors` is false on
 *  all three tiers) but still want the G4 shape-gradient in their vertex colors.
 *
 *  Why a dedicated entry point instead of `applyBakedSunLight(..., cavity)`:
 *  that call also multiplies in `mix(ground, diffuse, sunDot)`, i.e. it bakes a
 *  SECOND light on top of the scene's dynamic one. Passing white for both
 *  collapses that factor to exactly 1 — this function is that call, minus the
 *  dead math and minus the chance a caller forgets the white/white contract.
 *
 *  One O(verts) pass at master-build time; per-frame cost is zero and the mesh /
 *  draw-call / material count is untouched. `strength = 0` is a no-op. */
export function applyBakedCavityAO(mesh: AbstractMesh, strength: number): void {
    if (strength <= 0) return;
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
    const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
    if (!normals || !colors) return;

    const vCount = normals.length / 3;
    if (colors.length < vCount * 4) return;
    const cav = prepareCavity(mesh, vCount);
    if (!cav) return;
    const { positions, cx, cy, cz } = cav;

    for (let v = 0; v < vCount; v++) {
        const ao = cavityFactor(normals, positions, v, cx, cy, cz, strength);
        colors[v * 4]     = (colors[v * 4]     ?? 1) * ao;
        colors[v * 4 + 1] = (colors[v * 4 + 1] ?? 1) * ao;
        colors[v * 4 + 2] = (colors[v * 4 + 2] ?? 1) * ao;
    }
    mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

/** Occlusion multiplier for one vertex: a normal pointing back toward the mesh
 *  centroid sits in a concave pocket → darken it. No rays. Meaningful only on
 *  roughly-convex, compact masters (a long track slab has no useful centroid). */
function cavityFactor(
    normals: FloatArray, positions: FloatArray, v: number,
    cx: number, cy: number, cz: number, strength: number,
): number {
    const ox = positions[v * 3]!     - cx;
    const oy = positions[v * 3 + 1]! - cy;
    const oz = positions[v * 3 + 2]! - cz;
    const olen = Math.hypot(ox, oy, oz) || 1;
    // normal · inward (= −outward): >0 ⇒ face looks toward the centroid = pocket.
    const cavity = Math.max(0, -(normals[v * 3]! * ox + normals[v * 3 + 1]! * oy + normals[v * 3 + 2]! * oz) / olen);
    return 1 - strength * cavity;
}

/** Multiply each vertex color channel by a `mix(ground, diffuse, sunDot)` factor
 *  so the baked color encodes per-vertex directional lighting. Operates in-place
 *  on the mesh's existing color buffer (prior vertex paint passes stay visible)
 *  and uploads the result. Skipped silently if normals or colors are missing. */
export function applyBakedSunLight(
    mesh: AbstractMesh,
    diffuse: Color3,
    ground: Color3,
    sunDir: Vec3,
    ambientFloor: number = DEFAULT_AMBIENT_FLOOR,
    cavityStrength: number = 0,
): void {
    // Sotto cel il bake va SALTATO, non attenuato.
    //
    // Questa funzione moltiplica i vertex color per un termine di luce
    // precalcolato: nel modello legacy è un guadagno gratuito (chiaroscuro senza
    // costo per-fragment), ma sotto cel diventa una SECONDA illuminazione dentro
    // l'albedo. Due conseguenze, entrambe viste a schermo su una scena ricca di vegetazione:
    //
    //   · il gradiente bakeato attraversa le bande e le sporca — è esattamente
    //     il chiaroscuro continuo che la quantizzazione esiste per togliere;
    //   · l'albedo esce pre-scurito, e il modello legacy lo compensava col floor
    //     emissivo del materiale. Tolto quello (col cel laverebbe le bande),
    //     resta solo lo scurimento e la scena affonda.
    //
    // Saltandolo, i vertex color tornano ad essere albedo PIATTO — che è la
    // grammatica del cel, la stessa che `paint()` produce negli asset nuovi.
    if (getDecorShadingMode() === 'cel') return;

    const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
    const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
    if (!normals || !colors) return;

    const sun = normalize(sunDir);
    const vCount = normals.length / 3;
    if (colors.length < vCount * 4) return;

    // Optional cheap ambient-occlusion term (default 0 = bit-identical).
    const cav = cavityStrength > 0 ? prepareCavity(mesh, vCount) : null;
    const positions = cav?.positions ?? null;
    const cx = cav?.cx ?? 0, cy = cav?.cy ?? 0, cz = cav?.cz ?? 0;

    for (let v = 0; v < vCount; v++) {
        const nx = normals[v * 3]!;
        const ny = normals[v * 3 + 1]!;
        const nz = normals[v * 3 + 2]!;
        const dot = Math.max(0, nx * sun.x + ny * sun.y + nz * sun.z);
        const lit = ambientFloor + (1 - ambientFloor) * dot;
        // Mix between ground (back-lit fill) and sun-driven diffuse — ground
        // keeps down-facing parts from going black, diffuse brightens up-facing
        // parts toward the palette accent.
        const rMix = ground.r * (1 - lit) + diffuse.r * lit;
        const gMix = ground.g * (1 - lit) + diffuse.g * lit;
        const bMix = ground.b * (1 - lit) + diffuse.b * lit;
        const ao = positions ? cavityFactor(normals, positions, v, cx, cy, cz, cavityStrength) : 1;
        colors[v * 4]     = (colors[v * 4]     ?? 1) * rMix * ao;
        colors[v * 4 + 1] = (colors[v * 4 + 1] ?? 1) * gMix * ao;
        colors[v * 4 + 2] = (colors[v * 4 + 2] ?? 1) * bMix * ao;
    }
    mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}
