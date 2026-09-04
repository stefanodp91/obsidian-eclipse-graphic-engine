// Cel-shading inside a StandardMaterial, as a plugin.
//
// WHY IT EXISTS, given that `CelMaterial` already does this: the prototype could
// afford a ShaderMaterial because it built its own scene from scratch. An existing
// application cannot — `acquireMaterial` and `acquireTieredMaterial` return
// `StandardMaterial`/`PBRMaterial`, and in a real codebase hundreds of files
// depend on that. A plugin injects the same math into the existing
// StandardMaterial **without touching a single call site**: that is what turns
// adopting cel into a matter of days instead of months.
//
// ── Where it hooks in, and why exactly there ────────────────────────────────
//
// Darkening the final color is not enough: the bands have to fall on the LIGHT,
// before fog and grade touch it. In Babylon's StandardMaterial the right spot is
// where the accumulated lighting (`diffuseBase`) is composed into
// `finalDiffuse`. There is no hook there, but plugins can replace code by regular
// expression (keys starting with `!`), and this is exactly that use case.
//
// The three variants of that line (EMISSIVEASILLUMINATION, LINKEMISSIVEWITHDIFFUSE,
// plain) are all present in the source before the preprocessor runs, so all three
// have to be covered: two patterns suffice, and neither touches the other uses of
// `diffuseBase` (declaration and light accumulation).
//
// ── How it quantizes without knowing the lights ─────────────────────────────
//
// `CelMaterial` derives the band from NdotL, which it knows because the key is
// one of its own uniforms. Here the lights belong to the scene, in variable
// number, and NdotL is not recoverable. So what gets quantized is the LUMINANCE
// of `diffuseBase`, the sum of the diffuse contributions: same curve, same banded
// reading, and it works with one light just as well as with four. `rampScale`
// maps the scene's useful range onto 0..1.
//
// ── The one structural difference, and how it is compensated ────────────────
//
// Verified on screen in `cel/CelPluginParity` (2026-08-04): the two paths give
// the SAME band structure, but not the same level. The reason lies in the order
// of operations:
//
//   CelMaterial :  albedo * (band(NdotL) * light + fill)   ← fill OUTSIDE
//   plugin      :  albedo *  band(key + fill)              ← fill INSIDE
//
// In the prototype the hemispheric fill is additive and not quantized (a
// deliberate choice: quantizing the ambient as well makes two quantizations beat
// against each other and spurious steps appear). In StandardMaterial the ambient
// is a LIGHT, so it is already inside `diffuseBase` and gets quantized along with
// the key: the shadow band loses its additive floor and closes darker.
//
// This is compensated by raising the ramp's shadow step — the same `ramp.shadow`
// lever, tuned against a different input. It goes without saying that the values
// do NOT carry over from the prototype: they have to be retuned against the
// scene's real lighting rig, and they are the only thing that changes between the
// two paths.

import type { AbstractEngine, AbstractMesh, Nullable, Scene, SubMesh, UniformBuffer } from '@babylonjs/core';
import { Color3, Material, MaterialDefines, MaterialPluginBase, RegisterMaterialPlugin } from '@babylonjs/core';
import { getCelRamp, DEFAULT_CEL_RAMP, type CelRampSpec } from './celRamp';
import { getCelHatch, NO_HATCH, type CelHatchSpec } from './celHatching';
import { shouldFreezeUnderCel } from '../MaterialLibrary';

export interface CelPluginSettings {
    ramp: CelRampSpec;
    hatch: CelHatchSpec;
    /** Maps `diffuseBase` luminance onto the ramp axis. Raise it if the scene
     *  is dark (the high bands would never be reached) and lower it if it is
     *  bright (everything collapses onto the last band). */
    rampScale: number;
    inkColor: Color3;
    /** Inner ink rim: darkens the edge of curved surfaces, where a depth
     *  edge-detect finds no discontinuity and draws nothing. */
    rimStrength: number;
    rimWidth: number;
    hatchStrength: number;
    hatchScale: number;
}

export const DEFAULT_CEL_PLUGIN: CelPluginSettings = {
    ramp: DEFAULT_CEL_RAMP,
    hatch: NO_HATCH,
    rampScale: 1.15,
    inkColor: new Color3(0.05, 0.04, 0.07),
    rimStrength: 0,
    rimWidth: 0.35,
    hatchStrength: 0,
    hatchScale: 256,
};

/** A material's WIND: how much, and how, its geometry bends.
 *
 *  ── Why it lives in the material and not in a tick ─────────────────────────
 *
 *  The cel scenery is made of THIN INSTANCES: hundreds of copies of a handful of
 *  masters, whose matrices are rewritten at 10 Hz only to rewind the window
 *  (a consumer-side decor tick). Moving them from the CPU would mean recomposing
 *  every matrix every frame — that is, paying for the motion exactly what
 *  instancing exists to avoid paying. In the vertex shader the cost is two sines
 *  per vertex and it never crosses the main thread, which on mid-tier Android is
 *  the scarce currency.
 *
 *  ── Why the height is squared ──────────────────────────────────────────────
 *
 *  A plant is fixed to the ground and free at the top: the foot does not move,
 *  the tip does. `h²` is the cheapest approximation of that constraint (a single
 *  multiply), and without it the whole mesh would slide sideways — which does not
 *  read as wind, it reads as a placement bug.
 *
 *  ⚠️ THE OUTLINE DOES NOT BEND. The ink stroke is a post-process over the
 *  G-buffer, which is drawn by its own shaders (depth/geometry) and not by this
 *  one: what moves here is the surface, not its depth. That is why the stock
 *  amplitudes are in CENTIMETERS and not decimeters — beyond that, the outline
 *  visibly detaches from the silhouette. */
export interface CelWindSpec {
    /** Displacement in METERS at height `height`. Above ~8 cm the ink stroke
     *  starts to detach (see above). */
    amplitude: number;
    /** Height, in meters above the instance BASE, at which `amplitude` holds. */
    height: number;
    /** Cycles per second of the slow oscillation. */
    hz: number;
    /** Wind direction in the plane; it gets normalized. A single one for the
     *  whole scene is what makes the motion «wind» instead of «each on its own». */
    dirX: number;
    dirZ: number;
}

/** A stock wind: a breeze. Tuned on two-meter-tall plants — five centimeters at
 *  the tip, one cycle every four and a half seconds, with the gusts the pattern
 *  brings along. */
export const DEFAULT_CEL_WIND: CelWindSpec = {
    amplitude: 0.05, height: 2, hz: 0.22, dirX: 1, dirZ: 0.35,
};

/** THE SURGE — SYNCHRONOUS displacement, the wind's opposite twin.
 *
 *  The wind (`CelWindSpec`) offsets every instance by its own position: a field
 *  in phase would be a metronome. This channel does the opposite, and that is why
 *  it exists separately instead of being a wind with the phase zeroed out: **all
 *  the instances move together**, because some things in nature are a single
 *  body. A wave that arrives in pieces is not a wave.
 *
 *  ⚠️ The PHASE is written by the caller, every frame, by mutating this very
 *  object: the plugin HOLDS it (it does not copy it) and re-reads it at every
 *  bind. It is the same convention as the consumer-side current zones, and for the same
 *  reason — a phase the engine computed on its own would be a second clock, and
 *  two clocks diverge. Whoever already has a phase (a backwash, a breath, a
 *  pulse) simply passes it in.
 *
 *  ⚠️ The displacement is NOT weighted by height, unlike the wind: a tongue of
 *  foam is flat, and a quadratic weight on height would leave it still. Here the
 *  whole body moves, which is what a backwash does. */
export interface CelSurgeSpec {
    /** Amplitude in meters, at the peak of the phase. */
    amplitude: number;
    /** Direction in the plane. Normalized by the plugin. */
    dirX: number;
    dirZ: number;
    /** Phase in RADIANS. Written by the caller every frame. */
    phase: number;
}

/** THE NAME OF THE WING-BEAT ATTRIBUTE, which the consumer has to write onto the
 *  master's vertices: `x` = how far that vertex is from its own body's axis,
 *  normalized to [0,1]; `y` = THAT individual's phase, in [0,1).
 *
 *  ⚠️ An attribute and not a uniform, because a flock master holds seven birds
 *  merged into a single mesh and each one has to beat on its own: the only thing
 *  that tells one bird from another in the vertex shader is what is written in
 *  its vertices. And an attribute and not the UVs, because on a material with no
 *  texture the UVs are not even declared (`UV1` is off) and forcing them drags in
 *  the varyings of the whole texture chain.
 *
 *  ⚠️ A missing attribute is not an error: WebGL reads it as `(0,0,0,1)`, so zero
 *  weight, so no beat. That is why this channel can sit on the same material as
 *  species that know nothing about wings. */
export const CEL_FLAP_ATTRIBUTE = 'celFlapData';

/** The per-vertex BOB data: `x` marks the body and says where along its axis the
 *  vertex sits, `y` is that body's phase.
 *
 *  ⚠️ The marking and the position live in the SAME number, and that is not
 *  stinginess: a vertex that does not carry the attribute reads **zero**, and
 *  zero has to mean «does not float». If `x` were only the position along the
 *  axis, zero would mean «amidships» — that is, the whole scene would bob, the
 *  solid ground included. So `x = 0` means still and `x ∈ [1,2]` means
 *  floating, with `s = (x − 1.5)·2` in [−1,1] from stern to bow. */
export const CEL_BOB_ATTRIBUTE = 'celBobData';

/** THE WING-BEAT — motion around a BODY's axis, not around the ground.
 *
 *  The wind bends what is planted: it weights the displacement by the height
 *  above the instance BASE, because the foot stays put. A bird has no foot, and
 *  eleven meters up that quadratic law would give it two meters of lateral drift
 *  instead of a beat.
 *
 *  Here the weight is the distance from the **body's axis** and the displacement
 *  is VERTICAL: at the root the wing does not move, at the tip it takes
 *  everything. The phase is per individual, and it lives in the vertices (see
 *  `CEL_FLAP_ATTRIBUTE`) because a flock in phase is seven copies of one thing.
 *
 *  ⚠️ Like the glint, this channel does not ask for a material of its own:
 *  whoever lacks the attribute has zero weight. A separate material is useful, if
 *  at all, to take the WIND away — which on a bird is the defect. */
export interface CelFlapSpec {
    /** Vertical displacement in meters at the wing tip. */
    amplitude: number;
    /** Beats per second. A gliding gull stays below 1; a tern above. */
    hz: number;
}

/** THE BOB — the motion of what FLOATS, which is heave plus pitch.
 *
 *  It applies to a ship, a buoy, a moored boat: anything that sits on the water
 *  and is not anchored to the bottom. The wind cannot describe it — it weights
 *  the displacement by the height above the base, so on a funnel nine meters up
 *  it bends the ship like a shrub (measured on a tall mesh: 9.9 m of
 *  translation) — and neither can the wing-beat, because its law is the square of
 *  the distance from the axis.
 *
 *  ⚠️ Like the glint and the beat, it does not ask for a material of its own:
 *  whoever does not carry `CEL_BOB_ATTRIBUTE` stays still. That is why a whole
 *  scene needs three materials and not ten.
 *
 *  ⚠️ Real frequencies are LOW. A hundred-and-forty-meter ferry has a six-to-eight
 *  second period, i.e. around **0.15 Hz**: above half a hertz any hull turns into
 *  a cork. */
export interface CelBobSpec {
    /** Heave: meters of the whole body rising and falling. */
    amplitude: number;
    /** Oscillations per second. A ferry stays below 0.2; a buoy higher. */
    hz: number;
    /** Pitch: meters of offset at the ends, in quadrature with the heave.
     *  At zero the body behaves like an elevator. */
    pitch: number;
}

/** THE GLINT — the only channel that does NOT move geometry.
 *
 *  Some objects' animation is not a movement: a lighthouse does not sway, it
 *  **lights up**. Wind and surge cannot describe it, because both displace
 *  vertices, and displacing a lighthouse is exactly the defect to remove.
 *
 *  ⚠️ THE MASK IS A RESERVED COLOR, and the road that looked obvious does not
 *  exist. The alpha of the vertex color looked like the perfect channel — already
 *  carried, already merged by `MergeMeshes`, free — but **Babylon throws it
 *  away**: its vertex shader does `vColor = vec4(1.0); vColor.rgb *= color.rgb;`,
 *  and the alpha only comes in under `VERTEXALPHA`, which turns transparency on
 *  and would turn the lamp into a hole. Measured by reading the generated source,
 *  2026-08-17.
 *
 *  What is left is the only channel that really reaches the fragment:
 *  `vColor.rgb`. A vertex whose color is EXACTLY `key` is a lamp. It works
 *  without wide epsilons because these are flat-shaded, non-indexed meshes: the
 *  three vertices of a face share one color, so the interpolator has nothing to
 *  interpolate and the value arrives intact. The price is that the color is
 *  RESERVED: anyone using it for decoration lights a lamp by mistake.
 *
 *  ⚠️ The RHYTHM is the signature. A lighthouse does not breathe on a sine: it
 *  stays dark for a long time and then flashes — «the rhythm of the flashes is
 *  the optical signature of the individual lighthouse». That is what `duty` is
 *  for: the fraction of the cycle in which the light is on. At `duty` 1 this
 *  channel becomes a pulse, which is a different object. */
export interface CelGlintSpec {
    /** The color of the light when ON. The off color is the model's own. */
    color: Color3;
    /** The RESERVED vertex color that marks a lamp (see above). */
    key: Color3;
    /** Cycles per second. A coastal lighthouse sits between 0.1 and 0.3. */
    hz: number;
    /** Fraction of the cycle in which the light is on, in [0,1]. Below ~0.25 it
     *  reads as a flash; above ~0.6 as a breath. */
    duty: number;
    /** How much the lit color covers the model's color, in [0,1]. */
    strength: number;
}

/** Settings shared by ALL instances of the plugin.
 *
 *  They are global because cel is a scene-wide art direction, not a property of
 *  the individual object: with hundreds of decor materials, a per-material
 *  retune would be a loop over hundreds of objects instead of a single write.
 *  Per-material control, if it is ever needed, can be added later. */
const settings: CelPluginSettings = { ...DEFAULT_CEL_PLUGIN };

/** Registered here rather than read from `settings` at every bind: they change
 *  rarely, and rebuilding them every frame would mean one cache lookup per
 *  material per frame. */
let rampDirty = true;
let hatchDirty = true;

export function configureCelPlugin(patch: Partial<CelPluginSettings>): void {
    Object.assign(settings, patch);
    if (patch.ramp) rampDirty = true;
    if (patch.hatch) hatchDirty = true;
}

export function getCelPluginSettings(): Readonly<CelPluginSettings> {
    return settings;
}

// ── Injected GLSL code ─────────────────────────────────────────────────────
// It does not reuse `CEL_FRAGMENT_FUNCTIONS` verbatim: those functions start
// from NdotL and from their own uniforms, whereas here we start from the
// already-accumulated light and from StandardMaterial's uniforms. The MATH is
// the same — ramp lookup, fresnel rim, screen-space hatching — and that is why
// the look matches.

// ⚠️ The DEFINITIONS do not live inside `#ifdef CEL`, and that is not an
// oversight.
//
// The `finalDiffuse` substitution (below) is TEXTUAL and unconditional: once the
// plugin has entered a material's chain, that text stays in the shader forever.
// Babylon does not remove a plugin that has already been activated — turning
// `isEnabled` off only lowers the define. If the definitions were behind
// `#ifdef CEL` too, a material that was switched on and then OFF (cel→legacy
// world change, a material opting out of cel, a hot quality change) would end up
// calling a function that no longer exists:
//
//   FRAGMENT SHADER ERROR: 'celQuantizeLight': no matching overloaded function
//
// and the material would vanish from the scene. By defining it ALWAYS, and
// having it return the light untouched when cel is off, the off branch is
// bit-identical to stock Babylon and the transition is safe in both directions.
// ⚠️ THE SAMPLERS ARE DECLARED HERE, and not among the plugin's uniforms. This
// was measured, not deduced (2026-08-07): the `fragment` string from
// `getUniforms()` is emitted by the manager at the
// `ADDITIONAL_FRAGMENT_DECLARATION` marker, which exists ONLY in the
// `defaultFragmentDeclaration` include — the path WITHOUT uniform buffers. Where
// UBOs are available, Babylon includes `defaultUboDeclaration`, which does not
// have that marker: the whole string is silently thrown away.
//
// The scalars survive because they are also in the `ubo` list (and from there
// they end up inside `uniform Material { … }`); a sampler cannot live in a
// uniform buffer, so it would stay undeclared — and a shader that references a
// non-existent identifier does not compile:
//
//   'celRampSampler' : undeclared identifier
//   'texture' : no matching overloaded function found
//   'rgb' : field selection requires structure, vector, ...
//
// which is exactly the set of errors seen on mid-tier Android GPUs, where UBOs are active. On
// desktop they did not reproduce, for a reason that has nothing to do with cel:
// there Babylon sets `disableUniformBuffers = true`, so the broken path was
// never taken. Reproduced by forcing `disableUniformBuffers = false` on Chrome.
//
// `CUSTOM_FRAGMENT_DEFINITIONS`, by contrast, lives in `default.fragment.fx` and
// does not depend on UBOs: it is the only place that works on both paths. It
// sits at the top of this block because the functions below use it.
const CEL_DEFINITIONS = /* glsl */ `
#ifdef CEL
uniform sampler2D celRampSampler;
uniform sampler2D celHatchSampler;
#endif

vec3 celQuantizeLight(vec3 lit) {
#ifdef CEL
    // Perceptual luminance, not an arithmetic mean: with a warm key the mean
    // would shift the band according to the light's HUE instead of its
    // intensity, and two equally lit surfaces would fall into different bands
    // just because one of them is redder.
    float lum = dot(lit, vec3(0.299, 0.587, 0.114));
    return texture2D(celRampSampler, vec2(clamp(lum * celRampScale, 0.0, 1.0), 0.5)).rgb;
#else
    return lit;
#endif
}

#ifdef CEL
// THE HATCHING LIVES IN THE DARKEST BAND, AND ONLY THERE — see celHatch on the
// ShaderMaterial path, where the rule is the same line for line. rampU is the
// 0..1 coordinate BEFORE quantization; the first band ends at 1/celRampBands,
// and the fade over the last 15% only exists to keep the boundary from snapping
// by a pixel.
float celPluginHatch(vec2 fragCoord, float rampU) {
    if (celHatchStrength <= 0.0) return 1.0;
    float h = texture2D(celHatchSampler, fragCoord / max(celHatchScale, 1.0)).r;
    float edge = celRampBands > 0.5 ? 1.0 / celRampBands : 0.34;
    float mask = 1.0 - smoothstep(edge * 0.85, edge, rampU);
    return 1.0 - (1.0 - h) * mask * celHatchStrength;
}

float celPluginRim(vec3 n, vec3 v) {
    if (celRimStrength <= 0.0) return 0.0;
    float fres = 1.0 - clamp(dot(n, v), 0.0, 1.0);
    return smoothstep(1.0 - celRimWidth, 1.0, fres) * celRimStrength;
}
#endif
`;

/** Hatching and rim: applied to the composed color, but BEFORE fog and grade.
 *  After the fog the hatching would show up on distant objects that have already
 *  faded out, and after the grade its intensity would change with saturation.
 *
 *  ⚠️ THE HATCHING LOOKS AT THE LIGHT, NOT AT THE COLOR — and up to 0.1.1 it
 *  looked at the color. The mask received `dot(color.rgb, ...)`, i.e. the band
 *  already multiplied by the albedo, so the hatching followed the object's HUE
 *  instead of its lighting: a gray stone in full sun got hatched because it is
 *  gray, a white surface in shadow stayed clean because it is white, and a
 *  dark-toned scene got hatched from edge to edge. The proof that it was not the
 *  light: with the ramp forced all-white — no shadow anywhere — the hatching
 *  remained.
 *
 *  Now `celRampU` comes in, the 0..1 coordinate along the ramp axis BEFORE
 *  quantization: the same one `celQuantizeLight` uses to pick the band,
 *  recomputed here with a multiply instead of a second texture lookup. It is also
 *  why the boundary sits on the COORDINATE and not on the band's luminance: the
 *  shadow tint is art direction and changes per level, whereas the band index is
 *  the same everywhere.
 *
 *  ⚠️ THE EMISSIVE ENTERS THE MASK, and that is not a detail: **something that
 *  emits light is not in shadow**. Received light and own light are two different
 *  things only for the color computation; for the hatching they are the same,
 *  because the question it has to ask is «is this surface in the dark?». Without
 *  that term a self-lit object receives zero, falls into the first band and takes
 *  the full hatching: measured in a consumer application, self-illuminated
 *  pickups came out hatched, whereas in 0.1.1 they were clean, because there the
 *  mask looked at the finished color and a glowing object came out bright. The
 *  new rule fixed one defect and created another until the emissive was summed
 *  in here.
 *
 *  In the `EMISSIVEASILLUMINATION` and `LINKEMISSIVEWITHDIFFUSE` variants the
 *  emissive is already inside `diffuseBase` and gets counted twice: it only moves
 *  the mask towards «more lit», i.e. towards less hatching, which is the
 *  direction in which being wrong ruins nothing.
 *
 *  ⚠️ `diffuseBase` and `emissiveColor` are declared WITHOUT a guard in
 *  `default.fragment.fx`, before the marker this block hooks into, so they are
 *  always in scope. */
const CEL_BEFORE_FOG = /* glsl */ `
#ifdef CEL
{
    float celRampU = clamp(dot(diffuseBase + emissiveColor, vec3(0.299, 0.587, 0.114)) * celRampScale, 0.0, 1.0);
    color.rgb *= celPluginHatch(gl_FragCoord.xy, celRampU);
    color.rgb = mix(color.rgb, celInkColor, celPluginRim(normalW, viewDirectionW));
}
#endif
`;

// THE GLINT, AFTER hatching and rim and not before: a light source is not
// hatched and does not take the ink stroke on its edge. Applying it earlier
// would mean drawing the shading of a lamp that is switched on.
//
// The mask lives in the ALPHA of the vertex color (see `CelGlintSpec`): alpha 0
// = lamp, alpha 1 = everything else. `VERTEXCOLOR` is required, because without
// a vertex color there is no alpha to read — and without that guard the shader
// would not compile on flat-tinted materials.
const CEL_GLINT_BEFORE_FOG = /* glsl */ `
#if defined(CELGLINT) && defined(VERTEXCOLOR)
{
    // A deliberately tight threshold: on flat-shaded, non-indexed meshes a
    // face's color arrives exactly as it was written, so a wide threshold would
    // only serve to light up something merely similar by mistake.
    float celGlintM = step(distance(vColor.rgb, celGlintKey), 0.004);
    color.rgb = mix(color.rgb, celGlint.rgb, celGlintM * celGlint.w);
}
#endif
`;

// ── The wind, in the vertex shader ─────────────────────────────────────────
//
// It hooks into `CUSTOM_VERTEX_UPDATE_WORLDPOS`, which is the only right spot:
// there `worldPos` has already been computed and `finalWorld` is in scope, so
// the geometry can be bent along WORLD axes — all instances in the same
// direction, which is what tells wind apart from jitter — and the instance base
// can be taken from `finalWorld[3]` without knowing whether we are under
// hardware instancing, thin instances or a plain mesh. One stage earlier
// (`UPDATE_POSITION`) only local space would be available, and a field of
// randomly rotated plants would bend outwards like a fan.
//
// The PHASE comes from the instance position, not from the vertex position: that
// way every plant sways on its own (a field in phase is a metronome) while
// staying RIGID in itself, without deforming internally.
const CEL_WIND_WORLDPOS = /* glsl */ `
#ifdef CELWIND
{
    vec3 celWindBase = finalWorld[3].xyz;
    float celWindH = max(worldPos.y - celWindBase.y, 0.0);
    // Quadratic weight on the height, normalized to the reference height: the
    // foot stays nailed down, the tip takes everything.
    float celWindW = celWindH * celWindH * celWind.w;
    float celWindPh = celWindTime * celWind.z + celWindBase.x * 0.37 + celWindBase.z * 0.23;
    // The GUSTS: a second, very slow sine that opens and closes the amplitude.
    // Without it the field breathes forever at the same rhythm, which on screen
    // is faker than standing still.
    float celWindG = 0.55 + 0.45 * sin(celWindPh * 0.31);
    worldPos.xz += celWind.xy * (sin(celWindPh) * celWindG * celWindW);
}
#endif
`;

// THE SURGE, at the same injection point as the wind and for the same reason:
// `UPDATE_WORLDPOS` is after the world transform, so it works for anything —
// plain mesh, hardware instance, thin instance.
//
// ⚠️ No position term in the phase, and that is the whole difference from the
// wind: the phase comes from the uniform and nothing else, so every instance
// moves in the same direction at the same instant. Adding a `finalWorld` term
// here would mean rewriting the wind under another name.
const CEL_SURGE_WORLDPOS = /* glsl */ `
#ifdef CELSURGE
{
    worldPos.xz += celSurge.xy * sin(celSurge.z);
}
#endif
`;

// THE BEAT, at the same injection point as the wind and for the same reason:
// `UPDATE_WORLDPOS` works for anything — plain mesh, hardware instance, thin
// instance. But the LAW is the opposite of the wind's, and that is the whole
// point: the weight does not come from the height above the instance base, it
// comes from an attribute saying how far that vertex is from its own body's axis.
//
// SQUARED weight as in the wind, and for the same physical reason: a wing is
// hinged at the shoulder, so the root does not move and the tip takes
// everything. Linear, the wing would look like a stretched piece of rubber.
const CEL_FLAP_WORLDPOS = /* glsl */ `
#ifdef CELFLAP
{
    float celFlapW = celFlapData.x * celFlapData.x;
    worldPos.y += celFlapArgs.x * celFlapW
        * sin(celFlapTime * celFlapArgs.y + celFlapData.y * 6.2831853);
}
#endif
`;

// THE BOB — it is not a slow beat: it is TWO motions in quadrature.
//
// A floating body does two things at once, and each is the other's delay: it
// **heaves** (the whole body rises and falls, in phase with the wave) and it
// **pitches** (the bow rises while the stern drops, i.e. a motion proportional to
// the position along the axis, in quadrature with the first). A quarter period
// apart, the two together make the circular movement the eye recognizes as «at
// sea».
//
// With heave alone a ship is an elevator; with pitch alone it is a swing nailed
// in place. It is also why this could not be `flap` at another frequency: there
// the weight is |distance from the axis| and it is squared, here it is the
// SIGNED position along the axis and a second, phase-shifted term is needed.
//
// Vertical only, on purpose: a real pitch also rotates in z, but on a horizon
// silhouette that component is invisible and would cost twice as much.
const CEL_BOB_WORLDPOS = /* glsl */ `
#ifdef CELBOB
{
    float celBobMark = step(0.5, celBobData.x);
    float celBobS = (celBobData.x - 1.5) * 2.0;
    float celBobPh = celBobTime * celBobArgs.y + celBobData.y * 6.2831853;
    worldPos.y += celBobMark * (celBobArgs.x * sin(celBobPh)
        + celBobArgs.z * celBobS * cos(celBobPh));
}
#endif
`;

/** The wind's clock, per scene.
 *
 *  ⚠️ It advances once per FRAME and not at every bind: `bindForSubMesh` is
 *  called once per sub-mesh, so accumulating the delta there would make time run
 *  faster the more objects are on screen — that is, the wind would become a
 *  function of the scene's complexity.
 *
 *  The delta is capped at 50 ms: after a stall (level change, GC) a half-second
 *  frame would make the whole field JUMP sideways. */
const windClocks = new WeakMap<Scene, { frame: number; t: number }>();

function celWindTimeFor(scene: Scene): number {
    const frame = scene.getFrameId();
    let clock = windClocks.get(scene);
    if (!clock) { clock = { frame, t: 0 }; windClocks.set(scene, clock); }
    if (clock.frame !== frame) {
        clock.frame = frame;
        // The modulo keeps time inside the useful precision of a 32-bit float:
        // an hour of play would push the phase to a few thousand radians, and
        // from there on the sine starts moving in steps.
        clock.t = (clock.t + Math.min(scene.getEngine().getDeltaTime(), 50) / 1000) % 3600;
    }
    return clock.t;
}

class CelMaterialPlugin extends MaterialPluginBase {
    private _isEnabled = false;
    private _wind: CelWindSpec | null = null;
    private _surge: CelSurgeSpec | null = null;
    private _glint: CelGlintSpec | null = null;
    private _flap: CelFlapSpec | null = null;
    private _bob: CelBobSpec | null = null;

    constructor(material: Material) {
        // Priority 200: after Babylon's own plugins (which sit below 100), so
        // that cel sees the color already composed by any other injections.
        // ⚠️ The defines all have to be DECLARED here. `prepareDefines` can only
        // change the value of a key that already exists: writing an undeclared
        // one produces no `#define` at all, and the shader block waiting for it
        // stays off forever — with no error, no warning, and with the plugin
        // looking fine under inspection (measured 2026-08-08: the wind was in
        // the plugin, not in the shader).
        super(material, 'Cel', 200, {
            CEL: false, CELWIND: false, CELSURGE: false, CELGLINT: false, CELFLAP: false,
            CELBOB: false,
        });
    }

    get isEnabled(): boolean {
        return this._isEnabled;
    }

    set isEnabled(enabled: boolean) {
        if (this._isEnabled === enabled) return;
        this._isEnabled = enabled;
        // The define changes the shape of the shader: without this, the material
        // would keep using the previously compiled program.
        this.markAllDefinesAsDirty();
        this._enable(enabled);
    }

    get wind(): CelWindSpec | null {
        return this._wind;
    }

    /** ⚠️ The wind lives INSIDE cel: without the plugin switched on there is no
     *  shader to inject it into. That matches what is actually needed — the wind
     *  belongs to the cel look, it is not a generic Babylon feature — and it
     *  keeps the shader variant out of every material that does not use it. */
    set wind(spec: CelWindSpec | null) {
        this._wind = spec;
        this.markAllDefinesAsDirty();
    }

    get surge(): CelSurgeSpec | null {
        return this._surge;
    }

    /** ⚠️ The object is HELD, not copied: whoever passes it in mutates its
     *  `phase` every frame and the bind re-reads it. Copying it here would make
     *  the phase writable exactly once — that is, a frozen wave. */
    set surge(spec: CelSurgeSpec | null) {
        this._surge = spec;
        this.markAllDefinesAsDirty();
    }

    get glint(): CelGlintSpec | null {
        return this._glint;
    }

    set glint(spec: CelGlintSpec | null) {
        const had = this._glint !== null;
        this._glint = spec;
        if (had !== (spec !== null)) this.markAllDefinesAsDirty();
    }

    get flap(): CelFlapSpec | null {
        return this._flap;
    }

    set flap(spec: CelFlapSpec | null) {
        const had = this._flap !== null;
        this._flap = spec;
        if (had !== (spec !== null)) this.markAllDefinesAsDirty();
    }

    get bob(): CelBobSpec | null {
        return this._bob;
    }

    set bob(spec: CelBobSpec | null) {
        const had = this._bob !== null;
        this._bob = spec;
        if (had !== (spec !== null)) this.markAllDefinesAsDirty();
    }

    override getClassName(): string {
        return 'CelMaterialPlugin';
    }

    override prepareDefines(defines: MaterialDefines): void {
        defines['CEL'] = this._isEnabled;
        defines['CELWIND'] = this._isEnabled && this._wind !== null;
        defines['CELSURGE'] = this._isEnabled && this._surge !== null;
        defines['CELGLINT'] = this._isEnabled && this._glint !== null;
        defines['CELFLAP'] = this._isEnabled && this._flap !== null;
        defines['CELBOB'] = this._isEnabled && this._bob !== null;
    }

    override getUniforms(): {
        ubo: { name: string; size: number; type: string }[]; vertex: string; fragment: string;
    } {
        return {
            ubo: [
                // The wind is in the `ubo` list and not only in the vertex
                // string, for the same reason as the others: where uniform
                // buffers exist the `Material` block is THE SAME in both stages,
                // so a single declaration serves vertex and fragment.
                { name: 'celWind', size: 4, type: 'vec4' },
                { name: 'celWindTime', size: 1, type: 'float' },
                { name: 'celSurge', size: 4, type: 'vec4' },
                // rgb = lit color, w = how lit it is RIGHT NOW: the glint is
                // computed on the CPU once per bind instead of per fragment.
                { name: 'celGlint', size: 4, type: 'vec4' },
                { name: 'celGlintKey', size: 3, type: 'vec3' },
                { name: 'celFlapArgs', size: 2, type: 'vec2' },
                { name: 'celFlapTime', size: 1, type: 'float' },
                { name: 'celBobArgs', size: 3, type: 'vec3' },
                { name: 'celBobTime', size: 1, type: 'float' },
                { name: 'celRampScale', size: 1, type: 'float' },
                { name: 'celRimStrength', size: 1, type: 'float' },
                { name: 'celRimWidth', size: 1, type: 'float' },
                { name: 'celHatchStrength', size: 1, type: 'float' },
                { name: 'celHatchScale', size: 1, type: 'float' },
                { name: 'celRampBands', size: 1, type: 'float' },
                { name: 'celInkColor', size: 3, type: 'vec3' },
            ],
            // The SCALAR uniforms appear both here and in the `ubo` list above,
            // and the two copies do not clash because Babylon emits exactly one
            // of them: where uniform buffers exist the `ubo` list wins (inside
            // `uniform Material { … }`) and this string is discarded; where they
            // do not, this one wins.
            //
            // ⚠️ SAMPLERS DO NOT GO HERE — precisely because this string
            // disappears on the UBO path, and a sampler has no `ubo` list to
            // catch it. They live in `CEL_DEFINITIONS`; the full reasoning is in
            // the comment above that block.
            // The path WITHOUT uniform buffers: here the vertex stage needs its
            // own declaration, and without this line the shader fails to compile
            // on exactly those devices that have no UBOs — that is, it would
            // break where nobody ever looks.
            vertex: `#ifdef CELWIND
                uniform vec4 celWind;
                uniform float celWindTime;
            #endif
            #ifdef CELSURGE
                uniform vec4 celSurge;
            #endif
            #ifdef CELFLAP
                uniform vec2 celFlapArgs;
                uniform float celFlapTime;
            #endif
            #ifdef CELBOB
                uniform vec3 celBobArgs;
                uniform float celBobTime;
            #endif`,
            fragment: `#ifdef CELGLINT
                uniform vec4 celGlint;
                uniform vec3 celGlintKey;
            #endif
            #ifdef CEL
                uniform float celRampScale;
                uniform float celRimStrength;
                uniform float celRimWidth;
                uniform float celHatchStrength;
                uniform float celHatchScale;
                uniform float celRampBands;
                uniform vec3 celInkColor;
            #endif`,
        };
    }

    /** ⚠️ Always, not only when the channel is on: Babylon collects the
     *  attributes when it compiles, and a mesh without this buffer simply reads
     *  zero. Requesting it conditionally would mean recompiling the program the
     *  first time someone switches the beat on. */
    override getAttributes(attributes: string[]): void {
        attributes.push(CEL_FLAP_ATTRIBUTE, CEL_BOB_ATTRIBUTE);
    }

    override getSamplers(samplers: string[]): void {
        samplers.push('celRampSampler', 'celHatchSampler');
    }

    override bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene): void {
        if (!this._isEnabled) return;
        const w = this._wind;
        if (w) {
            const len = Math.hypot(w.dirX, w.dirZ) || 1;
            const h = Math.max(w.height, 0.01);
            uniformBuffer.updateFloat4('celWind',
                (w.dirX / len) * w.amplitude, (w.dirZ / len) * w.amplitude,
                w.hz * Math.PI * 2, 1 / (h * h));
            uniformBuffer.updateFloat('celWindTime', celWindTimeFor(scene));
        }
        const sg = this._surge;
        if (sg) {
            const slen = Math.hypot(sg.dirX, sg.dirZ) || 1;
            uniformBuffer.updateFloat4('celSurge',
                (sg.dirX / slen) * sg.amplitude, (sg.dirZ / slen) * sg.amplitude,
                sg.phase, 0);
        }
        const gl = this._glint;
        if (gl) {
            // The glint is computed HERE and not in the fragment: it is a
            // function of time alone, so computing it per pixel would mean
            // deriving the same number a million times per frame.
            //
            // Inside the lit window it is a full sine, not a step: a rotating
            // lens carries the beam into and out of view, and a hard cut reads
            // like a switch. Outside the window it is FULL zero, and that is
            // what makes it a flash rather than a breath.
            const duty = Math.min(0.95, Math.max(0.02, gl.duty));
            const ph = (celWindTimeFor(scene) * gl.hz) % 1;
            const lit = ph < duty ? Math.sin((ph / duty) * Math.PI) : 0;
            uniformBuffer.updateFloat4('celGlint',
                gl.color.r, gl.color.g, gl.color.b,
                lit * Math.min(1, Math.max(0, gl.strength)));
            uniformBuffer.updateColor3('celGlintKey', gl.key);
        }
        const fl = this._flap;
        if (fl) {
            uniformBuffer.updateFloat2('celFlapArgs', fl.amplitude, fl.hz * Math.PI * 2);
            uniformBuffer.updateFloat('celFlapTime', celWindTimeFor(scene));
        }
        const bo = this._bob;
        if (bo) {
            uniformBuffer.updateFloat3('celBobArgs',
                bo.amplitude, bo.hz * Math.PI * 2, bo.pitch);
            // The same scene clock as the other channels: a sea that rises on
            // its own time and a foam that advances on another are two seas, and
            // it shows on the first frame in which they diverge.
            uniformBuffer.updateFloat('celBobTime', celWindTimeFor(scene));
        }
        uniformBuffer.updateFloat('celRampScale', settings.rampScale);
        uniformBuffer.updateFloat('celRimStrength', settings.rimStrength);
        uniformBuffer.updateFloat('celRimWidth', settings.rimWidth);
        uniformBuffer.updateFloat('celHatchStrength', settings.hatchStrength);
        uniformBuffer.updateFloat('celHatchScale', settings.hatchScale);
        // The steps also travel as a scalar: inside the ramp texture they are
        // already baked, and the hatching needs to know WHERE the shadow band
        // ends, not what color it is.
        uniformBuffer.updateFloat('celRampBands', settings.ramp.bands);
        uniformBuffer.updateColor3('celInkColor', settings.inkColor);
        // The textures have to be bound at every bind (the sampler is
        // per-effect), but the cache lookup is O(1) and the two `getCel*` calls
        // rebuild nothing if that parameter combination has been generated
        // already.
        uniformBuffer.setTexture('celRampSampler', getCelRamp(scene, settings.ramp));
        uniformBuffer.setTexture('celHatchSampler', getCelHatch(scene, settings.hatch));
    }

    override getCustomCode(shaderType: string): Nullable<{ [name: string]: string }> {
        // ⚠️ ALWAYS, even with no wind — it is the define that decides, not this
        // return value. Babylon collects the injection points ONCE, when the
        // plugin is attached to the material (`_addPlugin`), and the plugin is
        // born together with the material, i.e. before anyone gives it a wind:
        // returning `null` here would mean `CUSTOM_VERTEX_UPDATE_WORLDPOS` is
        // never registered, and a wind switched on later would NEVER show up. It
        // costs one disabled `#ifdef` in a block of text the preprocessor throws
        // away.
        if (shaderType === 'vertex') {
            // The two blocks at the SAME injection point: Babylon accepts only
            // one per key, so they get concatenated. The two `#ifdef`s keep them
            // independent — a material can have wind, surge, both or neither.
            return {
                CUSTOM_VERTEX_DEFINITIONS: `#ifdef CELFLAP
                    attribute vec2 ${CEL_FLAP_ATTRIBUTE};
                #endif
                #ifdef CELBOB
                    attribute vec2 ${CEL_BOB_ATTRIBUTE};
                #endif`,
                CUSTOM_VERTEX_UPDATE_WORLDPOS: CEL_WIND_WORLDPOS + CEL_SURGE_WORLDPOS
                    + CEL_FLAP_WORLDPOS + CEL_BOB_WORLDPOS,
            };
        }
        if (shaderType !== 'fragment') return null;
        return {
            CUSTOM_FRAGMENT_DEFINITIONS: CEL_DEFINITIONS,
            // Two blocks at the same injection point, concatenated for the same
            // reason as the two vertex ones: Babylon accepts only one per key,
            // and their respective `#ifdef`s keep them independent.
            CUSTOM_FRAGMENT_BEFORE_FOG: CEL_BEFORE_FOG + CEL_GLINT_BEFORE_FOG,
            // The two substitutions that put the bands on the LIGHT. They cover
            // all three `finalDiffuse` variants present in the source, and no
            // other use of `diffuseBase` (declaration, light accumulation,
            // diffuse fresnel) matches these patterns.
            '!diffuseBase\\*diffuseColor': 'celQuantizeLight(diffuseBase)*diffuseColor',
            '!\\(diffuseBase\\+emissiveColor\\)': '(celQuantizeLight(diffuseBase)+emissiveColor)',
        };
    }
}

// ── Global registration ────────────────────────────────────────────────────

const PLUGIN_NAME = 'Cel';

/** StandardMaterial ONLY.
 *
 *  The injection points are specific to its shader: `diffuseBase` and the three
 *  `finalDiffuse` variants. PBR composes light in a completely different way, so
 *  the patterns find nothing there — the code is injected without hooking onto
 *  anything and compilation fails, killing the material. It happens silently
 *  until the first PBR object reaches the screen.
 *
 *  This is not a concession: scenery and decor — typically the bulk of the call
 *  sites, and the first thing anyone converts — are all StandardMaterial. PBR
 *  objects (characters, glass, skin) need choices of their own and should be
 *  converted deliberately, not swept along by a global registration.
 *
 *  Recognized by class name and not with `instanceof`, so as not to drag
 *  `StandardMaterial` into a value import: this module is loaded at boot. */
function isCelTarget(material: Material): boolean {
    return material.getClassName() === 'StandardMaterial';
}

let globallyEnabled = false;

/** Materials that have opted OUT of cel by an authoring decision.
 *
 *  ⚠️ It is needed because the global switch-on is REPEATED, not one-off:
 *  whoever decides the world's visual language calls it again on every scene
 *  entry and on every re-render of the component hosting it, and each pass
 *  iterates over all live materials putting them back to `enabled`. A material
 *  excluded once found cel switched back on at the first subsequent re-render —
 *  and the symptom was as insidious as it gets: the exclusion DID work, for a
 *  few frames.
 *
 *  With this set the exclusion is a property of the material rather than an event
 *  in time, so it survives every re-enable. */
const optedOut = new WeakSet<Material>();

/** Attaches the plugin to EVERY material created from here on (and to those that
 *  already exist). The plugin is born switched off: `setCelPluginEnabled` turns
 *  it on.
 *
 *  It has to be called before the materials are built — `RegisterMaterialPlugin`
 *  does not retrofit already-instantiated ones — and again after an engine is
 *  replaced, because Babylon clears the global registrations at that point. */
export function registerCelPlugin(): void {
    // Babylon clears ALL global registrations when the last engine is disposed
    // (`EngineStore.OnEnginesDisposedObservable`). A component workbench recreates the engine
    // on every story change: keeping our own `registered` boolean here therefore
    // left the module convinced the plugin still existed, while Babylon had
    // already removed it. From the second mount on, new StandardMaterials were
    // born without the plugin and looked very dark.
    //
    // `RegisterMaterialPlugin` is already idempotent by name: if the registration
    // exists it updates the factory, otherwise it recreates it. Calling it again
    // is therefore both safe in a running application and necessary after an engine dispose.
    RegisterMaterialPlugin(PLUGIN_NAME, (material) => {
        // Standard and PBR only. Babylon's global registration offers the plugin
        // to EVERY material, but elsewhere it is out of place or broken:
        //  · on a ShaderMaterial (the prototype's CelMaterial, a custom sky)
        //    cel is already inside the shader, and Babylon refuses the injection
        //    anyway with an exception about the shader language;
        //  · on a system material (hull, post-process) it makes no sense.
        // Filtering here is safer than remembering it at every call site.
        if (!isCelTarget(material)) return null;
        const plugin = new CelMaterialPlugin(material);
        plugin.isEnabled = globallyEnabled;
        return plugin;
    });
}

/** Switches cel on/off on every material of a scene.
 *
 *  The scene is needed because switching on has to reach materials that ALREADY
 *  exist: the global value only covers future ones. The cost is a recompilation
 *  of the shaders it touches — acceptable on a world change, not per frame. */
/** Subscription that keeps cel materials created AFTER the switch-on unfrozen.
 *
 *  A single pass is not enough: cel is switched on when the world is entered,
 *  while the decor masters are born later in the same frame and freeze themselves
 *  right after construction. Without this subscription they would stay frozen —
 *  and a frozen material does not upload the cel uniforms.
 *
 *  The unfreeze is deliberately deferred to the next frame: `freeze()` is called
 *  by the factories IMMEDIATELY after creation, so acting inside the creation
 *  observable would be undone one instruction later. */
let unfreezeSub: Nullable<() => void> = null;

function keepCelMaterialsThawed(scene: Scene): () => void {
    const pending: Material[] = [];
    const onNew = scene.onNewMaterialAddedObservable.add((material) => {
        if (isCelTarget(material)) pending.push(material);
    });
    const onFrame = scene.onBeforeRenderObservable.add(() => {
        if (pending.length === 0) return;
        // Under the `celFreezeMaterials` measurement lever the unfreeze has to be
        // skipped, or it would cancel exactly what the lever is there to measure.
        if (!shouldFreezeUnderCel()) {
            for (const m of pending) m.unfreeze();
        }
        pending.length = 0;
    });
    return () => {
        scene.onNewMaterialAddedObservable.remove(onNew);
        scene.onBeforeRenderObservable.remove(onFrame);
    };
}

export function setCelPluginEnabled(scene: Nullable<Scene>, enabled: boolean): void {
    globallyEnabled = enabled;
    if (!scene) return;

    unfreezeSub?.();
    unfreezeSub = enabled ? keepCelMaterialsThawed(scene) : null;

    for (const material of scene.materials) {
        const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
        if (!plugin) continue;
        // Whoever opted out stays out: the global switch-on does not touch them.
        if (enabled && optedOut.has(material)) continue;
        // Unfreezing is MANDATORY, not a missed optimization.
        //
        // A frozen material does not re-upload its uniforms, and the cel uniforms
        // are uploaded in `bindForSubMesh`: they stay at zero, the ramp is sampled
        // at t=0 and every surface comes out in the darkest band. The symptom is a
        // uniformly dark scene that reacts to NO tuning at all — it looks like a
        // calibration error and it is not.
        //
        // It has to be done HERE and not in the individual constructors: the
        // freezing comes from a dozen scattered model factories, and chasing them
        // one by one would be exactly the per-call-site work the plugin exists to
        // avoid. The cost (no skipped re-bind) is one of the items the perf gate
        // has to measure.
        if (enabled && !shouldFreezeUnderCel()) material.unfreeze();
        plugin.isEnabled = enabled;
    }
}

/** Is the plugin active on this material? Diagnostic, for tuning harnesses. */
export function isCelPluginEnabledOn(material: Material): boolean {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    return plugin?.isEnabled ?? false;
}

/** Switches cel on for a SINGLE material. This is the lever a tuning harness needs to put
 *  cel and non-cel side by side in the same frame.
 *
 *  ⚠️ It is TRANSIENT: the next global switch-on overwrites it. To keep a
 *  material out of cel stably, use `excludeFromCel`. */
export function setCelPluginOn(material: Material, enabled: boolean): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.isEnabled = enabled;
}

/** Gives (or takes away) the WIND on a material.
 *
 *  It should be called on SCENERY materials — vegetation, props, background
 *  strips — and not on ground surfaces or on colliding geometry:
 *   · ground surfaces are continuous, and bending their vertices would open gaps
 *     at the seams between one tile and the next;
 *   · colliding geometry usually has its own motion computed on the CPU
 *     (a consumer-side idle motion), which is where it belongs — that one is
 *     tied to the collider, this one is not.
 *
 *  ⚠️ The wind moves the SURFACE, not the collider and not the G-buffer: what
 *  moves does not change where you die (and rightly so: it is decor) and it does
 *  not carry the ink stroke along with it (see the note on `CelWindSpec`). */
export function setCelWind(material: Material, spec: CelWindSpec | null): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.wind = spec;
}

/** Switches the SURGE on for a material. The object passed in stays the
 *  caller's, and the caller mutates its `phase` every frame (see `CelSurgeSpec`). */
export function setCelSurge(material: Material, spec: CelSurgeSpec | null): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.surge = spec;
}

/** Takes a material OUT of cel permanently.
 *
 *  This is the form to use for authoring decisions — a character that has to
 *  stay photographic, or the sky, which is a drawing and not a lit
 *  surface. Unlike `setCelPluginOn` it survives subsequent global switch-ons. */
/** Switches the GLINT channel on for this material, or off with `null`.
 *
 *  The rhythm is kept by the plugin, on the wind's scene clock: a lighthouse does
 *  not need anyone to write its phase every frame, and a second clock would
 *  diverge from the first. Whoever DOES already have a phase of their own uses
 *  the surge instead.
 *
 *  ⚠️ It does nothing visible until some vertex is marked with **alpha 0** (see
 *  `CelGlintSpec`): the material may draw a hundred species and light up only
 *  one, which is why this channel does not ask for a material of its own. */
export function setCelGlint(material: Material, spec: CelGlintSpec | null): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.glint = spec;
}

/** Switches the WING-BEAT on for this material, or off with `null`.
 *
 *  It does nothing visible until the vertices carry `CEL_FLAP_ATTRIBUTE` (weight
 *  from the body's axis and the individual's phase): the material may draw a
 *  hundred species and make only the marked one beat. */
export function setCelFlap(material: Material, spec: CelFlapSpec | null): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.flap = spec;
}

/** Switches the BOB on for this material, or off with `null`.
 *
 *  It does nothing visible until the vertices carry `CEL_BOB_ATTRIBUTE` (marking
 *  + position along the axis, and the body's phase): the material may draw a
 *  hundred species and make only the marked one float. */
export function setCelBob(material: Material, spec: CelBobSpec | null): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.bob = spec;
}

export function excludeFromCel(material: Material): void {
    optedOut.add(material);
    setCelPluginOn(material, false);
}

/** Reports whether ramp or hatching have changed since the last read — the
 *  caller can use it to avoid pointless rebuilds. */
export function consumeCelTextureDirty(): { ramp: boolean; hatch: boolean } {
    const out = { ramp: rampDirty, hatch: hatchDirty };
    rampDirty = false;
    hatchDirty = false;
    return out;
}

/** The type is exported only for tests and tuning harnesses: consumers must not instantiate it by
 *  hand, `registerCelPlugin` takes care of that. */
export type { CelMaterialPlugin };

// `AbstractEngine`, `AbstractMesh` and `SubMesh` stay imported as types to
// document the overridden signatures even where we do not use all of them.
export type CelPluginBindArgs = [UniformBuffer, Scene, AbstractEngine, SubMesh, AbstractMesh];
