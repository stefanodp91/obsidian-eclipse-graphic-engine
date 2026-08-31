// Device-class quality presets (NOT game concepts) + LOD tier.
// Presets are classes of device, so they live in the engine as-is.

export type QualityPreset = 'mobile-flagship' | 'mobile-mid' | 'mobile-low';

export type LodTier = 'hi' | 'mid' | 'lo';

/** Engine-pure rendering + physics knobs. The game's own QualityProfile is a
 *  superset that satisfies this structurally — engine modules read only these
 *  fields; game-content additions (audio schedule, LOD family names, etc.) are
 *  invisible here. */
export interface EngineQualityProfile {
    qualityTier: LodTier;
    mipBias: number;
    disableLighting: boolean;
    emissiveBoost: number;
    physicsStepHz: 60 | 120;
}

/** Resolved per-session/per-level quality snapshot, produced AFTER boot + the
 *  warmup probe. Read-only surface published by `engine.tier.get()` /
 *  `engine.tier.subscribe()`.
 *
 *  Pure device-class data only: a preset class, a base LOD tier, the effective
 *  tier after any UNIFORM downgrade (the engine knows the CONCEPT of a tier,
 *  never the NAMES of asset families), the render scale the probe learned, how
 *  it was derived, and the probe's frame-time telemetry. No host content, no
 *  QualityProfile, no per-family registry, no game words.
 *
 *  The prior `familyOverrides: Record<string, LodTier>` is intentionally
 *  removed: its keys would be host-defined asset-family names (a name
 *  dependency) and no host produces such a map today — the only per-asset
 *  signal hosts emit is one uniform downgrade, modeled as `effectiveTier`.
 *  Reintroduce an optional `familyOverrides?` ADDITIVELY only when a host
 *  genuinely emits heterogeneous per-family tiers (YAGNI). */
export interface EffectiveTier {
  /** Active device-class preset for this session (user override or auto-pick).
   *  Sourced by the host, never derived by the engine. */
  readonly preset: QualityPreset;
  /** How this tier was derived: a static device-class pick, or a live warmup
   *  probe measurement. */
  readonly reason: 'static-tier' | 'probed';
  /** Base device-class LOD tier for the preset, before any runtime downgrade.
   *  Opaque tier KEY; mapping tier -> concrete per-asset LOD is the host's job. */
  readonly baseTier: LodTier;
  /** Effective LOD tier in force = `baseTier` with any uniform probe downgrade
   *  folded in (never lighter than `baseTier`). Equals `baseTier` when the probe
   *  found no need to degrade; `baseTier !== effectiveTier` signals a downgrade. */
  readonly effectiveTier: LodTier;
  /** Render-scale multiplier the probe learned (down-only ratchet, already
   *  clamped to the device scale cap). null = no override. */
  readonly renderScaleOverride: number | null;
  /** Median frame time (ms) measured during the warmup probe. null = not probed
   *  (static-tier path). Telemetry only — drives no engine decision. */
  readonly probedMedianMs: number | null;
}
