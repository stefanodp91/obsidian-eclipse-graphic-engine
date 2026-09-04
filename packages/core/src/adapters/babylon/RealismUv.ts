// RealismUv — livery-atlas UV helpers (R5 canonical DynamicTexture-atlas
// pattern) + R4 concentric-eye helpers. World/object-AGNOSTIC — promoted from
// models/world3/_marine/uv.ts (2026-07-11): the pattern serves
// any creature with a livery (born for marine creatures, also used by
// snake/cobra-class models).
import { Color3, Mesh, MeshBuilder, Vector3, VertexBuffer } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';

/** Axis-aligned rect of the atlas ([u0,v0]→[u1,v1], v = canvas y / size). */
export interface AtlasRect { u0: number; v0: number; u1: number; v1: number; }

/** Planar-project a mesh's vertices into an atlas rect: component `axU` of the
 *  position maps to u across [minU,maxU], component `axV` to v across
 *  [minV,maxV] (clamped). Coherent flowing detail — never the merged-atlas
 *  camo grid of R5 trap 1. */
export function mapPlanarUV(
    mesh: Mesh, rect: AtlasRect,
    axU: 0 | 1 | 2, minU: number, maxU: number,
    axV: 0 | 1 | 2, minV: number, maxV: number,
): void {
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!pos) return;
    const n = pos.length / 3;
    const uv = new Float32Array(n * 2);
    const cl = (t: number): number => Math.min(0.999, Math.max(0.001, t));
    for (let i = 0; i < n; i++) {
        const tu = cl((pos[i * 3 + axU]! - minU) / (maxU - minU));
        const tv = cl((pos[i * 3 + axV]! - minV) / (maxV - minV));
        uv[i * 2] = rect.u0 + tu * (rect.u1 - rect.u0);
        uv[i * 2 + 1] = rect.v0 + tv * (rect.v1 - rect.v0);
    }
    mesh.setVerticesData(VertexBuffer.UVKind, uv, false);
}

/** Pin every UV of a mesh to the atlas's WHITE texel — the livery multiply is
 *  identity there, so the part's Color4 remains the visible tint. */
export function pinUvWhite(mesh: Mesh, u: number, v: number): Mesh {
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (pos) {
        const n = pos.length / 3;
        const uv = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) { uv[i * 2] = u; uv[i * 2 + 1] = v; }
        mesh.setVerticesData(VertexBuffer.UVKind, uv, false);
    }
    return mesh;
}

/** One concentric-painted eye (R4). Positions/axes are model space POST-bake.
 *  `r` is the unsquashed sphere radius; `out` points out of the skull (ring
 *  axis); `glint` is the fixed highlight direction. */
export interface EyeSpec {
    c: Vector3;        // centre
    out: Vector3;      // outward axis (normalized)
    glint: Vector3;    // glint direction (normalized)
    r: number;         // sphere radius (pre-squash)
    iris: Color3;      // iris ring colour
}

const EYE_PUPIL = new Color3(0.03, 0.03, 0.04);
const EYE_SCLERA = new Color3(0.72, 0.70, 0.64);
const EYE_ORBIT = new Color3(0.09, 0.09, 0.10);
const EYE_GLINT = new Color3(0.98, 0.98, 0.98);

/** Ring colour for a vertex if it belongs to one of the eyes (glint → pupil →
 *  iris → sclera → dark orbit rim), else null — call FIRST in the post-merge
 *  positional painter. Angle-based, so the squashed sphere reads as a lidded
 *  eye, not a decal. */
export function eyeRingColor(
    x: number, y: number, z: number, eyes: readonly EyeSpec[],
): Color3 | null {
    for (const e of eyes) {
        const dx = x - e.c.x, dy = y - e.c.y, dz = z - e.c.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > e.r * 1.18) continue;
        const inv = 1 / (d || 1e-6);
        const ux = dx * inv, uy = dy * inv, uz = dz * inv;
        const cg = ux * e.glint.x + uy * e.glint.y + uz * e.glint.z;
        if (cg > 0.965) return EYE_GLINT;                       // fixed glint
        const co = ux * e.out.x + uy * e.out.y + uz * e.out.z;
        const a = Math.acos(Math.min(1, Math.max(-1, co)));     // 0 = eye apex
        if (a < 0.42) return EYE_PUPIL;
        if (a < 0.82) return e.iris;
        if (a < 1.28) return EYE_SCLERA;
        return EYE_ORBIT;                                       // orbit rim
    }
    return null;
}

/** Build the eye sphere: squashed along the outward (x) axis and baked, ready
 *  to merge into the body (the rings are painted by the post-merge painter).
 *  `segments` is tier-gated by the caller (lo < mid < hi). */
export function buildEyeSphere(
    scene: Scene, name: string, spec: EyeSpec, squash: number, segments: number,
): Mesh {
    const eye = MeshBuilder.CreateSphere(name, { diameter: spec.r * 2, segments }, scene);
    eye.scaling.set(squash, 1, 1);
    eye.position.copyFrom(spec.c);
    eye.bakeCurrentTransformIntoVertices();
    return eye;
}
