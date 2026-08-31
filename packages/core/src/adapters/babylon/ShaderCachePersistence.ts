// Shader-cache persistence (R1 fase 1, 2026-07-02).
//
// Problema: gli Effect Babylon sono ref-counted — quando l'ultimo material che
// usa una variante viene disposto (materiali level-scoped: skin del player,
// ostacoli, decor per-livello), il PROGRAMMA GPU compilato viene rimosso da
// `engine._compiledEffects`. Alla transizione di livello successiva le stesse
// varianti vengono ricompilate da zero: misurato sul target di riferimento
// ~35 effect ricompilati per transizione (long task 0.6-1.1s su GPU flagship,
// ~2-4s su mid) — la voce dominante dei freeze di transizione.
//
// Fix: `Effect.PersistentMode` (knob ufficiale Babylon) rende `dispose()`
// non-force un no-op → i programmi compilati restano residenti per la vita
// dell'engine. Il costo è memoria GPU/JS limitata al numero di varianti uniche
// (~100 per questo profilo di gioco, pochi MB); il teardown reale resta
// garantito da `engine.dispose()`/`releaseEffects()` (path force).
import { Effect } from '@babylonjs/core';

/** Attiva la persistenza della cache shader (idempotente). */
export function installPersistentShaderCache(): void {
    Effect.PersistentMode = true;
}

/** Ripristina il ref-counting standard (test/teardown). */
export function uninstallPersistentShaderCache(): void {
    Effect.PersistentMode = false;
}
