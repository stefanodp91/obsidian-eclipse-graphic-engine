// Shared material cache scoped per Babylon.js Scene.
// Prevents duplicate material instances for mesh types that all look identical.
// Each key → 1 material shared by N meshes.
// Ref-counted: disposed only when last user calls release().
//
// Two caches: standard (all tiers) and PBR (recommended+).
// Same key can exist in at most one cache per scene — acquireTieredMaterial
// picks the right cache at boot based on quality tier. releaseMaterial checks
// both, so all existing caller patterns (releaseMaterial by key) stay valid.

import type { Scene, AbstractMesh, BaseTexture } from '@babylonjs/core';
import { Color3, DynamicTexture, PBRMaterial, StandardMaterial, Texture } from '@babylonjs/core';
import { getActiveEngineProfile } from '../../domain/engineProfile';
import type { QualityPreset } from '../../domain/qualityTypes';

// ── Provider injection ────────────────────────────────────────────────────────
// Wire the app-side store lookup. Call once at scene-ready before first acquire.
// Default 'mobile-mid' makes the library usable in tests and workbenches without
// a wired store.

let _getQualityPreset: () => QualityPreset = () => 'mobile-mid';

export function configureQualityPresetProvider(fn: () => QualityPreset): void {
    _getQualityPreset = fn;
}

// ── PBR low-tier mask (injectable) ────────────────────────────────────────────
// On qualityTier='lo', allowlisted commodity keys get expensive PBR features
// stripped (clearCoat / subSurface refraction+translucency / iridescence).
// App registers game-specific material keys via configurePBRLowMaskKeys at boot.
// Default: empty set (no masking).

const _lowMaskKeys = new Set<string>();

/** Register material keys that receive PBR feature masking on 'lo' tier.
 *  Call at app-boot before scene creation. Additive — safe to call multiple times. */
export function configurePBRLowMaskKeys(keys: readonly string[]): void {
    for (const k of keys) _lowMaskKeys.add(k);
}

// ── Cache structures ──────────────────────────────────────────────────────────

type StdEntry = { mat: StandardMaterial; refs: number };
type PBREntry = { mat: PBRMaterial; refs: number };
const cache    = new WeakMap<Scene, Map<string, StdEntry>>();
const pbrCache = new WeakMap<Scene, Map<string, PBREntry>>();

function getMap(scene: Scene): Map<string, StdEntry> {
    let m = cache.get(scene);
    if (!m) { m = new Map(); cache.set(scene, m); }
    return m;
}

function getPBRMap(scene: Scene): Map<string, PBREntry> {
    let m = pbrCache.get(scene);
    if (!m) { m = new Map(); pbrCache.set(scene, m); }
    return m;
}

function applyProfileMaterialTweaks(mat: StandardMaterial): void {
    const profile = getActiveEngineProfile(_getQualityPreset());
    // `disableLighting` is incompatible with cel by construction: the bands are
    // derived from ACCUMULATED light, and with no lighting pass there is nothing
    // to quantize — the material would come out flat, with no error anywhere. The
    // saving that flag is after is obtained, under cel, with fewer bands, not by
    // turning the lights off.
    if (profile.disableLighting && decorShadingMode !== 'cel') {
        mat.disableLighting = true;
    }
    if (profile.emissiveBoost !== 1.0 && mat.emissiveColor) {
        mat.emissiveColor = mat.emissiveColor.scale(profile.emissiveBoost);
    }
}

// ── Canonical material constructors ──────────────────────────────────────────

export function createUnlitEmissiveMat(name: string, scene: Scene, color: Color3): StandardMaterial {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor    = Color3.Black();
    m.specularColor   = Color3.Black();
    m.emissiveColor   = color;
    m.disableLighting = true;
    return m;
}

export function createUnlitEmissiveCrystalMat(name: string, scene: Scene, color: Color3, alpha = 0.82): StandardMaterial {
    const m = createUnlitEmissiveMat(name, scene, color);
    m.alpha           = alpha;
    m.backFaceCulling = false;
    return m;
}

/**
 * A surface that lights ITSELF, keeping the color in the VERTICES.
 *
 * It is `createUnlitEmissiveMat` for a vertex-colored mesh: there the color is a
 * uniform and the object comes out in a single tint, here the emissive is white
 * and it is the vertex that gives it its color. In StandardMaterial this works
 * because `finalDiffuse = clamp(diffuseBase*diffuseColor + emissiveColor +
 * ambient)` is then MULTIPLIED by `baseColor`, into which `vColor` has already
 * entered: with diffuse at black and emissive at one, what is left on screen is
 * exactly the tint painted in the vertices, at full intensity and with no scene
 * light touching it.
 *
 * It is for things that EMIT rather than being lit — a bioluminescent mushroom, a
 * vein of lava, a lit rune: objects a night scene must not be able to take
 * brightness away from, because theirs is their own.
 *
 * ⚠️ In a cel world it has to be paired with `excludeFromCel`: there is no
 * accumulated light to quantize (`disableLighting`), so the plugin has nothing to
 * do here — while the ink outline does remain, which is what we want (a shape
 * that glows but is still drawn).
 *
 * `gain` below 1 dims it, above 1 pushes towards white: past unity the shader's
 * clamp saturates the already-high channels before the others, so it is a
 * BURN-OUT lever, not a brightness one — raise it only if warm white at the
 * center is the intended effect.
 */
export function createSelfLitVertexColorMat(
    name: string, scene: Scene, gain = 1,
): StandardMaterial {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor    = Color3.Black();
    m.specularColor   = Color3.Black();
    m.emissiveColor   = new Color3(gain, gain, gain);
    m.disableLighting = true;
    return m;
}

export function createLitVertexColorMat(
    name: string,
    scene: Scene,
    /** Emissive floor. Omitted = decor default (the reference used when calibrating
     *  the shading defaults). An EXPLICIT value is an art-direction choice for that surface
     *  and is honored to the letter — see `FLAT_EMISSIVE_FLOOR_K`. */
    emissiveFloor?: Color3,
    forceFlat = false,
): StandardMaterial {
    const floor = emissiveFloor ?? DECOR_EMISSIVE_FLOOR;
    // Cel branch: the shading comes from the plugin (bands quantized on the
    // accumulated light), so what is needed here is a BARE material — white, with
    // no specular and above all WITHOUT an emissive floor.
    //
    // The floor has to be removed, not reduced: it is a uniform additive lift, and
    // summed after quantization it pushes all the bands upwards until they are
    // squashed onto one another. It is the same reason the matcap uses a scaled
    // version of it instead of the full one, taken to its conclusion: with cel the
    // shadow's floor is the ramp's lowest step, and there is only one of them.
    //
    // An EXPLICIT floor is ignored in this branch too: it was art direction tuned
    // against the previous lighting model, and dragging it in here would mean
    // carrying along a compensation for a problem that no longer exists.
    if (decorShadingMode === 'cel') {
        const m = new StandardMaterial(name, scene);
        m.diffuseColor = Color3.White();
        m.specularColor = Color3.Black();
        m.emissiveColor = Color3.Black();
        return m;
    }
    // Matcap branch: when the decor mode is matcap, the same factory routes to the
    // matcap sibling, scaling the floor (the ramp carries the shading — a full
    // floor would wash it away). Mode 'flat' = the historical path.
    // `forceFlat`: an opt-out for LARGE screen-area surfaces (ground tiles,
    // backdrops) — mid-tier Android measurement, 2026-07-24: the per-fragment
    // reflection path over a full area costs ~+2ms p95, enough to break the mid
    // gate; the matcap stays on small-to-medium decor, where it was judged.
    if (!forceFlat && decorShadingMode !== 'flat') {
        return createMatcapVertexColorMat(
            name, scene, decorShadingMode,
            floor.scale(MATCAP_EMISSIVE_FLOOR_K),
            MATCAP_G4_LEVEL,
        );
    }
    return createFlatLitVertexColorMat(name, scene, emissiveFloor);
}

/** The HISTORICAL decor material — flat lit + vertex color + emissive floor —
 *  built DIRECTLY, without going through the scene's shading mode.
 *
 *  It exists for whoever has to stay outside the world's visual language: under
 *  cel the factory above returns a bare material, which is right for a surface the
 *  plugin will quantize and wrong for one excluded from it (it would come out with
 *  no shading AND no bands, i.e. flat and dull). Whoever calls it also takes on
 *  the burden of `excludeFromCel`: this function picks the recipe, not the
 *  exclusion. */
export function createFlatLitVertexColorMat(
    name: string,
    scene: Scene,
    emissiveFloor?: Color3,
): StandardMaterial {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor  = Color3.White();
    m.specularColor = Color3.Black();
    // Flat path = the `lo` tier (where the matcap deliberately does not reach,
    // since the low tier is held to a stricter budget) + the `forceFlat` surfaces
    // of the flagship and mid tiers. They were the only parts of the scene left
    // with the FULL floor, i.e. exactly the "painted plastic" look the isolated
    // emissive-floor tuning axis rejected: apply the approved candidate (×0.42)
    // there. An explicit floor stays verbatim — it is per-surface art direction
    // and must not be rescaled blindly.
    m.emissiveColor = emissiveFloor ?? DECOR_EMISSIVE_FLOOR.scale(FLAT_EMISSIVE_FLOOR_K);
    return m;
}

export function createFlatLitMat(
    name: string,
    scene: Scene,
    diffuse: Color3,
    emissive: Color3,
): StandardMaterial {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor  = diffuse;
    m.specularColor = Color3.Black();
    m.emissiveColor = emissive;
    return m;
}

// ── Decor matcap (shape-gradient shading, CPU-neutral) ────────────────────────
// A matcap ("material capture") is a small sphere-lit image sampled by the view
// normal: it fakes soft-body shading in ONE fragment lookup, with zero new draw
// calls / meshes / masters / render passes — it folds into the decor material.
// It replaces the flat-vertex-color "plastica dipinta" look on flagship/mid
// decor with a real light→shadow ramp. On a CPU-bound frame this is free (it
// swaps lit math for a texture read). Prototyped in a component workbench before wiring into
// consumer scenes (createLitVertexColorMat branch stays default-OFF until explicitly enabled).

export type DecorMatcapKind = 'soft' | 'rock';

/** Global decor shading mode: 'flat' (default, current state) or one of the
 *  matcap kinds. It has to be set at boot, BEFORE the decor masters are built:
 *  materials already created are not retrofitted. Scaffolding — consumers
 *  do not call it yet (it is switched on by a later opt-in). */
export type DecorShadingMode = 'flat' | 'cel' | DecorMatcapKind;

let decorShadingMode: DecorShadingMode = 'flat';

/** Reviewed G4 package (shading calibration, 3 rounds, 2026-07-24):
 *  ATTENUATED soft matcap — the full additive level (0.38) washed out the vertex
 *  color structure. Level 0.22 + floor ×0.7 = shape shading with the flat path's
 *  colors. */
export const MATCAP_G4_LEVEL = 0.22;

/** Cavity AO baked into the vertex colors (applyBakedSunLight) when the G4
 *  package is active — calibrated value: 0.6 (CavityAO right column). Zero
 *  runtime cost (bake-time only). */
export const MATCAP_G4_CAVITY = 0.6;

/** Reduction factor for the emissive floor when the matcap is active (calibration
 *  round 3: ×0.7, not the ×0.42 of the ratio between the defaults —
 *  with an attenuated matcap the floor drops less). */
export const MATCAP_EMISSIVE_FLOOR_K = 0.7;

/** The decor's reference emissive floor — the value ALL the shading calibration was
 *  done against (the tuning axes start from here). It is no longer
 *  the value shipped on the flat path: see `FLAT_EMISSIVE_FLOOR_K`. */
export const DECOR_EMISSIVE_FLOOR = new Color3(0.34, 0.32, 0.30);

/** Floor reduction on the FLAT path (tier `lo` + `forceFlat` surfaces), where the
 *  matcap does not reach: the candidate approved on the isolated
 *  emissive-floor tuning axis (round 2, ×0.42). The matcap uses its own ×0.7 because it
 *  adds light of its own — the two reductions never stack, the two branches are
 *  alternatives. */
export const FLAT_EMISSIVE_FLOOR_K = 0.42;

export function setDecorShadingMode(mode: DecorShadingMode): void {
    decorShadingMode = mode;
}

// ── MEASUREMENT lever for freezing under cel ───────────────────────────────
//
// Under cel, Standard materials are NOT frozen, because a frozen material does
// not re-upload its uniforms and the cel plugin uploads them in `bindForSubMesh`.
// The cost of giving that up (no skipped re-bind, no reused world matrix) has
// never been measured — the comment in `acquireMaterial` says so explicitly.
//
// ⚠️ Turning this lever on RENDERS WRONG on purpose: the ramp is sampled at t=0
// and the scene comes out in the darkest band. It serves to quantify the cost of
// the non-frozen path, to decide whether it is worth building the real fix
// (freeze, and unfreeze/re-bind only when `configureCelPlugin` changes the
// settings — which changes on world entry, not per frame). Default `false` =
// current behavior. This is not a configuration to ship.
let celFreezeMaterials = false;

export function setCelFreezeMaterials(on: boolean): void {
    celFreezeMaterials = on;
}

/** True when materials are to be frozen under cel too (measurement only). */
export function shouldFreezeUnderCel(): boolean {
    return celFreezeMaterials;
}

export function getDecorShadingMode(): DecorShadingMode {
    return decorShadingMode;
}

// Cache key: `${kind}@${level}` — the additive level is tunable per material (a
// matcap that is too additive washes out the vertex colors, review feedback
// 2026-07-24).
const matcapCache = new WeakMap<Scene, Map<string, DynamicTexture>>();

function buildDecorMatcap(scene: Scene, kind: DecorMatcapKind): DynamicTexture {
    const SIZE = 128;
    const dt = new DynamicTexture(`decor-matcap-${kind}`, { width: SIZE, height: SIZE }, scene, false);
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;
    // Light from the upper-left; radial falloff to a dark rim (the unlit side of
    // the sphere). 'rock' = higher-contrast ramp + a tight specular hotspot
    // (glossy stone); 'soft' = low-contrast matte ramp (foliage / organic).
    const lx = SIZE * 0.36, ly = SIZE * 0.32;
    const grad = ctx.createRadialGradient(lx, ly, SIZE * 0.04, SIZE * 0.5, SIZE * 0.5, SIZE * 0.72);
    if (kind === 'rock') {
        grad.addColorStop(0.00, '#ffffff');
        grad.addColorStop(0.14, '#d7d7d7');
        grad.addColorStop(0.48, '#7d7d7d');
        grad.addColorStop(1.00, '#242424');
    } else {
        grad.addColorStop(0.00, '#e8e8e8');
        grad.addColorStop(0.50, '#8f8f8f');
        grad.addColorStop(1.00, '#333333');   // deeper shadow side → more shape, less "plasticine"
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIZE, SIZE);
    if (kind === 'rock') {
        const hs = ctx.createRadialGradient(lx, ly, 0, lx, ly, SIZE * 0.13);
        hs.addColorStop(0, 'rgba(255,255,255,0.85)');
        hs.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = hs;
        ctx.fillRect(0, 0, SIZE, SIZE);
    }
    dt.update(false);
    dt.coordinatesMode = Texture.SPHERICAL_MODE;   // reflection-vector sphere map = matcap
    dt.wrapU = Texture.CLAMP_ADDRESSMODE;
    dt.wrapV = Texture.CLAMP_ADDRESSMODE;
    dt.gammaSpace = false;                          // encodes a shading ramp, sample linear
    dt.level = kind === 'rock' ? 0.55 : 0.38;       // additive contribution (subtle: shade, don't wash)
    return dt;
}

/** Shared per-scene procedural matcap: ONE 128² texture per (kind, level) →
 *  every decor material of that combo reuses it (CPU-neutral). `level` overrides
 *  the additive contribution (per-kind defaults: rock 0.55 / soft 0.38). */
export function getDecorMatcap(scene: Scene, kind: DecorMatcapKind = 'soft', level?: number): DynamicTexture {
    let m = matcapCache.get(scene);
    if (!m) { m = new Map(); matcapCache.set(scene, m); }
    const key = `${kind}@${level ?? 'default'}`;
    let tex = m.get(key);
    if (!tex) {
        tex = buildDecorMatcap(scene, kind);
        if (level !== undefined) tex.level = level;
        m.set(key, tex);
    }
    return tex;
}

/** Matcap-shaded sibling of createLitVertexColorMat: same white-diffuse /
 *  vertex-color-driven albedo, but with a matcap sphere-map adding a view-
 *  dependent shape gradient (one fragment lookup, no new DC/mesh/pass). The
 *  emissive floor is LOWER than the flat variant because the matcap now carries
 *  the light→shadow ramp instead of a flat lift. Default-OFF for consumers: reached
 *  only when the tier branch (or a story) asks for it. */
export function createMatcapVertexColorMat(
    name: string,
    scene: Scene,
    kind: DecorMatcapKind = 'soft',
    emissiveFloor: Color3 = new Color3(0.14, 0.13, 0.12),
    matcapLevel?: number,
): StandardMaterial {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor  = Color3.White();
    m.specularColor = Color3.Black();
    m.emissiveColor = emissiveFloor;
    m.reflectionTexture = getDecorMatcap(scene, kind, matcapLevel);
    return m;
}

// ── Shared material acquire / release ─────────────────────────────────────────

export function acquireMaterial(
    scene: Scene,
    key: string,
    factory: (mat: StandardMaterial) => void,
): StandardMaterial {
    const m = getMap(scene);
    let entry = m.get(key);
    if (!entry) {
        const mat = new StandardMaterial(key, scene);
        factory(mat);
        applyProfileMaterialTweaks(mat);
        // A frozen material does NOT re-upload its uniforms after the first bind,
        // and the cel plugin uploads them exactly there (`bindForSubMesh`).
        // Freezing it leaves `celRampScale` at zero, the ramp is sampled at t=0
        // and every surface comes out in the darkest band: a uniformly dark scene
        // that reacts to NO tuning at all — the most misleading symptom possible,
        // because it looks like a calibration error.
        //
        // Freezing is a real optimization (it skips recomputing the world matrix
        // and the re-bind), so giving it up has a cost: it is one of the items the
        // mid-tier performance gate has to measure.
        if (decorShadingMode !== 'cel' || celFreezeMaterials) mat.freeze();
        entry = { mat, refs: 0 };
        m.set(key, entry);
    }
    entry.refs++;
    return entry.mat;
}

function maskExpensivePbrFeatures(mat: PBRMaterial): void {
    mat.clearCoat.isEnabled = false;
    mat.subSurface.isRefractionEnabled = false;
    mat.subSurface.isTranslucencyEnabled = false;
    mat.iridescence.isEnabled = false;
}

export function acquirePBRMaterial(
    scene: Scene,
    key: string,
    factory: (mat: PBRMaterial) => void,
): PBRMaterial {
    const m = getPBRMap(scene);
    let entry = m.get(key);
    if (!entry) {
        const mat = new PBRMaterial(key, scene);
        factory(mat);
        if (_lowMaskKeys.has(key)
            && getActiveEngineProfile(_getQualityPreset()).qualityTier === 'lo') {
            maskExpensivePbrFeatures(mat);
        }
        mat.freeze();
        entry = { mat, refs: 0 };
        m.set(key, entry);
    }
    entry.refs++;
    return entry.mat;
}
/**
 * A two-road material: PBR where lighting is on, Standard where it is not.
 *
 * ⚠️ UNDER CEL THE CHOICE DOES NOT EXIST — and its absence was a silent defect.
 *
 * The cel plugin lives on `StandardMaterial` and on nothing else: on a PBR it
 * does not attach at all. Without this branch, every object acquired from here on
 * a flagship or mid-range phone (where `disableLighting` is false) came out lit in
 * PBR **inside a cel world** — no error, no warning, and on screen a handful of
 * glossy objects in the middle of a banded scene. It is the same defect the
 * `cel/` bench had paid for in the sample application, where baked mode drew nothing because
 * `tryBakeCelHull` silently refuses every non-Standard material: the same rule,
 * from the other side.
 *
 * And taking the Standard road is not enough: the caller's factory is tuned for
 * the PREVIOUS lighting model, so it brings a specular and an EMISSIVE FLOOR.
 * Under cel the floor is a uniform additive lift summed AFTER quantization: it
 * pushes all the bands upwards until they squash onto one another, i.e. it washes
 * away exactly the shading cel exists to give. Both are zeroed out, as
 * `createLitVertexColorMat` already does — where a real glow is needed, the road
 * under cel is the plugin's emissive lift, not the material's floor.
 */
export function acquireTieredMaterial(
    scene: Scene,
    key: string,
    stdFactory: (mat: StandardMaterial) => void,
    pbrFactory: (mat: PBRMaterial) => void,
): StandardMaterial | PBRMaterial {
    if (decorShadingMode === 'cel') {
        return acquireMaterial(scene, key, (mat) => {
            stdFactory(mat);
            mat.specularColor = Color3.Black();
            mat.emissiveColor = Color3.Black();
        });
    }
    const profile = getActiveEngineProfile(_getQualityPreset());
    if (!profile.disableLighting) {
        return acquirePBRMaterial(scene, key, pbrFactory);
    }
    return acquireMaterial(scene, key, stdFactory);
}

/**
 * The textures the material OWNS, by naming convention.
 *
 * `Material.dispose()` does not touch textures (Babylon's default is
 * `forceDisposeTextures=false`), and that is the RIGHT default: a shared texture
 * — the decor matcap, the bush3d bump, the cel ramp — belongs to its cache, not to
 * the last material that lets go of it, and destroying it from there would blacken
 * all the others. But the per-material procedural bumps
 * (`${m.name}-reef-bump`, `${m.name}-skin-bump`: see `materials.types.ts`) have no
 * other home, so without this line they stay in the scene forever. Measured by
 * alternating two worlds without ever closing the app: scene textures 18 → 56 over
 * four rounds, a fresh copy of every bump on each re-entry into the world, and the
 * heap behind it (up to ~900 MB) — on a phone that is the point at which the
 * system kills the WebView.
 *
 * The discriminator is the PREFIX carrying the material's name, and it is the
 * honest one: it is the convention by which whoever creates the texture declares
 * that it is theirs and nobody else's. The shared ones never carry it — they could
 * not, they do not belong to a single material — so there is no way this pass
 * picks them up by mistake.
 */
function ownedTextures(mat: StandardMaterial | PBRMaterial): BaseTexture[] {
    const prefix = `${mat.name}-`;
    return mat.getActiveTextures().filter((t) => t.name?.startsWith(prefix));
}

/** Disposes the material + the textures it owns. The list is taken BEFORE the
 *  dispose: afterwards, the material no longer exposes them. */
function disposeWithOwnedTextures(mat: StandardMaterial | PBRMaterial): void {
    const owned = ownedTextures(mat);
    mat.unfreeze();
    mat.dispose();
    for (const tex of owned) tex.dispose();
}

export function releaseMaterial(scene: Scene, key: string): void {
    const m = cache.get(scene);
    if (m) {
        const entry = m.get(key);
        if (entry) {
            if (process.env['NODE_ENV'] !== 'production' && pbrCache.get(scene)?.has(key)) {
                // eslint-disable-next-line no-console
                console.warn(`[MaterialLibrary] key "${key}" found in BOTH caches (std+PBR) — invariant violated, release is ambiguous`);
            }
            entry.refs--;
            if (entry.refs <= 0) {
                disposeWithOwnedTextures(entry.mat);
                m.delete(key);
            }
            return;
        }
    }
    releasePBRMaterial(scene, key);
}

export function releasePBRMaterial(scene: Scene, key: string): void {
    const m = pbrCache.get(scene);
    if (!m) return;
    const entry = m.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
        disposeWithOwnedTextures(entry.mat);
        m.delete(key);
    }
}

export function disposeAll(scene: Scene): void {
    const std = cache.get(scene);
    if (std) {
        for (const entry of std.values()) disposeWithOwnedTextures(entry.mat);
        cache.delete(scene);
    }
    const pbr = pbrCache.get(scene);
    if (pbr) {
        for (const entry of pbr.values()) disposeWithOwnedTextures(entry.mat);
        pbrCache.delete(scene);
    }
    const matcaps = matcapCache.get(scene);
    if (matcaps) {
        for (const tex of matcaps.values()) tex.dispose();
        matcapCache.delete(scene);
    }
}

export function peekMaterial(scene: Scene, key: string): StandardMaterial | null {
    return cache.get(scene)?.get(key)?.mat ?? null;
}

export function peekPBRMaterial(scene: Scene, key: string): PBRMaterial | null {
    return pbrCache.get(scene)?.get(key)?.mat ?? null;
}

export function forceCompileMaterial(
    scene: Scene,
    key: string,
    mesh: AbstractMesh,
): Promise<void> {
    // One-cache-per-key invariant (M-3): a key lives in EITHER the Standard or
    // the PBR cache, never both. Compile BOTH the non-instanced and the
    // hardware-instanced (INSTANCES define) variant regardless of material class:
    // pooled meshes render as InstancedMesh (createInstance), so the instanced
    // form is the one used live, while a direct material lookup wants the plain
    // form. Standard previously compiled only the non-instanced variant, leaving
    // its INSTANCES form to compile on the first live render (low tier, where
    // obstacle materials are Standard) — a transition-window recompile.
    const mat = peekMaterial(scene, key) ?? peekPBRMaterial(scene, key);
    if (!mat) return Promise.resolve();
    const compile = (useInstances: boolean): Promise<void> =>
        new Promise<void>((resolve) => {
            mat.forceCompilation(mesh, () => resolve(), { clipPlane: false, useInstances });
        });
    return Promise.all([compile(false), compile(true)]).then(() => undefined);
}
