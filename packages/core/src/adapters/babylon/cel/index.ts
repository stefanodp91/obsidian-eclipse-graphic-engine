// Cel-shading prototype — public surface.
//
// Everything below here is PROTOTYPE: it lives in the engine because it is
// brand-agnostic and because both the sample application and external harnesses have to import
// it, not because it is already an engine feature. No production consumer
// references it.

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

// `bakeCelHullIntoMesh` and `celBodyBoxOf` travel together: the first destroys
// the model's measurement, the second preserves it. Exporting only the first
// would mean offering the defect without its cure.
export { createCelHullFactory, DEFAULT_CEL_HULL, bakeCelHullIntoMesh, celBodyBoxOf } from './celHull';
export type { CelHullOptions, CelHullHandle } from './celHull';

/** The two outline techniques.
 *
 *  DEFAULT CHOSEN 2026-08-04: `post`. The hull stays in the code as a point of comparison
 *  for tuning harnesses, not as an option of the prototype — it tears on meshes
 *  with hard edges (split normals ⇒ the inflated copy splits open) and that is
 *  exactly the geometry cel-shading calls for, so the defect would show up
 *  everywhere. On top of that, the post-process is the only one of the two that
 *  also draws INTERNAL edges.
 *
 *  `both` exists for tuning harnesses: it is there to see whether summing them gave
 *  something neither gives on its own. It is not a configuration to ship. */
export type CelOutlineMode = 'none' | 'post' | 'hull' | 'both';

/** The default mode. The prototype starts from here. */
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
