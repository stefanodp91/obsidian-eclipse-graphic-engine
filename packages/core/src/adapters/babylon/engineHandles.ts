// Mutable holder for the singleton engine/scene/physics objects created once
// at app mount. Lets imperative subsystems that run OUTSIDE the React tree
// (e.g. quality-change orchestrators called from a Zustand action) reach the
// live engine without prop-drilling or a dev-only window handle.
//
// NOT a per-frame state bag: these are session-lifetime infrastructure handles,
// set once at scene-ready and cleared on scene dispose.

import type { AbstractEngine, HavokPlugin, Scene } from '@babylonjs/core';
import type { AudioProfileSink, InputSource, KeyValueStorage, NativeServices } from '../../ports/driven';

export interface EngineHandles {
    engine: AbstractEngine | null;
    scene: Scene | null;
    havokPlugin: HavokPlugin | null;
    /** Re-asserts the maxFPS / native refresh pin after any profile reset. */
    applyRefreshPref: (() => void) | null;
    /** Audio sink receiving the resolved QualityPreset. */
    audioSink: AudioProfileSink | null;
    /** Namespaced storage adapter used instead of direct localStorage access. */
    kvStorage: KeyValueStorage | null;
    /** Input adapter exposing the neutral lateral-axis and jump surface. */
    inputSource: InputSource | null;
    /** Native performance and battery services supplied through a port. */
    nativeServices: NativeServices | null;
}

/** Create an isolated handle bag. The exported singleton remains as a
 * compatibility shim while consumers migrate to per-engine ownership. */
export function createEngineHandles(): EngineHandles {
    return {
        engine: null,
        scene: null,
        havokPlugin: null,
        applyRefreshPref: null,
        audioSink: null,
        kvStorage: null,
        inputSource: null,
        nativeServices: null,
    };
}

export const engineHandles: EngineHandles = createEngineHandles();
