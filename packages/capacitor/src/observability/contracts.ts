// Backend-agnostic observability contracts. Pure TS — zero Firebase (or any
// SDK) imports, so the package's standalone typecheck never depends on the
// backend's types. Today the only production impl is Firebase
// (see ./firebase.ts); a future HMS/AGConnect impl implements these same three
// contracts here and a consumer's managers stay untouched.
//
// Event/log methods are fire-and-forget: observability must never destabilize
// gameplay. The consent kill-switch is deliberately different: callers await
// it so the settings UI can report a native bridge failure truthfully.

/** Flat, serializable context attached to a reported error. */
export type CrashContext = Record<string, string | number | boolean | null | undefined>;

/** Crash/non-fatal reporting backend (Firebase Crashlytics, HMS AGConnect, ...). */
export interface CrashReporter {
    /** Record a non-fatal exception with optional flat context. */
    recordException(message: string, context?: CrashContext): void;
    /** Attach a log line to the next crash/non-fatal report. */
    log(message: string): void;
    /** Set a custom key carried with subsequent reports. */
    setCustomKey(key: string, value: string | number | boolean): void;
    /** Associate subsequent reports with a user/installation id (or clear). */
    setUserId(id: string | null): void;
    /** Toggle native collection (consent kill-switch). */
    setEnabled(enabled: boolean): Promise<void>;
}

/** Product-analytics backend (Firebase/GA4, HMS Analytics, ...). */
export interface AnalyticsTracker {
    /** Log a named event with flat params (backend naming rules are the
     *  caller's responsibility — e.g. GA4 snake_case/param limits). */
    logEvent(name: string, params?: Record<string, string | number | boolean>): void;
    /** Associate subsequent events with a user id (or clear). */
    setUserId(id: string | null): void;
    /** Set an anonymous, coarse user-scoped property (device/segment dimension —
     *  e.g. GPU tier, quality preset). Never PII; backend length rules are the
     *  caller's responsibility (GA4: key ≤24, value ≤36 chars). */
    setUserProperty(name: string, value: string): void;
    /** Toggle native collection (consent kill-switch). */
    setEnabled(enabled: boolean): Promise<void>;
}

/** Handle for one running performance trace. */
export interface PerfTraceHandle {
    putAttribute(name: string, value: string): void;
    putMetric(name: string, value: number): void;
    incrementMetric(name: string, by?: number): void;
    stop(): void;
}

/** Performance-monitoring backend (Firebase Performance, HMS APMS, ...). */
export interface PerfTracer {
    /** Start a named custom trace. Never throws; the returned handle is safe
     *  to use even if the underlying SDK call failed (it degrades to no-op). */
    startTrace(name: string): PerfTraceHandle;
    /** Toggle native collection (consent kill-switch). */
    setEnabled(enabled: boolean): Promise<void>;
}
