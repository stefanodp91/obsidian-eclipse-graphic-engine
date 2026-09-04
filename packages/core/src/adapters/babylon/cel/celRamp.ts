// Procedural ramp texture: the 1-D lookup that turns NdotL into a BAND.
//
// All of cel shading's art direction lives in here. The number of steps, their
// hardness and — above all — the shadow's TINT are the three axes that separate a
// believable cel-shading from a plastic one. Having them in a texture instead of
// in shader constants means being able to tune them at runtime without a
// recompilation: that is the precondition for the column-based lab.
//
// Same pattern as `buildDecorMatcap` in MaterialLibrary.ts: a DynamicTexture
// drawn on a 2D canvas, a per-Scene cache, a single instance per parameter
// combination.

import type { Scene } from '@babylonjs/core';
import { Color3, DynamicTexture, Texture } from '@babylonjs/core';

export interface CelRampSpec {
    /** Number of steps. 0 = continuous ramp (the "non-cel" reference). */
    bands: number;
    /** Multiplicative color in the deepest shadow step. */
    shadow: Color3;
    /** Multiplicative color in the brightest step. Typically white. */
    light: Color3;
    /** Width of the transition between steps, as a fraction of a band (0..1).
     *  0 = hard cut. Above ~0.35 the bands merge and the look is lost. */
    softness: number;
}

export const DEFAULT_CEL_RAMP: CelRampSpec = {
    bands: 3,
    // A cold, slightly saturated shadow, not a gray one: it is the choice that
    // makes the volume read as "painted" rather than as a lowered diffuse.
    shadow: new Color3(0.34, 0.36, 0.48),
    light: Color3.White(),
    softness: 0.06,
};

const RAMP_WIDTH = 256;

const rampCache = new WeakMap<Scene, Map<string, DynamicTexture>>();

function rampKey(spec: CelRampSpec): string {
    const c = (col: Color3): string => `${col.r.toFixed(3)},${col.g.toFixed(3)},${col.b.toFixed(3)}`;
    return `${spec.bands}|${spec.softness.toFixed(3)}|${c(spec.shadow)}|${c(spec.light)}`;
}

function css(col: Color3): string {
    const to255 = (v: number): number => Math.round(Math.min(Math.max(v, 0), 1) * 255);
    return `rgb(${to255(col.r)},${to255(col.g)},${to255(col.b)})`;
}

/** Quantized value of step i (0..bands-1) on the 0..1 axis. */
function stepValue(i: number, bands: number): number {
    return bands <= 1 ? 1 : i / (bands - 1);
}

function buildRamp(scene: Scene, spec: CelRampSpec): DynamicTexture {
    const dt = new DynamicTexture(
        `cel-ramp-${spec.bands}`,
        { width: RAMP_WIDTH, height: 1 },
        scene,
        false,
    );
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;

    if (spec.bands <= 1) {
        // Continuous ramp: the "without cel" reference. It has to be in the
        // SAME pipeline (same material, same fog, same grade) or the comparison
        // measures pipeline differences rather than look differences.
        const grad = ctx.createLinearGradient(0, 0, RAMP_WIDTH, 0);
        grad.addColorStop(0, css(spec.shadow));
        grad.addColorStop(1, css(spec.light));
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, RAMP_WIDTH, 1);
    } else {
        const bandPx = RAMP_WIDTH / spec.bands;
        const softPx = Math.min(spec.softness, 0.49) * bandPx;
        for (let i = 0; i < spec.bands; i++) {
            const t = stepValue(i, spec.bands);
            const col = Color3.Lerp(spec.shadow, spec.light, t);
            const x0 = i * bandPx;
            if (softPx <= 0.5 || i === 0) {
                ctx.fillStyle = css(col);
                ctx.fillRect(x0, 0, bandPx + 1, 1);
                continue;
            }
            // Soft transition on the step's LEFT EDGE: it starts from the
            // previous step's color and arrives at its own. A symmetric gradient
            // straddling the boundary would shift the center of every band, and
            // with 2-3 bands that shift is visible.
            const prev = Color3.Lerp(spec.shadow, spec.light, stepValue(i - 1, spec.bands));
            const grad = ctx.createLinearGradient(x0 - softPx, 0, x0 + softPx, 0);
            grad.addColorStop(0, css(prev));
            grad.addColorStop(1, css(col));
            ctx.fillStyle = grad;
            ctx.fillRect(x0 - softPx, 0, softPx * 2, 1);
            ctx.fillStyle = css(col);
            ctx.fillRect(x0 + softPx, 0, bandPx - softPx + 1, 1);
        }
    }

    dt.update(false);
    dt.wrapU = Texture.CLAMP_ADDRESSMODE;
    dt.wrapV = Texture.CLAMP_ADDRESSMODE;
    // The ramp encodes a light MULTIPLIER, not a screen color: it has to be
    // sampled exactly as it was written, with no gamma decoding. Same reason the
    // decor matcap is gammaSpace=false.
    dt.gammaSpace = false;
    dt.anisotropicFilteringLevel = 1;
    return dt;
}

// ── Fast lane for the hot path ───────────────────────────────────────────────
//
// `getCelRamp` is called from the cel plugin's `bindForSubMesh`, i.e. ONCE PER
// SUBMESH PER FRAME. Building the key there means six `toFixed(3)` calls and as
// many concatenations on every draw call: with ~150 draw calls at 60 fps that is
// tens of thousands of temporary strings per second thrown at the GC, on a frame
// that on mid-tier Android is already main-thread-bound. The cost was not in the cache — which
// is O(1) and always hit — but in COMPUTING the key to query it.
//
// The spec comes from `configureCelPlugin`, which REPLACES it instead of mutating
// it: object identity is therefore a valid test, and it costs zero allocations.
// It only fails towards the slow path (a new tuning recomputes the key once),
// never towards the wrong one.
//
// ⚠️ A corollary of the contract: whoever mutates a spec IN PLACE will not see
// the ramp change. The supported way is to pass a new object, as consumers are expected to do.
let lastRampScene: Scene | null = null;
let lastRampSpec: CelRampSpec | null = null;
let lastRampTex: DynamicTexture | null = null;

/** Per-Scene shared ramp: a single texture per parameter combination. */
export function getCelRamp(scene: Scene, spec: CelRampSpec = DEFAULT_CEL_RAMP): DynamicTexture {
    if (lastRampTex && lastRampScene === scene && lastRampSpec === spec) return lastRampTex;

    let m = rampCache.get(scene);
    if (!m) { m = new Map(); rampCache.set(scene, m); }
    const key = rampKey(spec);
    let tex = m.get(key);
    if (!tex) {
        tex = buildRamp(scene, spec);
        m.set(key, tex);
    }
    lastRampScene = scene;
    lastRampSpec = spec;
    lastRampTex = tex;
    return tex;
}

export function disposeCelRamps(scene: Scene): void {
    // The fast lane has to be invalidated BEFORE the textures are destroyed, or
    // the next bind would return a disposed texture — which does not raise an
    // error, it gives black.
    if (lastRampScene === scene) {
        lastRampScene = null;
        lastRampSpec = null;
        lastRampTex = null;
    }
    const m = rampCache.get(scene);
    if (!m) return;
    for (const tex of m.values()) tex.dispose();
    rampCache.delete(scene);
}
