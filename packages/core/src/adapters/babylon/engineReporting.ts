// Engine-internal error reporting. The engine is brand-agnostic and never
// imports a telemetry SDK; the host (game) injects an ErrorSink at boot via
// setEngineErrorSink, and engine adapters route otherwise-silent catches
// through reportEngineError. Until a sink is injected this is a no-op, so the
// engine stays silent and dependency-free by default.
import type { ErrorContext, ErrorSink } from '../../ports/driven';

let _sink: ErrorSink | null = null;

/** Inject (or clear) the host error sink. Call once at app boot. */
export function setEngineErrorSink(sink: ErrorSink | null): void {
    _sink = sink;
}

/** Report an otherwise-silent engine-internal failure. No-op until the host
 *  injects a sink. The reporting path itself never throws into the caller. */
export function reportEngineError(domain: string, error: unknown, context?: ErrorContext): void {
    if (!_sink) return;
    try {
        _sink(domain, error, context);
    } catch {
        /* a broken sink must never destabilize the engine */
    }
}
