// Facade: the single entry point (api/GraphicEngine). DTOs + factory.
//
// This is a THIN orchestration Facade: it owns no Babylon/store/Capacitor deps
// (agnosticism, §5) — it adopts an existing Scene and delegates each resource to
// an injected port the host wires (quality -> applyQualityChange, tier ->
// effectiveTierStore, phase -> a render-gating sink). As more subsystems move
// behind the engine boundary (render loop, physics, pools), their ports are
// added here without changing the host's call shape.

import type { GraphicEngine } from '../ports/driving';
import type { InputSource } from '../ports/driven';
import type { AssetTier, EnginePhase, EffectiveTier, QualityPreset, Unsubscribe } from '../domain';

/** Host-injected quality port. `update` returns true if applied hot, false if
 *  skipped (reference impl: `applyQualityChange`, menu-only). `subscribe` fires
 *  when the active preset changes (host store). */
export interface QualityPort {
  get(): QualityPreset;
  update(preset: QualityPreset, override: QualityPreset | null): boolean;
  subscribe(fn: (preset: QualityPreset) => void): Unsubscribe;
}

/** Host-injected engine-phase observable. The host maps its own phases onto the
 *  three EnginePhase states (Active/Reduced/Halted). Read-only; the write side
 *  is the separate `phase` transition sink. */
export interface PhasePort {
  get(): EnginePhase;
  subscribe(fn: (phase: EnginePhase) => void): Unsubscribe;
}

/** Host-injected per-frame registration. Reference impl: the master-tick-patched
 *  `scene.registerBeforeRender` (flat-array dispatch, 80+ observers -> 1). `add`
 *  returns an unsubscribe. `order` (default 0) sets dispatch priority AMONG
 *  frame.add callbacks — lower runs first, equal order keeps registration order
 *  (stable); it does NOT interleave with callbacks the host registered directly on
 *  the render loop. Callbacks run at frame rate — imperative work only, never push
 *  to React per frame (throttle host-side). */
export interface FramePort {
  add(cb: () => void, order?: number): Unsubscribe;
}

/** Host-injected 3-tier asset cache (reference impl: AssetCache). Keyed values
 *  with global/world/level lifetimes; values returned as-is (no opaque handle). */
export interface AssetsPort {
  set<T>(key: string, value: T, tier: AssetTier): T;
  get<T>(key: string): T | null;
  acquire(key: string): boolean;
  release(key: string): void;
  clearTier(tier: AssetTier): void;
  has(key: string): boolean;
  readonly size: number;
}

/** Host-injected ref-counted shared-material library (reference impl:
 *  MaterialLibrary, scene-scoped host-side). `acquire` runs the factory once per
 *  key. The material type is a CALLER-SUPPLIED type param `M` — the engine never
 *  names Babylon types, but the host (and any consumer) pins the concrete type at
 *  the call site, so nothing crosses as `unknown`. */
export interface MaterialsPort {
  acquire<M>(key: string, factory: (mat: M) => void): M;
  /** Tier-aware: runs the PBR factory on high presets, the Standard factory on
   *  low (mirrors the host's acquireTieredMaterial). The two factories take
   *  distinct material types `S`/`P`; returns whichever the tier selected. */
  acquireTiered<S, P>(key: string, stdFactory: (mat: S) => void, pbrFactory: (mat: P) => void): S | P;
  release(key: string): void;
}

/** Host-injected object-pool registry (reference impl: MeshPool/ThinInstancePool,
 *  scene-scoped host-side). The pool FACTORY is a host-defined, Babylon-coupled
 *  descriptor (create(scene)/createMaster/buildPhysics/…) and the acquire-result
 *  is a mesh + per-item release/buildPhysics lifecycle — both not expressible
 *  agnostically. They cross as caller-supplied type params `F`/`R` (NOT `unknown`):
 *  the host pins the concrete type at the call site, the engine forwards untouched. */
export interface PoolsPort {
  register<F>(key: string, factory: F): void;
  acquire<R>(key: string): R | null;
  releaseType(key: string): void;
  prewarm(key: string, count: number): void;
}

/** Host-injected effective-tier observable. Reference impl: a projection of the
 *  game's warmup tier (+ active preset) to the agnostic EffectiveTier snapshot;
 *  null before the first probe. Optional: when absent, `engine.tier` reads null. */
export interface TierPort {
  get(): EffectiveTier | null;
  subscribe(fn: (tier: EffectiveTier | null) => void): Unsubscribe;
}

/** Host-injected render-gating sink for EnginePhase transitions. Optional: when
 *  absent, `engine.phase.transition` is a no-op (gating not yet routed through
 *  the Facade — Fase 5). */
export type PhaseSink = (to: EnginePhase) => void;

export interface CreateGraphicEngineOptions {
  /** Storage key prefix — mandatory and intentionally without a default. */
  readonly keyPrefix: string;
  /** Adopt an existing Babylon Scene (Reactylon creates it). Owning mode
   *  (`{ canvas }`) lands when the engine creates Engine+Scene itself. */
  readonly rendering: { readonly scene: object };
  readonly quality: QualityPort;
  /** Optional: when absent, `engine.tier.get()` returns null and subscribe is
   *  a no-op (host has not wired its tier source yet). */
  readonly tier?: TierPort;
  /** Write side: render-gating sink for phase transitions. */
  readonly phase?: PhaseSink;
  /** Read side: engine-phase observable for `engine.phase.get()/subscribe()`.
   *  Optional: when absent, those return null / no-op. */
  readonly phaseSource?: PhasePort;
  /** Optional per-frame registration backend. When absent, `engine.frame.add`
   *  is a no-op returning an empty unsubscribe. */
  readonly frame?: FramePort;
  /** Optional content resources (host wires the scene-scoped impls). Absent →
   *  the corresponding `engine.assets/materials/pools` calls no-op/return null. */
  readonly assets?: AssetsPort;
  readonly materials?: MaterialsPort;
  readonly pools?: PoolsPort;
  /** Optional input source (driven port). Absent → `engine.input` attach is a
   *  no-op unsubscribe, `lateral` reads 0, `consumeJump` returns false. */
  readonly input?: InputSource;
  /** Host cleanup run on `dispose()` (clear engine handles, unsubscribe). */
  readonly onDispose?: () => void;
}

/** Facade factory — single entry point (§3.3). Adopts an existing Babylon Scene
 *  and delegates each resource to a host-injected port. */
export function createGraphicEngine(options: CreateGraphicEngineOptions): GraphicEngine {
  if (!options.keyPrefix) {
    throw new Error('obsidian-eclipse-graphic-engine: keyPrefix is mandatory (no default, §5)');
  }
  if (!options.rendering?.scene) {
    throw new Error('obsidian-eclipse-graphic-engine: rendering.scene is required (adopt mode)');
  }

  let disposed = false;
  // Writes throw after dispose (a write to a torn-down engine is misuse). READS
  // (get/subscribe) stay no-throw: they delegate to host stores that outlive the
  // Facade, and React teardown may call getSnapshot during unmount after dispose.
  const ensureLive = (): void => {
    if (disposed) throw new Error('obsidian-eclipse-graphic-engine: engine already disposed');
  };

  return {
    phase: {
      transition(to) {
        ensureLive();
        options.phase?.(to);
      },
      get() {
        return options.phaseSource ? options.phaseSource.get() : null;
      },
      subscribe(fn) {
        return options.phaseSource ? options.phaseSource.subscribe(fn) : () => {};
      },
    },
    tier: {
      get() {
        return options.tier ? options.tier.get() : null;
      },
      subscribe(fn) {
        return options.tier ? options.tier.subscribe(fn) : () => {};
      },
    },
    quality: {
      get() {
        return options.quality.get();
      },
      update(preset, override = null) {
        ensureLive();
        return options.quality.update(preset, override);
      },
      subscribe(fn) {
        return options.quality.subscribe(fn);
      },
    },
    frame: {
      add(cb, order) {
        ensureLive();
        return options.frame ? options.frame.add(cb, order) : () => {};
      },
    },
    assets: {
      set<T>(key: string, value: T, tier: AssetTier): T { return options.assets ? options.assets.set<T>(key, value, tier) : value; },
      get<T>(key: string): T | null { return options.assets ? options.assets.get<T>(key) : null; },
      acquire(key) { return options.assets ? options.assets.acquire(key) : false; },
      release(key) { options.assets?.release(key); },
      clearTier(tier) { options.assets?.clearTier(tier); },
      has(key) { return options.assets ? options.assets.has(key) : false; },
      get size() { return options.assets ? options.assets.size : 0; },
    },
    materials: {
      acquire<M>(key: string, factory: (mat: M) => void): M | null { ensureLive(); return options.materials ? options.materials.acquire<M>(key, factory) : null; },
      acquireTiered<S, P>(key: string, stdFactory: (mat: S) => void, pbrFactory: (mat: P) => void): S | P | null { ensureLive(); return options.materials ? options.materials.acquireTiered<S, P>(key, stdFactory, pbrFactory) : null; },
      release(key) { options.materials?.release(key); },
    },
    pools: {
      register<F>(key: string, factory: F): void { options.pools?.register<F>(key, factory); },
      acquire<R>(key: string): R | null { ensureLive(); return options.pools ? options.pools.acquire<R>(key) : null; },
      releaseType(key) { options.pools?.releaseType(key); },
      prewarm(key, count) { options.pools?.prewarm(key, count); },
    },
    input: {
      attach(target) { ensureLive(); return options.input ? options.input.attach(target) : () => {}; },
      get lateral() { return options.input ? options.input.lateral : 0; },
      consumeJump() { return options.input ? options.input.consumeJump() : false; },
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      options.onDispose?.();
    },
  };
}
