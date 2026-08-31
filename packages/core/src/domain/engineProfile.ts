// Provider-injection pattern for engine-pure quality profile access.
// Game-side boot calls configureEngineProfileProvider(getActiveQualityProfile)
// once, wiring the game's full QualityProfile (superset of EngineQualityProfile)
// to the engine without importing game modules here.

import type { QualityPreset, EngineQualityProfile } from './qualityTypes';

const DEFAULT: EngineQualityProfile = {
    qualityTier: 'mid',
    mipBias: 0.5,
    disableLighting: false,
    emissiveBoost: 1.0,
    physicsStepHz: 60,
};

export interface EngineProfileRegistry {
    provider: (preset: QualityPreset) => EngineQualityProfile;
}

export function createEngineProfileRegistry(): EngineProfileRegistry {
    return { provider: () => DEFAULT };
}

const defaultProfileRegistry = createEngineProfileRegistry();

export function configureEngineProfileProvider(
    fn: (preset: QualityPreset) => EngineQualityProfile,
    registry: EngineProfileRegistry = defaultProfileRegistry,
): void {
    registry.provider = fn;
}

export function getActiveEngineProfile(
    preset: QualityPreset,
    registry: EngineProfileRegistry = defaultProfileRegistry,
): EngineQualityProfile {
    return registry.provider(preset);
}
