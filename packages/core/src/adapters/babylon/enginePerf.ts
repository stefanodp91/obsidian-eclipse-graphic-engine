// Engine-internal performance reporting. Same discipline as engineReporting:
// the engine is brand-agnostic and never imports a perf-monitoring SDK; the
// host injects a PerformanceSink at boot via setEnginePerformanceSink, and
// engine adapters route EPISODIC signals (tier downgrade, DRS scale change —
// never per-frame data) through reportEnginePerf. Until a sink is injected
// this is a no-op, so the engine stays silent and dependency-free by default.
import type { PerformanceSink, PerfUnit } from '../../ports/driven';

let _sink: PerformanceSink | null = null;

/** Inject (or clear) the host performance sink. Call once at app boot. */
export function setEnginePerformanceSink(sink: PerformanceSink | null): void {
    _sink = sink;
}

/** Report an episodic engine performance signal. No-op until the host injects
 *  a sink. The reporting path itself never throws into the caller. */
export function reportEnginePerf(metric: string, value: number, unit?: PerfUnit): void {
    if (!_sink) return;
    try {
        _sink(metric, value, unit);
    } catch {
        /* a broken sink must never destabilize the engine */
    }
}
