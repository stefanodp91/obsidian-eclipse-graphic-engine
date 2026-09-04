// Cel-shading — the math, as shared GLSL chunks.
//
// WHY STRINGS AND NOT .glsl FILES: a consumer's bundler — webpack, Vite or
// anything else — may well have no shader loader, and requiring one would mean
// asking every integrator to change their build config. Strings go through any
// pipeline with no configuration at all.
//
// WHY A CHUNK SEPARATE FROM THE MATERIAL: the prototype consumes this math via a
// ShaderMaterial (total control, which is what is needed to JUDGE the look). If
// the look passes, this exact same string gets injected into a
// MaterialPluginBase and a consumer's several dozen material specs inherit cel without being
// rewritten. The chunk is the piece that makes that migration cheap: it is not to
// be duplicated, it is to be imported.
//
// Contract: `CEL_FRAGMENT_FUNCTIONS` declares pure functions only (no uniforms,
// no varyings). Whoever includes it must already have declared the uniforms
// listed in `CEL_FRAGMENT_UNIFORMS`.

/** Uniforms required by `CEL_FRAGMENT_FUNCTIONS` + by the fragment body.
 *  Declared here once so that the material and the future plugin do not diverge
 *  on the names. */
export const CEL_FRAGMENT_UNIFORMS = /* glsl */ `
uniform vec3  celBaseColor;
uniform vec3  celLightDirection;   // the light's PROPAGATION direction (from the source towards the scene)
uniform vec3  celLightColor;
uniform vec3  celAmbientSky;
uniform vec3  celAmbientGround;
uniform vec3  celInkColor;
uniform vec3  celSpecColor;
uniform vec3  celFogColor;
uniform vec3  celCameraPosition;
uniform float celRimStrength;
uniform float celRimWidth;
uniform float celSpecStrength;
uniform float celSpecPower;
uniform float celHatchStrength;
uniform float celHatchScale;
uniform float celRampBands;   // ramp steps: tells the hatching where the shadow band ends
uniform float celFogDensity;
uniform float celAlpha;
uniform sampler2D celRampSampler;
uniform sampler2D celHatchSampler;
`;

/** The cel terms, one per function.
 *
 *  WEBGPU CONSTRAINT — the samplers are NOT function parameters but direct
 *  references to the uniforms declared above. Under WebGPU Babylon splits
 *  `uniform sampler2D x` into a separate texture and sampler and recombines them
 *  at the point of use; passing the combined value to a function makes SPIR-V
 *  compilation fail with «sampler constructor must appear at point of use»,
 *  whereas in WebGL2 the same code compiles without a murmur. The game forces
 *  WebGL2 and workbench harnesses run on WebGPU: both have to compile, so the rule always
 *  holds, even where it seems to work.
 *
 *  The rest of the inputs stay explicit, so that the migration to
 *  MaterialPluginBase can call the same terms in the same order inside a
 *  different shader context. */
export const CEL_FRAGMENT_FUNCTIONS = /* glsl */ `
// ── Light band ───────────────────────────────────────────────────────────────
// The heart of cel. NdotL does not modulate the color continuously: it picks a
// BAND in a ramp texture. The ramp carries both the number of steps and their
// tint (Borderlands' shadow is not the darkened diffuse, it is colder and more
// saturated), so all of the shading's art direction lives in a 256x1 texture
// tunable at runtime instead of in constants scattered through the shader.
//
// half-lambert (ndl*0.5+0.5) instead of max(ndl,0): the shadowed side still gets
// a band of its own instead of collapsing to flat black. It is the same choice
// Valve made on Team Fortress 2 and it is what keeps the silhouette readable
// when the key light is hard.
vec3 celLightBand(vec3 normalW, vec3 lightDir) {
    float ndl = dot(normalW, -normalize(lightDir));
    float t   = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
    return texture2D(celRampSampler, vec2(t, 0.5)).rgb;
}

// The ramp COORDINATE, i.e. where this pixel falls on the 0..1 axis before the
// ramp quantizes it. The hatching needs it: it does not have to know what TINT
// the band is, but WHICH band it is in — the tints are art direction and change
// per level, the index does not.
float celRampCoord(vec3 normalW, vec3 lightDir) {
    float ndl = dot(normalW, -normalize(lightDir));
    return clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
}

// ── Hemispheric fill ─────────────────────────────────────────────────────────
// The fill stays FLAT (not banded) on purpose: if the ambient is quantized too,
// the two quantizations beat against each other and spurious steps appear on
// surfaces nearly perpendicular to the key light.
vec3 celAmbient(vec3 normalW, vec3 sky, vec3 ground) {
    float up = normalW.y * 0.5 + 0.5;
    return mix(ground, sky, up);
}

// ── Blob specular ────────────────────────────────────────────────────────────
// The specular light has to be quantized as well, otherwise it is the last
// photorealistic term left and it gives the rest away: a hard step produces
// comics' light "blob" instead of a soft highlight.
vec3 celSpecular(vec3 normalW, vec3 viewDir, vec3 lightDir, vec3 specColor, float strength, float power) {
    if (strength <= 0.0) return vec3(0.0);
    vec3  h    = normalize(-normalize(lightDir) + viewDir);
    float spec = pow(clamp(dot(normalW, h), 0.0, 1.0), power);
    return specColor * strength * step(0.5, spec);
}

// ── Ink rim ──────────────────────────────────────────────────────────────────
// This is not PBR's bright rim light: here the edge is DARKENED towards the ink
// color. It is the "inner" outline — it works on curved surfaces where a depth
// edge-detect finds no discontinuity and therefore draws nothing. The two
// mechanisms are complementary, not alternatives.
float celInkRim(vec3 normalW, vec3 viewDir, float width, float strength) {
    if (strength <= 0.0) return 0.0;
    float fres = 1.0 - clamp(dot(normalW, viewDir), 0.0, 1.0);
    return smoothstep(1.0 - width, 1.0, fres) * strength;
}
// ── Hatching ─────────────────────────────────────────────────────────────────
// The piece usually forgotten when imitating Borderlands: without hatching you
// get a clean cartoon cel-shading, not a pen drawing. Sampled in SCREEN SPACE
// (like a print halftone) and applied only where the light is low: the stroke
// lives on the paper, not on the model, and it is exactly that inconsistency
// that makes it read as drawn.
// THE HATCHING LIVES IN THE DARKEST BAND, AND ONLY THERE.
//
// The previous window (1 - smoothstep(0.30, 0.95, band luminance)) took the dark
// band in full, the middle one for roughly a third and left only the light one
// clean — and under a real game's lighting rig half the world falls in the
// intermediate zone, so the hatching showed up on surfaces the eye reads as lit.
// It was a window tuned on a laboratory scene, where the light comes from
// uniforms at intensity 1.
//
// Now the boundary is the band, not a luminance threshold: rampU is the 0..1
// coordinate BEFORE quantization, and the first band ends at 1/bands. Below that
// boundary the hatching is full, above it it is zero, with a short fade over the
// band's last 15% whose only job is to keep the edge from snapping by a pixel.
//
// ⚠️ The coordinate and not the band's luminance: the shadow tint is art
// direction and changes per level (a consumer may declare one per level),
// so a luminance threshold would move from one level to the next while the band
// index stays the same everywhere.
//
// ⚠️ bands = 0 is the laboratory's CONTINUOUS ramp, where a «darkest band» does
// not exist: there the lower third of the axis applies, which is the same
// fraction a three-step ramp would give.
float celHatchMask(float rampU, float bands) {
    float edge = bands > 0.5 ? 1.0 / bands : 0.34;
    return 1.0 - smoothstep(edge * 0.85, edge, rampU);
}

float celHatch(vec2 fragCoord, float rampU, float bands, float scale, float strength) {
    if (strength <= 0.0) return 1.0;
    float h    = texture2D(celHatchSampler, fragCoord / max(scale, 1.0)).r;
    return 1.0 - (1.0 - h) * celHatchMask(rampU, bands) * strength;
}

// ── Fog ──────────────────────────────────────────────────────────────────────
// Its own fog instead of Babylon's: ShaderMaterial does not bind the scene
// uniforms vFogInfos/vFogColor, and binding them by hand would require a bind
// observer for a term that here amounts to three lines.
vec3 celFog(vec3 color, vec3 fogColor, float density, float dist) {
    if (density <= 0.0) return color;
    float f = 1.0 - clamp(exp(-density * density * dist * dist), 0.0, 1.0);
    return mix(color, fogColor, f);
}
`;

/** Fragment body: composes the terms in the canonical order. Extracted as a
 *  separate constant because it is the part the migration plugin will have to
 *  ADAPT (there the base color comes from the host material, not from a uniform),
 *  while the functions above stay identical. */
export const CEL_FRAGMENT_BODY = /* glsl */ `
    vec3 normalW = normalize(vNormalW);
    vec3 viewDir = normalize(celCameraPosition - vPositionW);

    vec3 albedo = celBaseColor;
#ifdef VERTEXCOLOR
    albedo *= vColor.rgb;
#endif

    vec3  band   = celLightBand(normalW, celLightDirection);
    vec3  fill   = celAmbient(normalW, celAmbientSky, celAmbientGround);
    vec3  spec   = celSpecular(normalW, viewDir, celLightDirection, celSpecColor, celSpecStrength, celSpecPower);
    float rampU  = celRampCoord(normalW, celLightDirection);
    float hatch  = celHatch(gl_FragCoord.xy, rampU, celRampBands, celHatchScale, celHatchStrength);
    float rim    = celInkRim(normalW, viewDir, celRimWidth, celRimStrength);

    vec3 color = albedo * (band * celLightColor + fill);
    color += spec;
    color *= hatch;
    color  = mix(color, celInkColor, rim);
    color  = celFog(color, celFogColor, celFogDensity, length(celCameraPosition - vPositionW));

    gl_FragColor = vec4(color, celAlpha);
`;

/** Complete vertex shader. `#include<instancesDeclaration>` /
 *  `<instancesVertex>` are Babylon chunks: they go through the ShaderProcessor
 *  in a ShaderMaterial too, so hardware instancing keeps working without the
 *  prototype having to rewrite the instances' skinning path. */
export const CEL_VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
#ifdef UV1
attribute vec2 uv;
#endif
#ifdef VERTEXCOLOR
attribute vec4 color;
#endif

#include<instancesDeclaration>

uniform mat4 viewProjection;

varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;
#ifdef VERTEXCOLOR
varying vec4 vColor;
#endif

void main(void) {
    #include<instancesVertex>

    vec4 worldPos = finalWorld * vec4(position, 1.0);
    vPositionW = worldPos.xyz;
    // Inverse-transpose omitted: the prototype's assets use uniform scales. With
    // non-uniform scales the normals would come out skewed — a declared
    // constraint, not a forgotten one.
    vNormalW = normalize(mat3(finalWorld) * normal);
#ifdef UV1
    vUV = uv;
#else
    vUV = vec2(0.0);
#endif
#ifdef VERTEXCOLOR
    vColor = color;
#endif
    gl_Position = viewProjection * worldPos;
}
`;

/** Fragment shader completo = uniform + funzioni + corpo. */
export const CEL_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;
#ifdef VERTEXCOLOR
varying vec4 vColor;
#endif

${CEL_FRAGMENT_UNIFORMS}
${CEL_FRAGMENT_FUNCTIONS}

void main(void) {
${CEL_FRAGMENT_BODY}
}
`;

/** Vertex shader of the inverted hull (outline candidate B). Extrudes along the
 *  normal in world space. It lives here and not in the outline file because it
 *  shares the same instancing convention as cel: if the two diverged, the hull
 *  would slide relative to the mesh on instances. */
export const CEL_HULL_VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec3 normal;

#include<instancesDeclaration>

uniform mat4 viewProjection;
uniform float hullThickness;

void main(void) {
    #include<instancesVertex>

    vec3 nW = normalize(mat3(finalWorld) * normal);
    vec4 worldPos = finalWorld * vec4(position, 1.0);
    worldPos.xyz += nW * hullThickness;
    gl_Position = viewProjection * worldPos;
}
`;

/** Hull fragment: flat tint, no lighting. */
export const CEL_HULL_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform vec3 hullColor;
void main(void) {
    gl_FragColor = vec4(hullColor, 1.0);
}
`;
