// CelLook — gli assi di TARATURA del look cel, in un tipo solo.
//
// Il cel-shading non è un sottosistema: è quattro (ramp, materiale, contorno,
// grade), ognuno con la propria API e il proprio handle. Chi vuole tarare il
// look deve quindi scrivere a mano il fan-out su quattro oggetti diversi, e
// ogni harness che lo fa ne scrive una copia leggermente diversa — il pannello
// del gioco, le storie del lab, domani un altro progetto.
//
// Questo file è quella scrittura fatta UNA volta. Il tipo `CelLookTuning`
// raccoglie i soli assi che si toccano davvero in fase di taratura;
// `applyCelLook` li smista sugli handle giusti; `CEL_LOOK_CONTROLS` descrive
// intervallo e passo di ciascuno, così un pannello o degli argTypes di Storybook
// li leggono invece di riscriverli.
//
// COSA NON STA QUI: i valori tarati per una scena specifica (portata della
// dissolvenza, densità di nebbia, tinta dell'ombra) e le etichette in lingua.
// I primi dipendono dalla scala del contenuto — un fondale a 125 m chiede una
// dissolvenza che su un livello raccolto sarebbe assurda — e appartengono a chi
// il contenuto lo possiede. Le seconde appartengono all'interfaccia. Qui restano
// solo i default NEUTRI, presi dai default dei quattro sottosistemi invece che
// riscritti: una taratura di default che vive in due posti diverge alla prima
// modifica.

import { DEFAULT_CEL_RAMP, type CelRampSpec } from './celRamp';
import { DEFAULT_CEL_OPTIONS, type CelMaterialHandle } from './CelMaterial';
import { DEFAULT_CEL_OUTLINE, type CelOutlineHandle } from './CelOutlinePostProcess';
import { DEFAULT_CEL_GRADE, type CelGradeHandle } from './celGrade';
import { configureCelPlugin } from './CelMaterialPlugin';

/** Gli assi di taratura del look, piatti perché è così che li presenta
 *  qualunque pannello: un valore per riga. La composizione nei quattro
 *  sottosistemi la fa `applyCelLook`, non il chiamante. */
export interface CelLookTuning {
    // ── Shading ──
    /** Gradini della ramp. 0-1 = rampa continua, cioè il riferimento "non-cel". */
    bands: number;
    /** Ampiezza della transizione fra gradini (0 = stacco netto). */
    softness: number;
    hatchStrength: number;
    /** Lato della tile di tratteggio in pixel di schermo. */
    hatchScale: number;
    rimStrength: number;
    fogDensity: number;
    // ── Contorno ──
    /** Spegne il contorno SENZA staccare il post-process: vedi `applyCelLook`. */
    outlineEnabled: boolean;
    outlineThickness: number;
    depthThreshold: number;
    normalThreshold: number;
    /** Distanza in METRI oltre la quale il tratto svanisce. 0 = mai. */
    outlineFade: number;
    // ── Colore ──
    saturation: number;
    contrast: number;
}

/** Neutro: ogni valore è il default del sottosistema che lo consuma, non una
 *  seconda dichiarazione dello stesso numero. Un progetto parte da qui e
 *  sovrascrive solo ciò che la sua scena richiede davvero. */
export const DEFAULT_CEL_LOOK: CelLookTuning = {
    bands: DEFAULT_CEL_RAMP.bands,
    softness: DEFAULT_CEL_RAMP.softness,
    hatchStrength: DEFAULT_CEL_OPTIONS.hatchStrength,
    hatchScale: DEFAULT_CEL_OPTIONS.hatchScale,
    rimStrength: DEFAULT_CEL_OPTIONS.rimStrength,
    fogDensity: DEFAULT_CEL_OPTIONS.fogDensity,
    outlineEnabled: true,
    outlineThickness: DEFAULT_CEL_OUTLINE.thickness,
    depthThreshold: DEFAULT_CEL_OUTLINE.depthThreshold,
    normalThreshold: DEFAULT_CEL_OUTLINE.normalThreshold,
    outlineFade: DEFAULT_CEL_OUTLINE.fadeDistance,
    saturation: DEFAULT_CEL_GRADE.saturation,
    contrast: DEFAULT_CEL_GRADE.contrast,
};

/** Dove va applicata la taratura. Tutti i campi sono opzionali: un harness che
 *  non ha contorno passa solo il materiale, e le storie che tarano il solo grade
 *  passano solo quello. */
export interface CelLookTargets {
    material?: CelMaterialHandle | null | undefined;
    outline?: CelOutlineHandle | null | undefined;
    grade?: CelGradeHandle | null | undefined;
    /** Ramp di base su cui innestare `bands`/`softness`. Serve perché la ramp
     *  porta anche le due TINTE (ombra, luce), che sono art-direction e non assi
     *  di taratura: senza una base da cui partire si perderebbero a ogni
     *  applicazione. Default: la ramp neutra del motore. */
    ramp?: CelRampSpec | undefined;
    /** Ritara anche le impostazioni globali del MaterialPlugin — il path di
     *  produzione, dove il cel gira su StandardMaterial esistenti invece che sul
     *  ShaderMaterial del prototipo. Così una taratura approvata sul prototipo
     *  si trasferisce senza essere ribattuta a mano. */
    plugin?: boolean | undefined;
}

/** Soglia irraggiungibile = nessun pixel supera il test = nessun tratto. */
const OUTLINE_OFF_THRESHOLD = 1e9;

/** Smista una taratura completa sugli handle. Idempotente: si può chiamare a
 *  ogni cambio di stato senza tenere traccia di cosa è cambiato.
 *
 *  Nessuna ricostruzione: tutto ciò che tocca qui è uniform, texture di lookup
 *  in cache o parametro di post-process. È il presupposto perché uno slider
 *  risponda mentre la scena scorre. */
export function applyCelLook(targets: CelLookTargets, look: CelLookTuning): void {
    const ramp: CelRampSpec = {
        ...(targets.ramp ?? DEFAULT_CEL_RAMP),
        bands: look.bands,
        softness: look.softness,
    };

    targets.material?.apply({
        ramp,
        hatchStrength: look.hatchStrength,
        hatchScale: look.hatchScale,
        rimStrength: look.rimStrength,
        fogDensity: look.fogDensity,
    });

    // Il contorno si spegne portando le soglie fuori scala, non staccando il
    // pass: togliere e rimettere il post-process ricompilerebbe lo shader a ogni
    // click, e il confronto con/senza contorno deve essere immediato.
    targets.outline?.apply({
        thickness: look.outlineEnabled ? look.outlineThickness : 0,
        depthThreshold: look.outlineEnabled ? look.depthThreshold : OUTLINE_OFF_THRESHOLD,
        normalThreshold: look.outlineEnabled ? look.normalThreshold : OUTLINE_OFF_THRESHOLD,
        fadeDistance: look.outlineFade,
    });

    targets.grade?.apply({ saturation: look.saturation, contrast: look.contrast });

    if (targets.plugin) {
        // Il plugin non ha un termine di nebbia proprio: sullo StandardMaterial
        // la nebbia è quella di scena. Gli altri assi coincidono.
        configureCelPlugin({
            ramp,
            hatchStrength: look.hatchStrength,
            hatchScale: look.hatchScale,
            rimStrength: look.rimStrength,
        });
    }
}

// ── Descrizione dei comandi ──────────────────────────────────────────────────
// Intervallo, passo e cifre significative di ciascun asse. Sta nel motore
// perché sono proprietà del PARAMETRO, non del pannello: `softness` sopra ~0.45
// smette di produrre bande in qualunque progetto, e `hatchScale` sotto ~96 px
// aliasa comunque. Le etichette invece non stanno qui — quelle sono lingua e
// interfaccia, e appartengono a chi disegna il pannello.

export type CelLookGroup = 'shading' | 'outline' | 'color';

interface CelLookRangeControl {
    field: keyof CelLookTuning;
    group: CelLookGroup;
    kind: 'range';
    min: number;
    max: number;
    step: number;
    /** Cifre decimali da mostrare. Un valore che si legge "0.02000000001"
     *  mentre si trascina non aiuta nessuno. */
    digits: number;
}

interface CelLookToggleControl {
    field: keyof CelLookTuning;
    group: CelLookGroup;
    kind: 'toggle';
}

export type CelLookControl = CelLookRangeControl | CelLookToggleControl;

export const CEL_LOOK_CONTROLS: readonly CelLookControl[] = [
    { field: 'bands', group: 'shading', kind: 'range', min: 0, max: 6, step: 1, digits: 0 },
    { field: 'softness', group: 'shading', kind: 'range', min: 0, max: 0.45, step: 0.01, digits: 2 },
    { field: 'hatchStrength', group: 'shading', kind: 'range', min: 0, max: 1, step: 0.05, digits: 2 },
    { field: 'hatchScale', group: 'shading', kind: 'range', min: 96, max: 640, step: 16, digits: 0 },
    { field: 'rimStrength', group: 'shading', kind: 'range', min: 0, max: 1, step: 0.05, digits: 2 },
    { field: 'outlineEnabled', group: 'outline', kind: 'toggle' },
    { field: 'outlineThickness', group: 'outline', kind: 'range', min: 0.5, max: 3, step: 0.1, digits: 1 },
    { field: 'depthThreshold', group: 'outline', kind: 'range', min: 0.002, max: 0.1, step: 0.002, digits: 3 },
    { field: 'normalThreshold', group: 'outline', kind: 'range', min: 0.05, max: 1, step: 0.05, digits: 2 },
    { field: 'outlineFade', group: 'outline', kind: 'range', min: 0, max: 250, step: 5, digits: 0 },
    { field: 'saturation', group: 'color', kind: 'range', min: -100, max: 100, step: 2, digits: 0 },
    { field: 'contrast', group: 'color', kind: 'range', min: 0.6, max: 2.2, step: 0.05, digits: 2 },
    { field: 'fogDensity', group: 'color', kind: 'range', min: 0, max: 0.03, step: 0.001, digits: 3 },
];

/** I comandi di un gruppo, nell'ordine dichiarato. */
export function celLookControlsOf(group: CelLookGroup): readonly CelLookControl[] {
    return CEL_LOOK_CONTROLS.filter((c) => c.group === group);
}

/** L'intervallo di un asse, per chi deve dichiarare un controllo da solo —
 *  gli `argTypes` di Storybook, che vogliono min/max/step in un oggetto proprio
 *  e non possono ciclare sulla lista. */
export function celLookRange(field: keyof CelLookTuning): CelLookRangeControl {
    const c = CEL_LOOK_CONTROLS.find((x) => x.field === field);
    if (c?.kind !== 'range') {
        throw new Error(`celLookRange: "${field}" non è un asse continuo`);
    }
    return c;
}
