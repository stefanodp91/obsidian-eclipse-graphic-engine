// Driving port: the public API contract — the ONLY way into the engine.
// Resource-oriented, "REST-like" in-process (resource + verbs, DTOs, opaque
// handles). The Facade in api/ implements this. See feasibility doc §3.3.
//
// Surface: phase / tier / quality / frame / assets / materials / pools / dispose.
// Each resource delegates to a host-injected port (the engine owns the *concept*,
// the host wires the scene-scoped impl + content factories — §4 #8, §5). Content
// objects (materials, pooled items) cross the boundary as `unknown` (the engine
// never names Babylon types); the caller casts. `input` joins when a game wires it.

import type { EnginePhase, AssetTier, EffectiveTier, QualityPreset, Unsubscribe } from '../../domain';

export interface GraphicEngine {
  readonly phase: {
    /** State pattern -> render gating. Host maps its phases onto the three
     *  EnginePhase states; a no-op until a phase sink is provided. */
    transition(to: EnginePhase): void;
    /** Current engine phase, or null when no phase source is wired. */
    get(): EnginePhase | null;
    subscribe(fn: (phase: EnginePhase | null) => void): Unsubscribe;
  };
  readonly tier: {
    /** Resolved agnostic tier snapshot, or null before the first warmup probe
     *  (or when the host wired no tier port). */
    get(): EffectiveTier | null;
    subscribe(fn: (tier: EffectiveTier | null) => void): Unsubscribe;
  };
  readonly quality: {
    get(): QualityPreset;
    /** Reference impl today: the game's `applyQualityChange` orchestrator
     *  (purge caches -> reset probe bookkeeping -> re-apply profile -> set
     *  physics step -> rebuild). Hot-applied; safe in the Halted phase.
     *  Returns true if applied, false if skipped (e.g. not in the menu phase). */
    update(preset: QualityPreset, override?: QualityPreset | null): boolean;
    subscribe(fn: (preset: QualityPreset) => void): Unsubscribe;
  };
  readonly frame: {
    /** Register a per-frame callback (master-tick flat dispatch). `order` (default
     *  0) sets dispatch priority AMONG frame.add callbacks — lower runs first; equal
     *  order keeps registration order (stable). NOTE: order is scoped to the frame
     *  registry; it does not interleave with callbacks the host registered directly
     *  on the render loop outside this API. Returns an unsubscribe. No-op when the
     *  host wired no frame backend. Frame-rate — imperative work only, never push to
     *  React per frame. */
    add(cb: () => void, order?: number): Unsubscribe;
  };
  /** 3-tier asset cache (global/world/level). Values returned as-is. No-op /
   *  null / 0 when the host wired no assets backend. */
  readonly assets: {
    set<T>(key: string, value: T, tier: AssetTier): T;
    get<T>(key: string): T | null;
    acquire(key: string): boolean;
    release(key: string): void;
    clearTier(tier: AssetTier): void;
    has(key: string): boolean;
    readonly size: number;
  };
  /** Ref-counted shared materials. `acquire` runs the factory once per key. The
   *  material type is a caller-supplied param `M` (the engine never names Babylon
   *  types — the consumer pins the concrete type at the call site); null if
   *  unwired. */
  readonly materials: {
    acquire<M>(key: string, factory: (mat: M) => void): M | null;
    acquireTiered<S, P>(key: string, stdFactory: (mat: S) => void, pbrFactory: (mat: P) => void): S | P | null;
    release(key: string): void;
  };
  /** Object pools. The factory `F` and acquire-result `R` are host-defined,
   *  Babylon-coupled types the consumer pins at the call site (NOT `unknown`); the
   *  engine forwards them untouched. `acquire` returns null if exhausted/unwired. */
  readonly pools: {
    register<F>(key: string, factory: F): void;
    acquire<R>(key: string): R | null;
    releaseType(key: string): void;
    prewarm(key: string, count: number): void;
  };
  /** Input source (lateral steering + jump + target attach), delegating to the
   *  host-injected InputSource (driven port). Device/mode lifecycle (gyro/swipe/
   *  keyboard) stays host-side. No-op unsubscribe / 0 / false when unwired. */
  readonly input: {
    attach(target: unknown): Unsubscribe;
    readonly lateral: number;
    consumeJump(): boolean;
  };
  dispose(): void;
}
