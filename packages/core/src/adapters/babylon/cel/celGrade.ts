// Grade cromatico del prototipo cel.
//
// Il cel-shading dà le bande, ma non dà da solo il COLORE di Borderlands: quello
// nasce da un grade spinto — saturazione alta, contrasto alto, neri chiusi. Con
// le bande e un grade neutro il risultato legge come un cartone animato
// televisivo, non come un fumetto stampato.
//
// Passa dalla image-processing configuration DI SCENA, non da una pipeline: è un
// uniform analitico applicato in shader dai material forward, quindi nessun
// render-target e nessun pass a schermo intero. È lo stesso path che il gioco
// già usa per il grade per-mondo (applySceneGrade in setupPostProcessing).
//
// Attenzione all'ordine con l'edge-detect: il contorno è un post-process e viene
// DOPO, quindi il tratto d'inchiostro non viene toccato dal grade. È il
// comportamento voluto — un contorno che cambia colore con la saturazione della
// scena smetterebbe di leggere come inchiostro.

import type { Nullable, Scene } from '@babylonjs/core';
import { ColorCurves, ImageProcessingConfiguration } from '@babylonjs/core';

export interface CelGradeSpec {
    /** -100..100. Il valore che porta il look verso la stampa satura. */
    saturation: number;
    /** 0..360, rotazione di tinta globale. */
    hue: number;
    /** 0..1, quanto pesano le curve. 0 = curve spente. */
    density: number;
    contrast: number;
    exposure: number;
    /** Tonemap ACES. Spento di default: comprime le alte luci e quindi
     *  ammorbidisce proprio gli stacchi fra bande che il cel deve tenere netti. */
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

/** Applica il grade alla scena e ritorna la maniglia per ritararlo a caldo.
 *  `dispose` riporta la scena a neutro: la Scene sopravvive ai cambi di livello,
 *  quindi un grade non ripulito si porterebbe dietro anche fuori dal prototipo. */
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
        curves.globalDensity = spec.density * 100;   // ColorCurves vuole 0..100
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
