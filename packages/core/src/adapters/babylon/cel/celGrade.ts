// Color grade of the cel prototype.
//
// Cel-shading gives the bands, but on its own it does not give Borderlands' COLOR:
// that comes from a pushed grade — high saturation, high contrast, closed blacks.
// With the bands and a neutral grade the result reads like a TV cartoon, not like
// a printed comic.
//
// It goes through the SCENE's image-processing configuration, not through a
// pipeline: it is an analytic uniform applied in-shader by the forward materials,
// so no render target and no fullscreen pass. It is the same path a consumer
// already uses for the per-world grade (applySceneGrade in setupPostProcessing).
//
// Mind the ordering with the edge-detect: the outline is a post-process and comes
// AFTER, so the ink stroke is not touched by the grade. That is the intended
// behavior — an outline that changed color with the scene's saturation would stop
// reading as ink.

import type { Nullable, Scene } from '@babylonjs/core';
import { ColorCurves, ImageProcessingConfiguration } from '@babylonjs/core';

export interface CelGradeSpec {
    /** -100..100. The value that pushes the look towards saturated print. */
    saturation: number;
    /** 0..360, global hue rotation. */
    hue: number;
    /** 0..1, how much the curves weigh. 0 = curves off. */
    density: number;
    contrast: number;
    exposure: number;
    /** ACES tonemap. Off by default: it compresses the highlights and therefore
     *  softens exactly the steps between bands that cel has to keep sharp. */
    toneMapping: boolean;
}

export const DEFAULT_CEL_GRADE: CelGradeSpec = {
    saturation: 34,
    hue: 0,
    density: 1,
    contrast: 1.35,
    exposure: 1.05,
    toneMapping: false,
};

export interface CelGradeHandle {
    apply(patch: Partial<CelGradeSpec>): void;
    readonly spec: Readonly<CelGradeSpec>;
    dispose(): void;
}

/** Applies the grade to the scene and returns the handle for retuning it live.
 *  `dispose` returns the scene to neutral: the Scene survives level changes, so an
 *  uncleaned grade would carry over beyond the prototype as well. */
export function applyCelGrade(
    scene: Scene,
    overrides: Partial<CelGradeSpec> = {},
): CelGradeHandle {
    const spec: CelGradeSpec = { ...DEFAULT_CEL_GRADE, ...overrides };
    const ip = scene.imageProcessingConfiguration;

    const prev = {
        colorCurves: ip.colorCurves as Nullable<ColorCurves>,
        colorCurvesEnabled: ip.colorCurvesEnabled,
        toneMappingEnabled: ip.toneMappingEnabled,
        exposure: ip.exposure,
        contrast: ip.contrast,
    };

    const curves = new ColorCurves();

    const push = (): void => {
        curves.globalSaturation = spec.saturation;
        curves.globalHue = spec.hue;
        curves.globalDensity = spec.density * 100;   // ColorCurves wants 0..100
        ip.colorCurves = curves;
        ip.colorCurvesEnabled = spec.density > 0;
        ip.contrast = spec.contrast;
        ip.exposure = spec.exposure;
        ip.toneMappingEnabled = spec.toneMapping;
        if (spec.toneMapping) {
            ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
        }
    };
    push();

    return {
        spec,
        apply(patch) {
            Object.assign(spec, patch);
            push();
        },
        dispose() {
            ip.colorCurves = prev.colorCurves;
            ip.colorCurvesEnabled = prev.colorCurvesEnabled;
            ip.toneMappingEnabled = prev.toneMappingEnabled;
            ip.exposure = prev.exposure;
            ip.contrast = prev.contrast;
        },
    };
}
