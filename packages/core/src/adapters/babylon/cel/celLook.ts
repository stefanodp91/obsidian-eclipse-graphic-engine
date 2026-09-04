// CelLook — the cel look's TUNING axes, in a single type.
//
// Cel-shading is not one subsystem: it is four (ramp, material, outline, grade),
// each with its own API and its own handle. Anyone who wants to tune the look
// therefore has to write the fan-out over four different objects by hand, and
// every harness that does it writes a slightly different copy — a consumer's tuning panel,
// an external tuning harness, tomorrow another project.
//
// This file is that piece of writing done ONCE. The `CelLookTuning` type collects
// only the axes that are actually touched while tuning; `applyCelLook` dispatches
// them to the right handles; `CEL_LOOK_CONTROLS` describes each one's range and
// step, so that a panel or Storybook argTypes read them instead of rewriting
// them.
//
// WHAT DOES NOT BELONG HERE: values tuned for a specific scene (fade range, fog
// density, shadow tint) and the labels in a given language. The former depend on
// the content's scale — a backdrop at 125 m calls for a fade that on a compact
// level would be absurd — and belong to whoever owns the content. The latter
// belong to the interface. What stays here is only the NEUTRAL defaults, taken
// from the four subsystems' own defaults rather than rewritten: a default tuning
// that lives in two places diverges at the first change.

import { DEFAULT_CEL_RAMP, type CelRampSpec } from './celRamp';
import { DEFAULT_CEL_OPTIONS, type CelMaterialHandle } from './CelMaterial';
import { DEFAULT_CEL_OUTLINE, type CelOutlineHandle } from './CelOutlinePostProcess';
import { DEFAULT_CEL_GRADE, type CelGradeHandle } from './celGrade';
import { configureCelPlugin } from './CelMaterialPlugin';

/** The look's tuning axes, flat because that is how any panel presents them: one
 *  value per row. Composing them into the four subsystems is `applyCelLook`'s
 *  job, not the caller's. */
export interface CelLookTuning {
    // ── Shading ──
    /** Ramp steps. 0-1 = continuous ramp, i.e. the "non-cel" reference. */
    bands: number;
    /** Width of the transition between steps (0 = hard cut). */
    softness: number;
    hatchStrength: number;
    /** Side of the hatching tile, in screen pixels. */
    hatchScale: number;
    rimStrength: number;
    fogDensity: number;
    // ── Outline ──
    /** Switches the outline off WITHOUT detaching the post-process: see `applyCelLook`. */
    outlineEnabled: boolean;
    outlineThickness: number;
    depthThreshold: number;
    normalThreshold: number;
    /** Distance in METERS beyond which the stroke fades out. 0 = never. */
    outlineFade: number;
    // ── Color ──
    saturation: number;
    contrast: number;
}

/** Neutral: every value is the default of the subsystem that consumes it, not a
 *  second declaration of the same number. A project starts from here and
 *  overrides only what its scene really requires. */
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

/** Where the tuning is to be applied. Every field is optional: a harness with no
 *  outline passes only the material, and the stories that tune the grade alone
 *  pass only that. */
export interface CelLookTargets {
    material?: CelMaterialHandle | null | undefined;
    outline?: CelOutlineHandle | null | undefined;
    grade?: CelGradeHandle | null | undefined;
    /** Base ramp on which to graft `bands`/`softness`. It is needed because the
     *  ramp also carries the two TINTS (shadow, light), which are art direction
     *  and not tuning axes: without a base to start from they would be lost on
     *  every application. Default: the engine's neutral ramp. */
    ramp?: CelRampSpec | undefined;
    /** Also retunes the MaterialPlugin's global settings — the production path,
     *  where cel runs on existing StandardMaterials instead of on the prototype's
     *  ShaderMaterial. That way a tuning approved on the prototype transfers
     *  across without being redone by hand. */
    plugin?: boolean | undefined;
}

/** An unreachable threshold = no pixel passes the test = no stroke. */
const OUTLINE_OFF_THRESHOLD = 1e9;

/** Dispatches a complete tuning onto the handles. Idempotent: it can be called on
 *  every state change without keeping track of what changed.
 *
 *  No rebuilds: everything it touches here is a uniform, a cached lookup texture
 *  or a post-process parameter. That is the precondition for a slider to respond
 *  while the scene is running. */
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

    // The outline is switched off by taking the thresholds out of range, not by
    // detaching the pass: removing and re-adding the post-process would recompile
    // the shader on every click, and the with/without-outline comparison has to
    // be immediate.
    targets.outline?.apply({
        thickness: look.outlineEnabled ? look.outlineThickness : 0,
        depthThreshold: look.outlineEnabled ? look.depthThreshold : OUTLINE_OFF_THRESHOLD,
        normalThreshold: look.outlineEnabled ? look.normalThreshold : OUTLINE_OFF_THRESHOLD,
        fadeDistance: look.outlineFade,
    });

    targets.grade?.apply({ saturation: look.saturation, contrast: look.contrast });

    if (targets.plugin) {
        // The plugin has no fog term of its own: on StandardMaterial the fog is
        // the scene's. The other axes coincide.
        configureCelPlugin({
            ramp,
            hatchStrength: look.hatchStrength,
            hatchScale: look.hatchScale,
            rimStrength: look.rimStrength,
        });
    }
}

// ── Control description ──────────────────────────────────────────────────────
// Range, step and significant digits of each axis. It lives in the engine because
// these are properties of the PARAMETER, not of the panel: `softness` above ~0.45
// stops producing bands in any project, and `hatchScale` below ~96 px aliases
// regardless. The labels, by contrast, do not live here — those are language and
// interface, and they belong to whoever designs the panel.

export type CelLookGroup = 'shading' | 'outline' | 'color';

interface CelLookRangeControl {
    field: keyof CelLookTuning;
    group: CelLookGroup;
    kind: 'range';
    min: number;
    max: number;
    step: number;
    /** Decimal digits to display. A value that reads "0.02000000001" while you
     *  drag it helps nobody. */
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

/** A group's controls, in declared order. */
export function celLookControlsOf(group: CelLookGroup): readonly CelLookControl[] {
    return CEL_LOOK_CONTROLS.filter((c) => c.group === group);
}

/** An axis's range, for whoever has to declare a control on their own —
 *  Storybook's `argTypes`, which want min/max/step in an object of their own and
 *  cannot loop over the list. */
export function celLookRange(field: keyof CelLookTuning): CelLookRangeControl {
    const c = CEL_LOOK_CONTROLS.find((x) => x.field === field);
    if (c?.kind !== 'range') {
        throw new Error(`celLookRange: "${field}" is not a continuous axis`);
    }
    return c;
}
