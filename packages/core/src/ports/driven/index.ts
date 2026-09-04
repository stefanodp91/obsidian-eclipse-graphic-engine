// Driven ports: outbound interfaces the engine depends on. Production
// implementations live in adapters/ (babylon, havok, web, memory) or in the
// separate Capacitor plugin package. The core never imports concrete deps.

import type { QualityPreset, Unsubscribe } from '../../domain';

/** Frame-time / vsync source. `fixedDeltaMs`, when set, overrides the real delta
 *  for deterministic lockstep (dev replay / regression harness) — this is the
 *  engine-side home of a consumer-side fixed-timestep hook. */
export interface Clock {
  deltaMs(): number;
  fixedDeltaMs: number | null;
}

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** One-shot sink: engine pushes the resolved audio profile, host applies it. */
export type AudioProfileSink = (preset: QualityPreset) => void;

export type DiagnosticsSink = (snapshot: Readonly<Record<string, unknown>>) => void;

/** Flat, serializable context attached to a reported engine error. */
export type ErrorContext = Record<string, string | number | boolean | null | undefined>;

/** Optional host error sink. The engine is brand-agnostic and never imports a
 *  telemetry SDK; the host injects this to route otherwise-silent engine catches
 *  (corrupt persisted state, unexpected adapter failures) into its observability
 *  pipeline. `domain` is an engine-internal subsystem tag (e.g. 'deviceProbe').
 *  Defaults to a no-op when unset, so the engine stays silent + dep-free. */
export type ErrorSink = (domain: string, error: unknown, context?: ErrorContext) => void;

/** Unit tag for a reported performance metric. */
export type PerfUnit = 'ms' | 'count' | 'ratio';

/** Optional host performance sink, symmetric with ErrorSink: the engine never
 *  imports a perf-monitoring SDK; the host injects this to route episodic
 *  engine perf signals (tier downgrade, DRS scale change — never per-frame
 *  data) into its observability pipeline. Defaults to a no-op when unset. */
export type PerformanceSink = (metric: string, value: number, unit?: PerfUnit) => void;

/** Normalized input (gyro / touch / keyboard / ...). The concrete source stays
 *  host-side; the engine frame loop only reads this neutral surface — it never
 *  knows which physical device produced the values. The host owns device/mode
 *  lifecycle (settings-driven); `attach` is for binding host-target-scoped
 *  listeners only (e.g. tap-to-jump on the render canvas). */
export interface InputSource {
  /** Bind to a host target (e.g. the render canvas/container) and start any
   *  target-scoped listeners. Returns an unsubscribe to detach. */
  attach(target: unknown): Unsubscribe;
  /** Lateral steering axis, normalized to [-1, 1]. Read per frame. */
  readonly lateral: number;
  /** True once per discrete jump request, consumed on read (queued across
   *  frames so multiple taps in one frame are not collapsed). */
  consumeJump(): boolean;
}

/** Display refresh-rate pin: panel max ('max') vs battery-saving 60Hz ('60'). */
export type RefreshMode = '60' | 'max';

/** Device thermal pressure level (Android PowerManager / iOS ProcessInfo). */
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

/** Battery snapshot from the native/web battery API. */
export interface BatteryStatus {
  /** Charge level, 0..1. */
  readonly level: number;
  readonly charging: boolean;
}

/** Real display refresh capability (native Display.Mode enumeration). */
export interface RefreshInfo {
  readonly maxHz: number;
  readonly currentHz: number;
  readonly supported: number[];
}

/** Native perf/battery services. Production impl in the Capacitor plugin
 *  package; web fallback (Null Object) for browser dev. The engine never
 *  imports Capacitor — it reaches all native capability through this port. */
export interface NativeServices {
  /** True on a native (Capacitor) platform; false in browser dev. */
  readonly isNative: boolean;
  /** True specifically on native Android, where the display-mode refresh pin
   *  is the real battery lever (LTPO drops the panel Hz on '60'). */
  readonly isAndroid: boolean;
  /** Poll the current battery status; null when no battery API is available. */
  readBattery(): Promise<BatteryStatus | null>;
  /** Pin the native display refresh mode. Resolves false (no-op) off Android. */
  setRefreshMode(mode: RefreshMode): Promise<boolean>;
  /** Real display capability; null off native Android. */
  getRefreshInfo(): Promise<RefreshInfo | null>;
  /** Current device thermal level ('nominal' off native). */
  readThermalState(): Promise<ThermalState>;
  /** Subscribe to thermal-level changes; returns an unsubscribe. No-op off native. */
  onThermalStateChange(fn: (state: ThermalState) => void): Unsubscribe;
  /** Thermal budget consumed, 0..1 (1 = severe throttling), optionally forecast
   *  at `forecastSeconds`. **null = signal unavailable**, never 0: Android < API
   *  30, iOS (Apple exposes no equivalent), web, or NaN returned by the OS on
   *  queries that are too close together (~10s minimum). It is the only
   *  continuous, anticipatory thermal signal: `readThermalState` is stepped and
   *  arrives when the device is already throttling. */
  readThermalHeadroom(forecastSeconds?: number): Promise<number | null>;
  /** Hold/release a screen wake lock (native KeepAwake → web WakeLock fallback). */
  requestWakeLock(): Promise<void>;
  releaseWakeLock(): Promise<void>;
  /** Async persistent key-value storage (native Preferences → localStorage). */
  readonly prefs: AsyncKeyValueStorage;
}

/** Async persistent storage (Capacitor Preferences semantics). Distinct from the
 *  synchronous KeyValueStorage used for the engine's own small flags. */
export interface AsyncKeyValueStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface RenderingBackend {
  /** Render gating: loop on/off + physics on/off, per EnginePhase. */
  setGating(renderOn: boolean, physicsOn: boolean): void;
  dispose(): void;
}

export interface PhysicsBackend {
  setStepRateHz(hz: number): void;
  dispose(): void;
}
