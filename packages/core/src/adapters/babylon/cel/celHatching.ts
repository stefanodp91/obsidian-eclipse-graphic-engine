// Procedural hatching — the pen screen laid over the dark bands.
//
// It is the term usually missing from anyone imitating Borderlands: with bands +
// outline alone you get a clean cartoon cel-shading. Hatching is what adds the
// "hand-made" quality. It is sampled in SCREEN SPACE in the shader (see celHatch
// in celShading.glsl.ts): the stroke belongs to the paper, not to the surface,
// and it is precisely that inconsistency that makes it read as drawn rather than
// as a texture applied to the model.

import type { Scene } from '@babylonjs/core';
import { DynamicTexture, Texture } from '@babylonjs/core';

export interface CelHatchSpec {
    /** Number of strokes per tile side. Higher = denser screen. */
    density: number;
    /** Stroke thickness, in tile pixels. */
    weight: number;
    /** A second set of strokes at 90°, i.e. cross-hatching. */
    crossed: boolean;
}

export const DEFAULT_CEL_HATCH: CelHatchSpec = {
    density: 14,
    weight: 2.0,
    crossed: false,
};

/** Neutral tile: solid white = no hatching. The sampler in the shader must
 *  ALWAYS be bound (an unbound sampler in WebGL is undefined behavior, typically
 *  black), so "hatching off" is this texture, not the absence of a texture. */
export const NO_HATCH: CelHatchSpec = { density: 0, weight: 0, crossed: false };

const HATCH_SIZE = 256;

const hatchCache = new WeakMap<Scene, Map<string, DynamicTexture>>();

function hatchKey(spec: CelHatchSpec): string {
    return `${spec.density}|${spec.weight.toFixed(2)}|${spec.crossed ? 'x' : '-'}`;
}

/** Draws a set of 45° diagonal lines, repeated past the edges so the tile matches
 *  itself (the hatching is sampled with wrapping: a non-cyclic tile would produce
 *  a grid of seams visible on screen). */
function drawDiagonals(ctx: CanvasRenderingContext2D, spec: CelHatchSpec, mirrored: boolean): void {
    const step = HATCH_SIZE / spec.density;
    ctx.save();
    if (mirrored) {
        ctx.translate(HATCH_SIZE, 0);
        ctx.scale(-1, 1);
    }
    ctx.lineWidth = spec.weight;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#000000';
    // From -HATCH_SIZE to +2*HATCH_SIZE: the diagonals leaving one side have to
    // come back in on the other, or the tile's corners stay empty.
    for (let i = -spec.density; i < spec.density * 2; i++) {
        const x = i * step;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + HATCH_SIZE, HATCH_SIZE);
        ctx.stroke();
    }
    ctx.restore();
}

function buildHatch(scene: Scene, spec: CelHatchSpec): DynamicTexture {
    // NO mipmaps. A screen is made of thin lines: as soon as the tile is
    // minified, the mipmap averages them with the background and the hatching
    // washes out until it disappears — it looks like the intensity is broken,
    // when in fact the texture has already dissolved before reaching the shader.
    // The screen is meant to be used at ~1:1 scale (see the default of
    // `hatchScale`), where mipmaps are of no use.
    const dt = new DynamicTexture(
        `cel-hatch-${spec.density}`,
        { width: HATCH_SIZE, height: HATCH_SIZE },
        scene,
        false,
    );
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, HATCH_SIZE, HATCH_SIZE);

    if (spec.density > 0 && spec.weight > 0) {
        drawDiagonals(ctx, spec, false);
        if (spec.crossed) drawDiagonals(ctx, spec, true);
    }

    dt.update(false);
    dt.wrapU = Texture.WRAP_ADDRESSMODE;
    dt.wrapV = Texture.WRAP_ADDRESSMODE;
    // A coverage mask, not a color: no gamma decoding.
    dt.gammaSpace = false;
    return dt;
}

// A fast lane identical to `getCelRamp`'s, and for the same reason: this function
// sits in the cel plugin's `bindForSubMesh`, i.e. one call per submesh per frame.
// See the extended comment in celRamp.ts for the full reasoning.
let lastHatchScene: Scene | null = null;
let lastHatchSpec: CelHatchSpec | null = null;
let lastHatchTex: DynamicTexture | null = null;

export function getCelHatch(scene: Scene, spec: CelHatchSpec = DEFAULT_CEL_HATCH): DynamicTexture {
    if (lastHatchTex && lastHatchScene === scene && lastHatchSpec === spec) return lastHatchTex;

    let m = hatchCache.get(scene);
    if (!m) { m = new Map(); hatchCache.set(scene, m); }
    const key = hatchKey(spec);
    let tex = m.get(key);
    if (!tex) {
        tex = buildHatch(scene, spec);
        m.set(key, tex);
    }
    lastHatchScene = scene;
    lastHatchSpec = spec;
    lastHatchTex = tex;
    return tex;
}

export function disposeCelHatches(scene: Scene): void {
    if (lastHatchScene === scene) {
        lastHatchScene = null;
        lastHatchSpec = null;
        lastHatchTex = null;
    }
    const m = hatchCache.get(scene);
    if (!m) return;
    for (const tex of m.values()) tex.dispose();
    hatchCache.delete(scene);
}
