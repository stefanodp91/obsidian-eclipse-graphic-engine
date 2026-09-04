// CelMaterial — il materiale del prototipo cel-shading.
//
// PERCHÉ ShaderMaterial E NON UN MaterialPlugin: il prototipo deve far
// GIUDICARE un look, quindi serve controllo totale su ogni termine e la
// possibilità di ritarare tutto a runtime. Un plugin su StandardMaterial
// erediterebbe il modello di illuminazione di Babylon e con esso i vincoli da
// cui stiamo cercando di uscire.
//
// La contropartita è che questo materiale NON parla con il sistema di luci di
// Babylon: chiave, fill e nebbia sono uniform esplicite. Per un look cel non è
// una perdita — una chiave dura più un riempimento piatto è esattamente il
// modello di illuminazione che serve, e averlo esplicito lo rende tarabile.
//
// La matematica non vive qui ma in celShading.glsl.ts, così la migrazione al
// gioco (che passerà per un MaterialPluginBase sulle spec esistenti) riusa le
// stesse funzioni invece di riscriverle e divergere.

import type { Scene, Nullable, Observer } from '@babylonjs/core';
import { Color3, ShaderMaterial, Vector3 } from '@babylonjs/core';
import {
    CEL_VERTEX_SHADER, CEL_FRAGMENT_SHADER,
} from './celShading.glsl';
import { getCelRamp, DEFAULT_CEL_RAMP, type CelRampSpec } from './celRamp';
import { getCelHatch, NO_HATCH, type CelHatchSpec } from './celHatching';

export interface CelMaterialOptions {
    /** Albedo. Moltiplicato per il vertex color quando `useVertexColor`. */
    baseColor: Color3;
    ramp: CelRampSpec;
    /** Direzione di PROPAGAZIONE della chiave (dalla sorgente verso la scena). */
    lightDirection: Vector3;
    lightColor: Color3;
    /** Fill emisferico: cielo sopra, rimbalzo da terra sotto. */
    ambientSky: Color3;
    ambientGround: Color3;
    /** Colore dell'inchiostro — rim interno e (per coerenza) contorni. */
    inkColor: Color3;
    /** 0 = nessun rim d'inchiostro. */
    rimStrength: number;
    /** Ampiezza del rim in frazione di fresnel (0..1). */
    rimWidth: number;
    specColor: Color3;
    /** 0 = nessuna macchia speculare. */
    specStrength: number;
    specPower: number;
    hatch: CelHatchSpec;
    /** 0 = nessun tratteggio. */
    hatchStrength: number;
    /** Lato della tile di tratteggio in pixel di schermo. */
    hatchScale: number;
    fogColor: Color3;
    /** 0 = nessuna nebbia. */
    fogDensity: number;
    alpha: number;
    useVertexColor: boolean;
    /** Abilita l'attributo `uv` (oggi nessun termine lo consuma: il tratteggio è
     *  screen-space). Da accendere solo su mesh che hanno davvero le UV. */
    useUv: boolean;
    backFaceCulling: boolean;
}

/** Default tarati su una chiave radente da sinistra-alto, cioè lo stesso
 *  impianto di luce del gioco (SUN_LIGHT_DIR): il confronto fra prototipo e
 *  stato attuale non deve misurare anche una differenza di posizione del sole. */
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
    hatchScale: 256,   // = lato della tile: mappatura 1:1, nessuna minificazione
    fogColor: new Color3(0.62, 0.74, 0.86),
    fogDensity: 0.0,
    alpha: 1,
    useVertexColor: false,
    useUv: false,
    backFaceCulling: true,
};

export interface CelMaterialHandle {
    readonly material: ShaderMaterial;
    /** Ritara un sottoinsieme di assi a runtime. Tutto ciò che NON tocca i
     *  define (cioè tutto tranne vertex-color e uv) si applica senza
     *  ricompilare lo shader: è il presupposto del pannello di taratura. */
    apply(patch: Partial<CelMaterialOptions>): void;
    /** Snapshot dei valori correnti — il pannello legge da qui invece di
     *  tenere uno stato parallelo che può divergere. */
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
        // I gradini viaggiano ANCHE come scalare, non solo cotti nella texture:
        // il retino deve sapere dove finisce la banda d'ombra, e da una texture
        // già quantizzata quel confine non è più leggibile.
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

    // La posizione camera è l'unica uniform che cambia ogni frame. ShaderMaterial
    // non la lega da sola sotto un nome custom (legherebbe solo `cameraPosition`),
    // e il nome custom serve a tenere il chunk GLSL namespaced per la migrazione
    // al plugin. Un push per frame — costo trascurabile, nessun observer di bind
    // rientrante.
    const camObserver: Nullable<Observer<Scene>> = scene.onBeforeRenderObservable.add(() => {
        const cam = scene.activeCamera;
        if (cam) material.setVector3('celCameraPosition', cam.globalPosition);
    });

    const push = (patch: Partial<CelMaterialOptions>): void => {
        pushColorUniforms(material, opts, patch);
        pushScalarUniforms(material, opts, patch);
        pushMaterialState(material, scene, opts, patch);
    };

    // Primo push: TUTTE le uniform. Una uniform mai scritta legge zero, e uno
    // shader cel con ramp a zero è nero pieno — il tipo di bug che sembra un
    // errore di matematica e invece è un binding mancante.
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
