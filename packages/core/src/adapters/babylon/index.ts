// RenderingBackend on Babylon 9: session-lifetime engine handles,
// MeshPool / ThinInstancePool (Object Pool), AssetCache (3-tier),
// quality-purge registry. Imports @babylonjs/core (peer dep).
export type { EngineHandles } from './engineHandles';
export { engineHandles } from './engineHandles';
export { setEngineErrorSink, reportEngineError } from './engineReporting';
export { setEnginePerformanceSink, reportEnginePerf } from './enginePerf';
export type {
    PoolFactory,
    PoolFactoryResult,
    PooledItem,
    AcquireResult,
    PoolStats,
} from './MeshPool';
export {
    registerPoolType,
    getRegisteredPoolKeys,
    prewarmPool,
    hideAllPrewarmed,
    acquireFromPool,
    releaseTypeFromPool,
    releaseAllPools,
    getPoolStats,
    selectAllForPrewarmRender,
    beginPrewarmBatch,
    selectNewlyPrewarmedForRender,
    resetPrewarmSelect,
} from './MeshPool';
export type {
    ThinInstancePoolOptions,
    ThinInstanceHandle,
    ThinInstancePool,
} from './ThinInstancePool';
export { createThinInstancePool } from './ThinInstancePool';
export type { SharedShapeOpts } from './sharedShapes';
export {
    purgeShapeCache,
    sharedBoxAggregate,
    dimsKeyFor,
} from './sharedShapes';
export { startPoolTelemetry, stopPoolTelemetry } from './poolTelemetry';
export { AssetCache } from './AssetCache';
export {
    registerScenePurge,
    registeredPurgerCount,
    purgeAllSceneCaches,
} from './qualityPurgeRegistry';
export type { RenderLoopGateOpts } from './RenderLoopGate';
export { setupRenderLoopGate } from './RenderLoopGate';
export { suppressLogNoise, restoreLogNoise } from './SuppressLogNoise';
export type { MasterTickOpts } from './MasterTick';
export { installMasterTick } from './MasterTick';
export { installPersistentShaderCache, uninstallPersistentShaderCache } from './ShaderCachePersistence';
export {
    readDrawCalls,
    readActiveIndices,
    readActiveTriangles,
    sumActiveVerts,
} from './EngineCounters';
export { applyEngineProfile } from './ApplyEngineProfile';
export {
    setShadowGenerator,
    registerScriptedShadow,
    unregisterScriptedShadow,
    setPrimaryShadowCaster,
    getShadowReceivers,
    addShadowReceiver,
    removeShadowReceiver,
} from './ShadowRegistry';
export {
    setHighlightLayer,
    addHighlightedMesh,
    removeHighlightedMesh,
    clearHighlights,
} from './HighlightRegistry';
export {
    registerMotionBlurProcess,
    unregisterMotionBlurProcess,
    triggerMotionBlur,
} from './MotionBlurController';
export { RenderPauser } from './RenderPauser';
export { applyBakedSunLight, applyBakedCavityAO } from './BakedLighting';
export type { RealismLodBudget } from './RealismKit';
export type { AtlasRect, EyeSpec } from './RealismUv';
export { mapPlanarUV, pinUvWhite, eyeRingColor, buildEyeSphere } from './RealismUv';
export {
    REALISM_LOD,
    realismSkin,
    fbmDisplace,
    paintVertexColor,
    paintCanary,
    organicTube,
    organicMembrane,
} from './RealismKit';
export type { MeshRenderInterpolationHandle } from './MeshRenderInterpolation';
export { attachMeshRenderInterpolation } from './MeshRenderInterpolation';
export type { Rgb01 } from './ColorUtils';
export {
    hexToRgb01,
    hexToColor3,
    hexToColor4,
    hexToCss,
    lightenHex,
    darkenHex,
    lightenRgb01,
} from './ColorUtils';
export {
    configureQualityPresetProvider,
    configurePBRLowMaskKeys,
    createUnlitEmissiveMat,
    createUnlitEmissiveCrystalMat,
    createSelfLitVertexColorMat,
    createLitVertexColorMat,
    createFlatLitVertexColorMat,
    createFlatLitMat,
    getDecorMatcap,
    createMatcapVertexColorMat,
    setDecorShadingMode,
    getDecorShadingMode,
    setCelFreezeMaterials,
    shouldFreezeUnderCel,
    MATCAP_EMISSIVE_FLOOR_K,
    MATCAP_G4_LEVEL,
    MATCAP_G4_CAVITY,
    DECOR_EMISSIVE_FLOOR,
    FLAT_EMISSIVE_FLOOR_K,
    acquireMaterial,
    acquirePBRMaterial,
    acquireTieredMaterial,
    releaseMaterial,
    releasePBRMaterial,
    disposeAll as disposeAllMaterials,
    peekMaterial,
    peekPBRMaterial,
    forceCompileMaterial,
} from './MaterialLibrary';
export type { DecorMatcapKind, DecorShadingMode } from './MaterialLibrary';
export type {
    DeviceProbeSignalSnapshot,
    DeviceProbeSignalSource,
    DeviceTierCap,
    DeviceCap,
} from './DeviceProbe';
export {
    configureDeviceProbe,
    getDeviceCap,
    invalidateDeviceCap,
    getDeviceScaleCap,
    getDeviceTierCap,
    attachReprobeTriggers,
    persistLearnedCap,
    runDeviceProbe,
} from './DeviceProbe';

// Cel-shading prototype (branch proto/cel-shading) — see ./cel/index.ts.
// Re-exported wholesale: it is an experimental subsystem, it is not part of the
// engine's stable contract, and it comes out wholesale if the look does not pass.
export * from './cel';
