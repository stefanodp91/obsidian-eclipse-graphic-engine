// CelMaterial — the cel-shading prototype's material.
//
// WHY ShaderMaterial AND NOT A MaterialPlugin: the prototype has to get a look
// JUDGED, so it needs total control over every term and the ability to retune
// everything at runtime. A plugin on StandardMaterial would inherit Babylon's
// lighting model and with it the constraints we are trying to get out of.
//
// The trade-off is that this material does NOT talk to Babylon's light system:
// key, fill and fog are explicit uniforms. For a cel look that is no loss — a
// hard key plus a flat fill is exactly the lighting model needed, and having it
// explicit makes it tunable.
//
// The math does not live here but in celShading.glsl.ts, so that the migration to
// consumers (which will go through a MaterialPluginBase over the existing specs)
// reuses the same functions instead of rewriting them and diverging.

import type { Scene, Nullable, Observer } from '@babylonjs/core';
import { Color3, ShaderMaterial, Vector3 } from '@babylonjs/core';
import {
    CEL_VERTEX_SHADER, CEL_FRAGMENT_SHADER,
} from './celShading.glsl';
import { getCelRamp, DEFAULT_CEL_RAMP, type CelRampSpec } from './celRamp';
import { getCelHatch, NO_HATCH, type CelHatchSpec } from './celHatching';

export interface CelMaterialOptions {
    /** Albedo. Multiplied by the vertex color when `useVertexColor`. */
    baseColor: Color3;
    ramp: CelRampSpec;
    /** The key's PROPAGATION direction (from the source towards the scene). */
    lightDirection: Vector3;
    lightColor: Color3;
    /** Hemispheric fill: sky above, ground bounce below. */
    ambientSky: Color3;
    ambientGround: Color3;
    /** Ink color — inner rim and (for consistency) outlines. */
    inkColor: Color3;
    /** 0 = no ink rim. */
    rimStrength: number;
    /** Rim width as a fraction of fresnel (0..1). */
    rimWidth: number;
    specColor: Color3;
    /** 0 = no specular blob. */
    specStrength: number;
    specPower: number;
    hatch: CelHatchSpec;
    /** 0 = no hatching. */
    hatchStrength: number;
    /** Side of the hatching tile, in screen pixels. */
    hatchScale: number;
    fogColor: Color3;
    /** 0 = no fog. */
    fogDensity: number;
    alpha: number;
    useVertexColor: boolean;
    /** Enables the `uv` attribute (no term consumes it today: the hatching is
     *  screen-space). Switch it on only on meshes that really have UVs. */
    useUv: boolean;
    backFaceCulling: boolean;
}

/** Defaults tuned on a grazing key from the upper left, i.e. the same lighting
 *  rig consumers use (SUN_LIGHT_DIR): the comparison between prototype and current
 *  state must not also be measuring a difference in the sun's position. */
export const DEFAULT_CEL_OPTIONS: CelMaterialOptions = {
    baseColor: new Color3(0.62, 0.72, 0.38),
    ramp: DEFAULT_CEL_RAMP,
    lightDirection: new Vector3(-0.49, -0.84, -0.24),
    lightColor: new Color3(1.0, 0.96, 0.86),
    ambientSky: new Color3(0.30, 0.36, 0.46),
    ambientGround: new Color3(0.16, 0.18, 0.14),
    inkColor: new Color3(0.05, 0.04, 0.07),
    rimStrength: 0.0,
    rimWidth: 0.35,
    specColor: Color3.White(),
    specStrength: 0.0,
    specPower: 32,
    hatch: NO_HATCH,
    hatchStrength: 0.0,
    hatchScale: 256,   // = the tile's side: 1:1 mapping, no minification
    fogColor: new Color3(0.62, 0.74, 0.86),
    fogDensity: 0.0,
    alpha: 1,
    useVertexColor: false,
    useUv: false,
    backFaceCulling: true,
};

export interface CelMaterialHandle {
    readonly material: ShaderMaterial;
    /** Retunes a subset of the axes at runtime. Everything that does NOT touch
     *  the defines (i.e. everything except vertex-color and uv) applies without
     *  recompiling the shader: that is the tuning panel's precondition. */
    apply(patch: Partial<CelMaterialOptions>): void;
    /** Snapshot of the current values — the panel reads from here instead of
     *  keeping a parallel state that can diverge. */
    readonly options: Readonly<CelMaterialOptions>;
    dispose(): void;
}

function pushColorUniforms(
    material: ShaderMaterial,
    opts: CelMaterialOptions,
    patch: Partial<CelMaterialOptions>,
): void {
    if (patch.baseColor) material.setColor3('celBaseColor', opts.baseColor);
    if (patch.lightDirection) material.setVector3('celLightDirection', opts.lightDirection);
    if (patch.lightColor) material.setColor3('celLightColor', opts.lightColor);
    if (patch.ambientSky) material.setColor3('celAmbientSky', opts.ambientSky);
    if (patch.ambientGround) material.setColor3('celAmbientGround', opts.ambientGround);
    if (patch.inkColor) material.setColor3('celInkColor', opts.inkColor);
    if (patch.specColor) material.setColor3('celSpecColor', opts.specColor);
    if (patch.fogColor) material.setColor3('celFogColor', opts.fogColor);
}

function pushScalarUniforms(
    material: ShaderMaterial,
    opts: CelMaterialOptions,
    patch: Partial<CelMaterialOptions>,
): void {
    if (patch.rimStrength !== undefined) material.setFloat('celRimStrength', opts.rimStrength);
    if (patch.rimWidth !== undefined) material.setFloat('celRimWidth', opts.rimWidth);
    if (patch.specStrength !== undefined) material.setFloat('celSpecStrength', opts.specStrength);
    if (patch.specPower !== undefined) material.setFloat('celSpecPower', opts.specPower);
    if (patch.hatchStrength !== undefined) material.setFloat('celHatchStrength', opts.hatchStrength);
    if (patch.hatchScale !== undefined) material.setFloat('celHatchScale', opts.hatchScale);
    if (patch.fogDensity !== undefined) material.setFloat('celFogDensity', opts.fogDensity);
}

function pushMaterialState(
    material: ShaderMaterial,
    scene: Scene,
    opts: CelMaterialOptions,
    patch: Partial<CelMaterialOptions>,
): void {
    if (patch.alpha !== undefined) {
        material.setFloat('celAlpha', opts.alpha);
        material.alpha = opts.alpha;
    }
    if (patch.ramp) {
        material.setTexture('celRampSampler', getCelRamp(scene, opts.ramp));
        // The steps also travel as a scalar, not just baked into the texture: the
        // hatching has to know where the shadow band ends, and from an already
        // quantized texture that boundary is no longer readable.
        material.setFloat('celRampBands', opts.ramp.bands);
    }
    if (patch.hatch) material.setTexture('celHatchSampler', getCelHatch(scene, opts.hatch));
    if (patch.backFaceCulling !== undefined) material.backFaceCulling = opts.backFaceCulling;
}

const ATTRIBUTES_BASE = ['position', 'normal'];

const UNIFORMS = [
    'world', 'viewProjection',
    'celBaseColor', 'celLightDirection', 'celLightColor',
    'celAmbientSky', 'celAmbientGround', 'celInkColor', 'celSpecColor',
    'celFogColor', 'celCameraPosition',
    'celRimStrength', 'celRimWidth', 'celSpecStrength', 'celSpecPower',
    'celHatchStrength', 'celHatchScale', 'celFogDensity', 'celAlpha',
    'celRampBands',
];

const SAMPLERS = ['celRampSampler', 'celHatchSampler'];

export function createCelMaterial(
    name: string,
    scene: Scene,
    overrides: Partial<CelMaterialOptions> = {},
): CelMaterialHandle {
    const opts: CelMaterialOptions = { ...DEFAULT_CEL_OPTIONS, ...overrides };

    const defines: string[] = [];
    if (opts.useVertexColor) defines.push('#define VERTEXCOLOR');
    if (opts.useUv) defines.push('#define UV1');

    const attributes = [...ATTRIBUTES_BASE];
    if (opts.useUv) attributes.push('uv');
    if (opts.useVertexColor) attributes.push('color');

    const material = new ShaderMaterial(
        name,
        scene,
        { vertexSource: CEL_VERTEX_SHADER, fragmentSource: CEL_FRAGMENT_SHADER },
        {
            attributes,
            uniforms: UNIFORMS,
            samplers: SAMPLERS,
            defines,
            needAlphaBlending: opts.alpha < 1,
        },
    );
    material.backFaceCulling = opts.backFaceCulling;
    material.alpha = opts.alpha;

    // The camera position is the only uniform that changes every frame.
    // ShaderMaterial does not bind it by itself under a custom name (it would
    // only bind `cameraPosition`), and the custom name exists to keep the GLSL
    // chunk namespaced for the migration to the plugin. One push per frame —
    // negligible cost, no reentrant bind observer.
    const camObserver: Nullable<Observer<Scene>> = scene.onBeforeRenderObservable.add(() => {
        const cam = scene.activeCamera;
        if (cam) material.setVector3('celCameraPosition', cam.globalPosition);
    });

    const push = (patch: Partial<CelMaterialOptions>): void => {
        pushColorUniforms(material, opts, patch);
        pushScalarUniforms(material, opts, patch);
        pushMaterialState(material, scene, opts, patch);
    };

    // First push: ALL the uniforms. A uniform that has never been written reads
    // zero, and a cel shader with the ramp at zero is solid black — the kind of
    // bug that looks like a math error and is in fact a missing binding.
    push(DEFAULT_CEL_OPTIONS);

    const handle: CelMaterialHandle = {
        material,
        options: opts,
        apply(patch) {
            Object.assign(opts, patch);
            push(patch);
        },
        dispose() {
            scene.onBeforeRenderObservable.remove(camObserver);
            material.dispose();
        },
    };
    return handle;
}
