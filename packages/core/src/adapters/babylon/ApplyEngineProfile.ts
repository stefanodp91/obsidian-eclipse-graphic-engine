// One-shot quality profile application — runs once at scene-ready.
//
// Reads the active EngineQualityProfile (injected via configureEngineProfileProvider)
// and applies engine + scene + audio knobs. Snapshot at boot: live tuning via
// hot-quality-change is handled by applyQualityChange (game-side orchestrator).
//
// `onTierResolved` is an optional game-side hook for brand-specific side effects
// (DOM attributes, CSS class toggles) that must not live in engine code.

import type { AbstractEngine, Scene } from '@babylonjs/core';
import { engineHandles } from './engineHandles';
import { getActiveEngineProfile } from '../../domain/engineProfile';
import { measureRefreshRate } from '../web/measureRefreshRate';
import type { QualityPreset } from '../../domain/qualityTypes';

function applyBaseBackbufferSize(engine: AbstractEngine): void {
    const nativeDpr = window.devicePixelRatio || 1;
    engine.setHardwareScalingLevel(1 / nativeDpr);
}

/** Apply universal scene flags + per-profile engine state. Runs ONCE at
 *  onSceneReady.
 *
 *  @param onTierResolved — optional hook called with the resolved quality tier.
 *  Use it for brand-specific side effects (DOM attributes, CSS class toggles). */
export function applyEngineProfile(
    engine: AbstractEngine,
    scene: Scene,
    preset: QualityPreset,
    override: QualityPreset | null,
    onTierResolved?: (tier: 'hi' | 'mid' | 'lo') => void,
): void {
    const profile = getActiveEngineProfile(preset);

    onTierResolved?.(profile.qualityTier);

    applyBaseBackbufferSize(engine);

    // Set maxFPS well above any display (240) so vsync via rAF is the natural
    // cap — avoids Babylon's frame-throttle boundary races.
    //
    // This is the BOOT value, not the policy: what really governs the frame rate
    // at runtime is the consuming application, with two levers that do NOT go through here —
    // attachRefreshPreference (native panel pin on Android, maxFPS on iOS/web)
    // and the per-phase renderFpsCap applied as frame-skip by the RenderLoopGate.
    // Do not add a third owner of engine.maxFPS.
    engine.maxFPS = 240;
    void measureRefreshRate().then((hz) => {
        console.info(`[applyEngineProfile] display refresh measured: ${hz} Hz (engine.maxFPS=240, vsync gates)`);
    });

    // Manual scene flags (equivalent to ScenePerformancePriority.Intermediate
    // but applied directly to avoid render-loop stall on WebGPU + ultra preset).
    scene.skipPointerMovePicking = true;
    scene.blockMaterialDirtyMechanism = true;
    scene.autoClearDepthAndStencil = true;

    // Anisotropic level from mipBias: 0→4 (hi), 0.5→2 (mid), 1.0→1 (lo).
    const anisoLevel = Math.max(1, Math.round(4 * (1 - profile.mipBias)));
    for (const tex of scene.textures) {
        tex.anisotropicFilteringLevel = anisoLevel;
    }

    engineHandles.audioSink?.(preset);
}
