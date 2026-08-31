// Prototipo cel-shading — superficie pubblica.
//
// Tutto quello che sta qui sotto è PROTOTIPO: vive nel motore perché è
// brand-agnostico e perché entrambi gli harness (gioco e storybook) lo devono
// importare, non perché sia già una feature del motore. Nessun consumatore di
// produzione lo referenzia.

export {
    CEL_FRAGMENT_UNIFORMS, CEL_FRAGMENT_FUNCTIONS, CEL_FRAGMENT_BODY,
    CEL_VERTEX_SHADER, CEL_FRAGMENT_SHADER,
    CEL_HULL_VERTEX_SHADER, CEL_HULL_FRAGMENT_SHADER,
} from './celShading.glsl';

export { getCelRamp, disposeCelRamps, DEFAULT_CEL_RAMP } from './celRamp';
export type { CelRampSpec } from './celRamp';

export { getCelHatch, disposeCelHatches, DEFAULT_CEL_HATCH, NO_HATCH } from './celHatching';
export type { CelHatchSpec } from './celHatching';

export { createCelMaterial, DEFAULT_CEL_OPTIONS } from './CelMaterial';
export type { CelMaterialOptions, CelMaterialHandle } from './CelMaterial';

export { excludeFromCelOutline, markCelOutlineEssential, markCelOutlineNoHullFallback, setCelOutlineHullMode, attachCelOutline, DEFAULT_CEL_OUTLINE } from './CelOutlinePostProcess';
export type { CelOutlineOptions, CelOutlineHandle, CelOutlineDebug } from './CelOutlinePostProcess';

// `bakeCelHullIntoMesh` e `celBodyBoxOf` viaggiano insieme: la prima distrugge
// la misura del modello, la seconda la conserva. Esporre solo la prima
// significherebbe offrire il difetto senza la sua cura.
export { createCelHullFactory, DEFAULT_CEL_HULL, bakeCelHullIntoMesh, celBodyBoxOf } from './celHull';
export type { CelHullOptions, CelHullHandle } from './celHull';

/** Le due tecniche di contorno.
 *
 *  SCELTA OWNER 2026-08-04: `post`. Il guscio resta nel codice come termine di
 *  paragone del lab, non come opzione del prototipo — si strappa sulle mesh a
 *  spigoli duri (normali sdoppiate ⇒ la copia gonfiata si apre) e quella è
 *  esattamente la geometria che il cel-shading richiede, quindi il difetto si
 *  presenterebbe ovunque. In più il post-process è l'unico dei due che disegna
 *  anche gli spigoli INTERNI.
 *
 *  `both` esiste solo per il lab: serviva a vedere se sommate davano qualcosa
 *  che nessuna delle due dà da sola. Non è una configurazione da spedire. */
export type CelOutlineMode = 'none' | 'post' | 'hull' | 'both';

/** Il modo scelto dall'owner. Il prototipo parte da qui. */
export const CEL_OUTLINE_CHOICE: CelOutlineMode = 'post';

export {
    applyCelLook, celLookControlsOf, celLookRange,
    CEL_LOOK_CONTROLS, DEFAULT_CEL_LOOK,
} from './celLook';
export type { CelLookTuning, CelLookTargets, CelLookControl, CelLookGroup } from './celLook';

export { applyCelGrade, DEFAULT_CEL_GRADE } from './celGrade';
export type { CelGradeSpec, CelGradeHandle } from './celGrade';

export {
    registerCelPlugin, setCelPluginEnabled, setCelPluginOn, excludeFromCel, isCelPluginEnabledOn,
    configureCelPlugin, getCelPluginSettings, consumeCelTextureDirty,
    setCelWind, setCelSurge, setCelGlint, setCelFlap, setCelBob,
    CEL_FLAP_ATTRIBUTE, CEL_BOB_ATTRIBUTE,
    DEFAULT_CEL_PLUGIN, DEFAULT_CEL_WIND,
} from './CelMaterialPlugin';
export type {
    CelPluginSettings, CelWindSpec, CelSurgeSpec, CelGlintSpec, CelFlapSpec, CelBobSpec,
} from './CelMaterialPlugin';
