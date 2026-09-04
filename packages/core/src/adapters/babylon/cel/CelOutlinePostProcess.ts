// Outline — candidate A: edge detection in post-process.
//
// A single fullscreen pass reads the G-buffer (depth + normals) and draws a line
// wherever either of the two has a discontinuity. It does not touch the
// geometry: it works for regular meshes, for instances and for merged meshes
// alike, and it does not add a single draw call.
//
// The stroke comes out at a CONSTANT thickness in pixels, independent of
// distance. That is an aesthetic choice, not a limitation: distant objects keep a
// readable outline instead of watching it thin out until it disappears. Candidate
// B (inverted hull) does the opposite. They are needed side by side to decide.
//
// What this candidate CANNOT do: draw a line where there is no depth or normal
// discontinuity — that is, the internal details drawn on a continuous surface.
// Those remain the job of the ink rim (celInkRim) or of the texture.

import type { AbstractMesh, Camera, Nullable, Scene, Texture } from '@babylonjs/core';
import {
    Color3, Effect, GeometryBufferRenderer, Mesh, PostProcess, Vector2,
} from '@babylonjs/core';
// ⚠️ SIDE-EFFECT IMPORT, and without it the hull does not exist.
//
// `renderOutline` / `outlineWidth` / `outlineColor` are NOT native properties of
// `AbstractMesh`: this module attaches them, together with the renderer that
// draws them. A consumer importing Babylon à la carte will not have it, so
// without this line `mesh.renderOutline` is `undefined` — not `false` — and
// writing to it does nothing and raises no error.
//
// It costs an hour to find that out from the symptom: the hull outline looked
// FREE (54 fps against the post-process's 33) and in fact was not being drawn at
// all. The signal that exposed the fake win was the draw calls — identical to the
// no-outline case, whereas a hull adds one per object. When an optimization looks
// free, count.
import '@babylonjs/core/Rendering/outlineRenderer';
import { bakeCelHullIntoMesh, isCelHullBaked } from './celHull';

export interface CelOutlineOptions {
    color: Color3;
    /** Kernel radius in pixels. Above ~2 the stroke doubles up on closely spaced
     *  edges (the kernel samples past the next silhouette). */
    thickness: number;
    /** Sensitivity to DEPTH discontinuity, as a fraction of the pixel's depth.
     *  Scaled this way because buffer precision drops with distance and an
     *  absolute threshold would produce noise in the far field. */
    depthThreshold: number;
    /** Sensitivity to NORMAL discontinuity — this is the term that finds internal
     *  creases (where depth is continuous but the surface bends). */
    normalThreshold: number;
    /** Distance IN METERS beyond which the outline fades out; the fade starts at
     *  60% of this value. 0 = never.
     *
     *  The unit is meters and not a normalized depth because Babylon's G-buffer
     *  writes z in VIEW space, i.e. already in world units. With the wrong reading
     *  (0..1) a plausible-looking value such as 0.16 switches the outline off
     *  across the whole scene, and it looks like the fade is broken. */
    fadeDistance: number;
    /** Diagnostic view of the source buffers. An edge-detect that draws nothing
     *  always has at least three possible causes (empty buffer, an encoding other
     *  than the expected one, wrong threshold) and by eye they are
     *  indistinguishable: this is the lever that separates them in one shot
     *  instead of by trial and error. */
    debug: CelOutlineDebug;
    /** If true, the G-buffer draws ONLY the meshes declared essential
     *  (`markCelOutlineEssential`) instead of the whole scene.
     *
     *  It removes draw calls — measured on the mid-tier reference device
     *  (Galaxy A25, Mali-G68), 157 → 95 — but buys few fps: 33.2 → 36.5. The
     *  bulk of the outline's cost is NOT the submission of the second pass; see
     *  the note on `gBufferRatio`, which is the real lever.
     *
     *  It stays useful in combination, and for a reason that is not speed: the
     *  reduced list is also a DRAWING choice — the stroke on the heroes and not on
     *  the backdrop is a hierarchy, not just a saving.
     *
     *  The price is visual and has to be stated: the scenery loses the stroke on
     *  its own silhouettes. What it keeps is the ink rim the material draws by
     *  itself on curved surfaces, which is a different and complementary
     *  mechanism. */
    essentialOnly: boolean;
    /** Fraction of the screen resolution at which the G-buffer is drawn. 1 =
     *  full.
     *
     *  ⚠️ It looks like the obvious lever and it is NOT: on the mid-tier
     *  reference device, taking it to 0.5 buys 1.2 fps out of a 20 fps gap. Written down here
     *  because it is exactly the kind of optimization that gets attempted twice —
     *  the second time with the same conviction as the first. The cost lives in
     *  the fullscreen pass (see `postProcessRatio`), not in the source it reads.
     *
     *  The price is the SHARPNESS of the stroke: the outline comes out of the
     *  edge-detect over these buffers, so at half resolution the line thickens and
     *  gets stair-stepped on diagonals. It has to be looked at, not deduced. */
    gBufferRatio: number;
    /** Fraction of the resolution at which the edge-detect FULLSCREEN PASS runs.
     *
     *  ⚠️ Once the other two are ruled out, this is where the cost is. Measured on
     *  that same device, four variants paired at equal vertex counts:
     *
     *    full outline                      32.8 fps · DC 158
     *    reduced list (−62 draw calls)     36.5 fps        → +3.3
     *    G-buffer at half resolution       34.0 fps        → +1.2
     *    outline off                       53.2 fps · DC  82  → +20
     *
     *  The two «obvious» levers together buy 4 fps out of 20. The rest is this
     *  pass: it runs at full resolution and does NINE texture reads per pixel
     *  (five depth, four normals) over ~1.8 million pixels, i.e. ~16 million
     *  samples per frame on a Mali-G68.
     *
     *  The price is stroke sharpness, and it is more visible than with
     *  `gBufferRatio`: here it is the resolution of the DRAWING that drops, not
     *  that of the source. Look at it on screen before shipping it. */
    postProcessRatio: number;
    /** DEPTH-ONLY source instead of the depth+normals G-buffer.
     *
     *  The `GeometryBufferRenderer` is a multi-render-target: it writes two
     *  full-screen textures per frame. The `DepthRenderer` writes one. If the cost
     *  the other levers do not explain is the MRT itself — allocation, clear and
     *  writeback of two targets — this halves it.
     *
     *  The price is the NORMALS TERM, i.e. the internal creases: silhouettes and
     *  depth discontinuities remain, folds on a continuous surface are lost. Under
     *  cel that is not a small thing — but the material's ink rim covers part of
     *  the same job, and on geometry made of flat faces many folds are depth jumps
     *  as well. */
    depthOnly: boolean;
}

export type CelOutlineDebug = 'off' | 'depth' | 'normal' | 'edge';

const DEBUG_CODE: Record<CelOutlineDebug, number> = { off: 0, depth: 1, normal: 2, edge: 3 };

export const DEFAULT_CEL_OUTLINE: CelOutlineOptions = {
    color: new Color3(0.04, 0.03, 0.06),
    thickness: 1.0,
    depthThreshold: 0.020,
    normalThreshold: 0.35,
    fadeDistance: 0,
    debug: 'off',
    gBufferRatio: 1,
    postProcessRatio: 1,
    depthOnly: false,
    // By default the outline covers the WHOLE scene: that is the behavior the
    // look was judged against, and narrowing it is a choice the caller has to
    // declare.
    essentialOnly: false,
};

const SHADER_NAME = 'celOutline';

const OUTLINE_FRAGMENT = /* glsl */ `
precision highp float;

varying vec2 vUV;

uniform sampler2D textureSampler;
uniform sampler2D depthSampler;
uniform sampler2D normalSampler;

uniform vec2  texelSize;
uniform vec3  outlineColor;
uniform float thickness;
uniform float depthThreshold;
uniform float normalThreshold;
uniform float fadeDistance;
uniform float debugView;

// WEBGPU CONSTRAINT — every sample is taken at the top, BEFORE any branch. WGSL
// requires textureSample to be called in uniform control flow (it needs the
// quad's derivatives); an early return on the sky, or a sample inside an if, make
// compilation fail with «must only be called from uniform control flow». In
// WebGL2 the same code would compile. So: everything is always sampled, and the
// conditions become multiplications.
void main(void) {
    vec3 scene = texture2D(textureSampler, vUV).rgb;

    vec2 o = texelSize * thickness;
    // Roberts cross on the diagonals: four samples instead of Sobel's eight. On
    // a binary outline the difference is invisible, and this pass runs at full
    // resolution.
    vec2 uvA = vUV + vec2(-o.x, -o.y);
    vec2 uvB = vUV + vec2( o.x,  o.y);
    vec2 uvC = vUV + vec2(-o.x,  o.y);
    vec2 uvD = vUV + vec2( o.x, -o.y);

    float dC = texture2D(depthSampler, vUV).r;
    float dA = texture2D(depthSampler, uvA).r;
    float dB = texture2D(depthSampler, uvB).r;
    float dCc = texture2D(depthSampler, uvC).r;
    float dD = texture2D(depthSampler, uvD).r;

    vec3 nA = texture2D(normalSampler, uvA).rgb;
    vec3 nB = texture2D(normalSampler, uvB).rgb;
    vec3 nC = texture2D(normalSampler, uvC).rgb;
    vec3 nD = texture2D(normalSampler, uvD).rgb;

    // A test on the CURVATURE of depth, not on its slope.
    //
    // Comparing two opposite samples (|dA - dB|) looks like the obvious thing and
    // does not work: on a surface seen edge-on — terrain running towards the
    // horizon — depth changes enormously from one pixel to the next even though
    // there is no edge at all, and the whole distance turns black.
    //
    // The mean of the two opposites compared against the center, by contrast,
    // cancels any LINEAR variation: a plane, however grazing, gives zero response.
    // Only the real discontinuities are left — silhouettes and folds.
    float depthEdge = max(
        abs((dA + dB) * 0.5 - dC),
        abs((dCc + dD) * 0.5 - dC)
    );
    // Threshold proportional to depth: buffer precision drops with distance, and
    // a fixed threshold would make noise appear in the far field.
    float depthHit = step(depthThreshold * dC, depthEdge);

    float normalEdge = max(1.0 - dot(nA, nB), 1.0 - dot(nC, nD));
    float normalHit = step(normalThreshold, normalEdge);

    float edge = max(depthHit, normalHit);

    // Sky/background: the G-buffer stays at 0 where nothing has been written.
    // Without this zeroing the horizon would become a continuous black line.
    edge *= step(1e-6, dC);

    // fadeDistance == 0 means "never": the smoothstep has to be neutralized
    // without a branch, or we fall back into the control-flow problem above.
    float fadeOn = step(1e-6, fadeDistance);
    float fade = 1.0 - smoothstep(fadeDistance * 0.6, max(fadeDistance, 1e-6), dC);
    edge *= mix(1.0, fade, fadeOn);

    vec3 result = mix(scene, outlineColor, edge);

    // Diagnostic views. Depth is amplified because the buffer, if it is
    // normalized on the far plane, lives entirely in the first hundredths of the
    // range and without scaling reads as solid black — which is indistinguishable
    // from an unwritten buffer, i.e. exactly the ambiguity this view has to
    // resolve.
    if (debugView > 2.5)      result = vec3(edge);
    else if (debugView > 1.5) result = nA * 0.5 + 0.5;
    else if (debugView > 0.5) result = vec3(fract(dC * 10.0), dC, dC * 100.0);

    gl_FragColor = vec4(result, 1.0);
}
`;

Effect.ShadersStore[`${SHADER_NAME}PixelShader`] = OUTLINE_FRAGMENT;

/** Meshes that must NOT appear in the outline's G-buffer.
 *
 *  Useful for elements whose SILHOUETTE does not match what is seen: billboards,
 *  halos, reflection planes. They are the exception, not the rule — the outline
 *  exists to draw shapes, and taking it away from a real shape makes it invisible
 *  rather than discreet. */
const outlineExcluded = new WeakSet<object>();

/** Keeps a mesh out of the ink outline. */
export function excludeFromCelOutline(mesh: object): void {
    outlineExcluded.add(mesh);
}

/** The ESSENTIAL meshes: the ones the outline draws even when the G-buffer stops
 *  drawing everything else (see `essentialOnly`).
 *
 *  ⚠️ Marking is POSITIVE and the consumer's responsibility, not an engine heuristic.
 *  The engine is brand-agnostic and does not know what an obstacle is: if it
 *  tried to guess — by size, by distance, by name — it would fail silently on the
 *  first new model, and the defect would be «sometimes an object has no outline»,
 *  which is the most expensive class of bug to chase. */
const outlineEssential = new WeakSet<object>();

// ── HULL mode: the outline in the mesh instead of in the frame ─────────────
//
// The post-process draws the stroke by reading depth and normals of the WHOLE
// scene, and on a mid-tier Android device that second pass costs ~20 fps that
// will not come down (five levers tried, the best buys 3.7 — see the field
// notes above). The inverted hull does the same job with the opposite
// mechanism: a copy of the mesh inflated along the normals with front faces
// culled, i.e. ONE EXTRA DRAW CALL PER OBJECT and no scene pass, no render
// target, no multi-render-target.
//
// Babylon's `renderOutline` is used here rather than `celHull.ts` on purpose: it
// is the same technique, and for MEASURING the cost it is perfectly adequate.
// `celHull` exists because it keeps color and thickness on a shared material
// instead of on every mesh — which matters when thickness is the axis being
// tuned, not when the question is «how much does it cost».
//
// ⚠️ The known defect is one of SHAPE, not of speed: the hull tears on hard
// edges, where per-face normals diverge and the inflated copy splits open. Cel
// geometry is made of hard edges. It has to be looked at on screen.
let hullMode = false;
let hullWidth = 0.035;
let hullColor: Color3 = new Color3(0.04, 0.03, 0.06);
/** Below this DIAGONAL (in meters) a mesh does not get the hull. 0 = all of them.
 *
 *  Size is the right discriminator for two reasons at once: large shapes are the
 *  ones that make the frame's silhouette (losing them shows, losing a tuft does
 *  not), and they are also the ones on which the hull does NOT fall apart — the
 *  tearing on edges is the more visible the smaller and denser the piece. The
 *  heroes (`outlineEssential`) ALWAYS pass, at any size: a small pickup needs
 *  its stroke or it disappears. */
let hullMinDiagonal = 0;

/** Above this number of THIN INSTANCES a mesh does not get the baked hull.
 *  The cost of baking is the doubling of vertices MULTIPLIED by the instances: a
 *  mass-instanced species (×123, ×116 in one measured scene) pays for the hull a
 *  hundred times, for a stroke that on dense repeated specimens reads far less than it
 *  costs. The heroes pass regardless. Infinity = no cap. */
let hullMaxThinInstances = Number.POSITIVE_INFINITY;

/** Applies (or removes) the hull on a mesh, if it is a mesh that can have one.
 *
 *  ⚠️ The test is `'renderOutline' in mesh` and NOT `typeof … === 'boolean'`.
 *  Babylon defines the property on `Mesh.prototype` with a getter returning
 *  `this._renderOutline`, and that field is BORN `undefined`: a mesh nobody has
 *  written an outline to yet answers `undefined`, not `false`. The wrong guard
 *  silently discarded every mesh, and the result was an outline that never
 *  switched on for anyone while everything looked fine.
 *
 *  Nothing is written on the INSTANCES: `renderOutline` lives on `Mesh`, not on
 *  `AbstractMesh`. It is not needed — Babylon's outline renderer draws the
 *  MASTER's hull together with its instance batch, so marking the master covers
 *  them all. */
function applyHull(mesh: object, on: boolean): void {
    if (!('renderOutline' in mesh)) return;
    const m = mesh as { renderOutline?: boolean; outlineWidth?: number; outlineColor?: Color3 };
    m.outlineWidth = hullWidth;
    m.outlineColor = hullColor;
    m.renderOutline = on;
}

/** Observer that dresses the heroes born AFTER the switch-on. */
let hullObserver: { remove(): void } | null = null;

/** The per-frame sweep of BAKED mode (see below). It has to be kept so it can be
 *  removed: the first draft only ever added it, and every remount of the pipeline
 *  (world change, quality change) accumulated one more — each one a pass over
 *  `scene.meshes` every frame, on a world that is already CPU-bound. */
let hullBakeSweep: { remove(): void } | null = null;

/**
 * Switches the hull outline on for the essential meshes.
 *
 * ⚠️ It applies both to those already born and to those yet to be born, and that
 * is not a luxury: the first draft only applied it at marking time, and since the
 * pools and the ground tiles mark their meshes BEFORE the post-processing pipeline
 * is mounted, the result was ZERO meshes with a hull — with a twenty-fps gain
 * that looked like the solution and was in fact simply the absence of the
 * outline. Measured, not assumed: `renderOutline` true on 0 meshes out of 729.
 */
/** The hull in BAKED mode: the border geometry is attached to the mesh instead of
 *  switching `renderOutline` on. Zero extra draw calls — see the note in
 *  `bakeCelHullIntoMesh` for the measurements that justify a third mode existing.
 *  Baking is irreversible at runtime: it only goes away on reload. */
let hullBaked = false;

export function setCelOutlineHullMode(
    scene: Scene, on: boolean, width = 0.035, color?: Color3, minDiagonal = 0,
    baked = false, maxThinInstances = Number.POSITIVE_INFINITY,
): void {
    hullMode = on;
    hullBaked = baked;
    hullWidth = width;
    hullMinDiagonal = minDiagonal;
    hullMaxThinInstances = maxThinInstances;
    if (color) hullColor = color;

    hullObserver?.remove();
    hullObserver = null;
    hullBakeSweep?.remove();
    hullBakeSweep = null;

    // ⚠️ The hull dresses EVERYTHING that is not excluded, not just the heroes.
    //
    // The first draft stopped at the heroes and the result, seen on screen, was
    // that the SCENERY lost its stroke: flowers, boulders, giants and backdrop
    // turned into flat patches next to outlined obstacles. The outline is not a
    // decoration for important objects — it is what holds the visual language
    // together, and applied halfway it reads as a rendering defect.
    //
    // The rule is therefore the SAME as the post-process's (`!outlineExcluded`),
    // so that the two techniques draw the same set and are comparable: whoever
    // does not want the stroke declares it mesh by mesh, in one single place, and
    // it applies to both.
    const wants = (mesh: AbstractMesh): boolean => {
        if (outlineExcluded.has(mesh)) return false;
        if (hullMinDiagonal <= 0 || isEssential(mesh)) return true;
        const bb = mesh.getBoundingInfo().boundingBox;
        const dx = bb.maximum.x - bb.minimum.x;
        const dy = bb.maximum.y - bb.minimum.y;
        const dz = bb.maximum.z - bb.minimum.z;
        return dx * dx + dy * dy + dz * dz >= hullMinDiagonal * hullMinDiagonal;
    };

    const dress = (mesh: AbstractMesh, enable: boolean): void => {
        if (!hullBaked) { applyHull(mesh, enable); return; }
        if (!enable) return;
        // ⚠️ Baking CANNOT happen when the mesh is born: `new Mesh()` adds it to
        // the scene BEFORE `applyToMesh` gives it its vertices, and baking over
        // empty geometry is a silent no-op. It bakes on the first frame in which
        // the geometry is there — the delay is invisible (the mesh is born
        // off-screen, in the prewarm or beyond the fog).
        if (mesh instanceof Mesh && mesh.getTotalVertices() > 0) {
            // Already baked = never touch it again: without this early exit, on
            // the next pass baking answers false («already done») and a baked
            // hero would ALSO get the per-mesh hull — a double outline and one
            // draw call given away, per mesh, forever.
            if (isCelHullBaked(mesh)) return;
            // MASS species: above the thin-instance cap the hull is not baked
            // (see `hullMaxThinInstances`). Skipped without memoizing: the count
            // can grow later, and a permanent refusal here would be decided on a
            // number that is not yet true.
            if (mesh.thinInstanceCount > hullMaxThinInstances && !isEssential(mesh)) return;
            const baked = bakeCelHullIntoMesh(mesh, hullWidth, hullColor);
            // The HEROES that baking refuses (non-Standard material — a PBR
            // character above all) keep the per-mesh hull: that is one draw
            // call each, and there is a handful of them. Heroes only: for the
            // scenery that cannot be baked, the rim draws the stroke.
            if (!baked && isEssential(mesh) && !noHullFallback.has(mesh)) applyHull(mesh, true);
        }
    };

    for (const mesh of scene.meshes) {
        if (wants(mesh)) dress(mesh, on);
    }
    if (!on) return;
    hullObserver = scene.onNewMeshAddedObservable.add((mesh) => {
        if (wants(mesh)) dress(mesh, true);
    });
    if (hullBaked) {
        // A per-frame sweep for meshes born empty (see above): the predicate and
        // the WeakSets (baked + refused) reduce the pass to one lookup per mesh.
        const obs = scene.onBeforeRenderObservable.add(() => {
            for (const mesh of scene.meshes) {
                if (wants(mesh)) dress(mesh, true);
            }
        });
        hullBakeSweep = { remove: () => scene.onBeforeRenderObservable.remove(obs) };
    }
}

/** Declares a mesh essential to the outline. */
export function markCelOutlineEssential(mesh: object): void {
    outlineEssential.add(mesh);
}

/** Heroes that must NOT fall back to the `renderOutline` hull when baking
 *  refuses them. In baked mode every fallback is a real draw call (the mesh is
 *  drawn twice), and draw calls — not vertices — are the scarce currency on mid-tier Android
 *  (~0.13 fps each). Ground tiles are the typical case: essential for the
 *  G-buffer list, but their border is already drawn by the props sitting on the
 *  seam — eight draw calls for a stroke that is already there. */
const noHullFallback = new WeakSet<object>();

/** Excludes a hero from baked mode's `renderOutline` fallback (it stays in the
 *  post-process G-buffer, where it costs nothing per mesh). */
export function markCelOutlineNoHullFallback(mesh: object): void {
    noHullFallback.add(mesh);
}

/** A mesh is a hero if either it or the master it is instanced from is one:
 *  instances are objects in their own right and inherit nothing from their master
 *  — the same trap already paid for on the props' `metadata`. */
function isEssential(mesh: AbstractMesh): boolean {
    if (outlineEssential.has(mesh)) return true;
    const src = (mesh as { sourceMesh?: object }).sourceMesh;
    return src !== undefined && outlineEssential.has(src);
}

export interface CelOutlineHandle {
    readonly postProcess: PostProcess;
    apply(patch: Partial<CelOutlineOptions>): void;
    readonly options: Readonly<CelOutlineOptions>;
    dispose(): void;
}

/** Attaches the post-process outline to the camera. Returns null if the G-buffer
 *  is unavailable: better no outline than a pass that samples non-existent
 *  textures and paints the screen black. */
export function attachCelOutline(
    scene: Scene,
    camera: Camera,
    overrides: Partial<CelOutlineOptions> = {},
): Nullable<CelOutlineHandle> {
    const opts: CelOutlineOptions = { ...DEFAULT_CEL_OUTLINE, ...overrides };

    // ── Source: G-buffer (depth+normals) or depth only ─────────────────────
    const depthRenderer = opts.depthOnly
        // `storeCameraSpaceZ` = depth in METERS of view space, i.e. the same unit
        // the G-buffer writes. Without it, thresholds tuned on `fadeDistance` in
        // meters would act on a different range and the outline would change
        // character without any parameter having been touched — see the note on
        // `fadeDistance`.
        ? scene.enableDepthRenderer(camera, false, false, undefined, true)
        : null;

    const gbr = opts.depthOnly ? null : scene.enableGeometryBufferRenderer(opts.gBufferRatio);
    if (!opts.depthOnly && !gbr) return null;
    // World-space normals remain stable while the camera moves. View-space
    // normals would make internal outlines flicker on nearly tangent surfaces.
    if (gbr) gbr.generateNormalsInWorldSpace = true;
    // ⚠️ TARGETED exclusion, not by category.
    //
    // The first attempt removed ALL transparent surfaces from the G-buffer, to
    // get rid of a single case: a BILLBOARD quad used for a reflection, which,
    // always facing the camera, has a rectangle for a silhouette — and the
    // outline drew an ink frame around it, permanently.
    //
    // The remedy was too broad and carried away with it the outline of every
    // TRANSLUCENT PICKUP: with no stroke, a pale translucent sphere on a light
    // ground becomes invisible. Those objects were vanishing from the scene with
    // nothing in their own code able to explain it.
    //
    // So the transparent ones stay in — the outline is what makes them READABLE —
    // and whoever does not want the stroke declares it mesh by mesh.
    if (gbr) gbr.renderTransparentMeshes = true;
    // The predicate lives on the G-buffer's render target, not on the renderer:
    // it is the render target that rebuilds the mesh list on every pass.
    const sourceRtt = gbr ? gbr.getGBuffer() : depthRenderer?.getDepthMap();
    if (sourceRtt) {
        sourceRtt.renderListPredicate = (mesh: AbstractMesh): boolean =>
            opts.essentialOnly
                ? isEssential(mesh) && !outlineExcluded.has(mesh)
                : !outlineExcluded.has(mesh);
    }
    // ⚠️ The source MEASUREMENT, printed once. `enableGeometryBufferRenderer`
    // returns the ALREADY EXISTING renderer if there is one, and in that case it
    // IGNORES the requested ratio: without this line a "half resolution"
    // experiment can be run at full resolution with nothing to say so, and the
    // null result reads as «the lever does not help» instead of «the lever was
    // never pulled». It has happened before.
    if (sourceRtt) {
        const sz = sourceRtt.getSize();
        // eslint-disable-next-line no-console
        console.log(`[celOutline] sorgente=${opts.depthOnly ? 'depth' : 'gbuffer'} `
            + `${sz.width}x${sz.height} ratioRichiesto=${opts.gBufferRatio} `
            + `pp=${opts.postProcessRatio} essentialOnly=${opts.essentialOnly}`);
    }

    const depthIdx = gbr ? gbr.getTextureIndex(GeometryBufferRenderer.DEPTH_TEXTURE_TYPE) : -1;
    const normalIdx = gbr ? gbr.getTextureIndex(GeometryBufferRenderer.NORMAL_TEXTURE_TYPE) : -1;
    if (gbr && (depthIdx < 0 || normalIdx < 0)) return null;

    const engine = scene.getEngine();
    const pp = new PostProcess(
        SHADER_NAME,
        SHADER_NAME,
        ['texelSize', 'outlineColor', 'thickness', 'depthThreshold', 'normalThreshold', 'fadeDistance', 'debugView'],
        ['depthSampler', 'normalSampler'],
        opts.postProcessRatio,
        camera,
    );

    const texel = new Vector2(0, 0);
    pp.onApply = (effect): void => {
        let depthTex: Texture | undefined;
        let normalTex: Texture | undefined;
        if (gbr) {
            const textures = gbr.getGBuffer().textures;
            depthTex = textures[depthIdx] as Texture | undefined;
            normalTex = textures[normalIdx] as Texture | undefined;
        } else if (depthRenderer) {
            // With no normals, depth is bound to BOTH samplers: the normals term
            // stays in the shader but is neutralized by the threshold (below), so
            // there is no need for a second shader variant to be kept in sync
            // with this one.
            depthTex = depthRenderer.getDepthMap() as unknown as Texture;
            normalTex = depthTex;
        }
        if (!depthTex || !normalTex) return;
        effect.setTexture('depthSampler', depthTex);
        effect.setTexture('normalSampler', normalTex);
        texel.set(1 / engine.getRenderWidth(), 1 / engine.getRenderHeight());
        effect.setVector2('texelSize', texel);
        effect.setColor3('outlineColor', opts.color);
        effect.setFloat('thickness', opts.thickness);
        effect.setFloat('depthThreshold', opts.depthThreshold);
        // An unreachable threshold in depth-only mode: `step()` always returns 0,
        // so the normals term switches off without any branching.
        effect.setFloat('normalThreshold', opts.depthOnly ? 1e9 : opts.normalThreshold);
        effect.setFloat('fadeDistance', opts.fadeDistance);
        effect.setFloat('debugView', DEBUG_CODE[opts.debug]);
    };

    return {
        postProcess: pp,
        options: opts,
        apply(patch) { Object.assign(opts, patch); },
        dispose() {
            pp.dispose(camera);
            if (gbr) scene.disableGeometryBufferRenderer();
            if (depthRenderer) scene.disableDepthRenderer(camera);
        },
    };
}
