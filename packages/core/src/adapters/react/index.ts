// Driving adapter on React 19 (Fase 5): GraphicEngineProvider + signal-based
// hooks. Imports react (optional peer). Uses createElement (no JSX) so the
// module stays a plain .ts with zero jsx-config dependency in the engine
// package. React remains a peer dependency so the application supplies one
// shared runtime instance and avoids duplicate-copy "Invalid hook call" errors.
//
// Hooks are signal-based via useSyncExternalStore: selective subscription, no
// re-render storm. NOTE: the injected tier port's get() MUST return a
// referentially-stable snapshot between real changes, otherwise
// useSyncExternalStore loops on a fresh object.
//
import { createContext, createElement, useCallback, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { GraphicEngine } from '../../ports/driving';
import type { EffectiveTier, EnginePhase, QualityPreset } from '../../domain';

// undefined = no provider in tree (distinct from null = engine not yet created).
const EngineContext = createContext<GraphicEngine | null | undefined>(undefined);

export interface GraphicEngineProviderProps {
  /** The engine instance (created via createGraphicEngine in scene-ready), or
   *  null while the scene/engine is still booting. */
  readonly engine: GraphicEngine | null;
  readonly children: ReactNode;
}

/** Provides the GraphicEngine to the React subtree. Adopts an existing instance
 *  (the host creates it imperatively on scene-ready and lifts it into state). */
export function GraphicEngineProvider(props: GraphicEngineProviderProps) {
  return createElement(EngineContext.Provider, { value: props.engine }, props.children);
}

/** The engine instance, or null while booting. Throws outside a provider. */
export function useEngine(): GraphicEngine | null {
  const ctx = useContext(EngineContext);
  if (ctx === undefined) {
    throw new Error('useEngine must be used within <GraphicEngineProvider>');
  }
  return ctx;
}

// subscribe/getSnapshot are memoized on `engine` so useSyncExternalStore does
// NOT tear down + re-subscribe on every host re-render (e.g. PerfHud's 250ms
// tick would otherwise churn ~16 unsubscribe/resubscribe cycles/sec).

/** Reactive read of the resolved tier snapshot, or null before the first probe
 *  (or while the engine is booting). Re-renders only when the snapshot changes. */
export function useTier(): EffectiveTier | null {
  const engine = useEngine();
  const subscribe = useCallback(
    (onChange: () => void) => (engine ? engine.tier.subscribe(() => onChange()) : () => {}),
    [engine],
  );
  const getSnapshot = useCallback(() => (engine ? engine.tier.get() : null), [engine]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Reactive read of the active quality preset, or null while booting. */
export function useQuality(): QualityPreset | null {
  const engine = useEngine();
  const subscribe = useCallback(
    (onChange: () => void) => (engine ? engine.quality.subscribe(() => onChange()) : () => {}),
    [engine],
  );
  const getSnapshot = useCallback(() => (engine ? engine.quality.get() : null), [engine]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Reactive read of the current engine phase (Active/Reduced/Halted), or null
 *  while booting / when no phase source is wired. */
export function usePhase(): EnginePhase | null {
  const engine = useEngine();
  const subscribe = useCallback(
    (onChange: () => void) => (engine ? engine.phase.subscribe(() => onChange()) : () => {}),
    [engine],
  );
  const getSnapshot = useCallback(() => (engine ? engine.phase.get() : null), [engine]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Register a per-frame callback for the component's lifetime. The callback runs
 *  at frame rate via the engine's master-tick dispatch — do IMPERATIVE work only
 *  (mutate a ref, drive a Babylon object); NEVER setState per frame. Registers
 *  once per engine; the latest `cb` is always invoked (via ref), so an inline
 *  closure does not re-register every render. */
export function useFrame(cb: () => void): void {
  const engine = useEngine();
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    if (!engine) return;
    return engine.frame.add(() => cbRef.current());
  }, [engine]);
}
