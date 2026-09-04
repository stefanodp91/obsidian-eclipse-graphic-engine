// Zero-overhead pub/sub. Generalization of the consumer-side `runtimeRefs` pattern:
// the engine needs only `tier` + `diagnostics` as observables, so it ships its
// own ~40-LOC signal instead of depending on Zustand (avoids version coupling).
// The host adapter bridges signal -> Zustand for its own React UI.

export type Unsubscribe = () => void;

export interface Signal<T> {
  get(): T;
  set(next: T): void;
  subscribe(fn: (value: T) => void): Unsubscribe;
}

export function createSignal<T>(initial: T): Signal<T> {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const fn of subs) fn(value);
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
