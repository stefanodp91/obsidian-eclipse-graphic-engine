// Facade-only root. Concrete adapters live behind explicit subpath exports so
// consumers pay only for the platform integrations they choose.
export * from './domain';
export type { GraphicEngine } from './ports/driving';
export type {
  Clock,
  KeyValueStorage,
  AudioProfileSink,
  DiagnosticsSink,
  ErrorContext,
  ErrorSink,
  PerfUnit,
  PerformanceSink,
  InputSource,
  NativeServices,
  RefreshMode,
  ThermalState,
  BatteryStatus,
  RefreshInfo,
  AsyncKeyValueStorage,
  RenderingBackend,
  PhysicsBackend,
} from './ports/driven';
export { createGraphicEngine } from './api';
export type {
  CreateGraphicEngineOptions,
  QualityPort,
  TierPort,
  PhasePort,
  FramePort,
  AssetsPort,
  MaterialsPort,
  PoolsPort,
  PhaseSink,
} from './api';
