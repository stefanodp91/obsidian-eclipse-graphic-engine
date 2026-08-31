// Firebase implementations of the observability contracts, backed by the
// @capacitor-firebase/* plugins (auto-registered natively via `npx cap sync`).
//
// Each factory is async and resolves to `null` off-native, so the game keeps
// its Noop impls on web/dev. The plugin modules are plain dynamic imports —
// same rule as src/index.ts: the game's webpack bundles them into async
// chunks; `webpackIgnore` would leave a bare specifier a WebView cannot
// resolve. Event calls stay best-effort; setEnabled propagates bridge failures
// because it is the user-visible consent kill-switch.

import { Capacitor } from '@capacitor/core';
import type { AnalyticsTracker, CrashContext, CrashReporter, PerfTraceHandle, PerfTracer } from './contracts';

const isNativePlatform = (): boolean => {
    try { return Capacitor.isNativePlatform(); } catch { return false; }
};

type CustomKeyType = 'string' | 'long' | 'double' | 'boolean';

function customKeyType(value: string | number | boolean): CustomKeyType {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return Number.isInteger(value) ? 'long' : 'double';
    return 'string';
}

function contextSuffix(context?: CrashContext): string {
    if (!context) return '';
    try { return ` | ${JSON.stringify(context)}`; } catch { return ''; }
}

/** Crashlytics-backed CrashReporter; `null` off-native. */
export async function createFirebaseCrashReporter(): Promise<CrashReporter | null> {
    if (!isNativePlatform()) return null;
    let mod: typeof import('@capacitor-firebase/crashlytics');
    try { mod = await import('@capacitor-firebase/crashlytics'); } catch { return null; }
    const { FirebaseCrashlytics } = mod;
    return {
        recordException(message, context) {
            void FirebaseCrashlytics.recordException({ message: `${message}${contextSuffix(context)}` }).catch(() => {});
        },
        log(message) {
            void FirebaseCrashlytics.log({ message }).catch(() => {});
        },
        setCustomKey(key, value) {
            void FirebaseCrashlytics.setCustomKey({ key, value, type: customKeyType(value) }).catch(() => {});
        },
        setUserId(id) {
            void FirebaseCrashlytics.setUserId({ userId: id ?? '' }).catch(() => {});
        },
        async setEnabled(enabled) {
            await FirebaseCrashlytics.setEnabled({ enabled });
        },
    };
}

/** Firebase-Analytics-backed AnalyticsTracker; `null` off-native. */
export async function createFirebaseAnalyticsTracker(): Promise<AnalyticsTracker | null> {
    if (!isNativePlatform()) return null;
    let mod: typeof import('@capacitor-firebase/analytics');
    try { mod = await import('@capacitor-firebase/analytics'); } catch { return null; }
    const { FirebaseAnalytics } = mod;
    return {
        logEvent(name, params) {
            void FirebaseAnalytics.logEvent({ name, params: params ?? {} }).catch(() => {});
        },
        setUserId(id) {
            void FirebaseAnalytics.setUserId({ userId: id }).catch(() => {});
        },
        setUserProperty(name, value) {
            void FirebaseAnalytics.setUserProperty({ key: name, value }).catch(() => {});
        },
        async setEnabled(enabled) {
            await FirebaseAnalytics.setEnabled({ enabled });
        },
    };
}

/** Firebase-Performance-backed PerfTracer; `null` off-native.
 *
 *  The native plugin keys traces by name (no handle object crosses the
 *  bridge), so the handle wraps its `traceName`; two concurrent traces with
 *  the same name would collide — callers use distinct names per trace. */
export async function createFirebasePerfTracer(): Promise<PerfTracer | null> {
    if (!isNativePlatform()) return null;
    let mod: typeof import('@capacitor-firebase/performance');
    try { mod = await import('@capacitor-firebase/performance'); } catch { return null; }
    const { FirebasePerformance } = mod;
    return {
        startTrace(name): PerfTraceHandle {
            // Chain every handle op after the start call so ordering holds
            // even though the contract surface is synchronous.
            let chain: Promise<unknown> = FirebasePerformance.startTrace({ traceName: name }).catch(() => {});
            const after = (op: () => Promise<unknown>): void => {
                chain = chain.then(op).catch(() => {});
            };
            return {
                putAttribute(attribute, value) {
                    after(() => FirebasePerformance.putAttribute({ traceName: name, attribute, value }));
                },
                putMetric(metricName, num) {
                    after(() => FirebasePerformance.putMetric({ traceName: name, metricName, num }));
                },
                incrementMetric(metricName, by) {
                    after(() => FirebasePerformance.incrementMetric({ traceName: name, metricName, incrementBy: by ?? 1 }));
                },
                stop() {
                    after(() => FirebasePerformance.stopTrace({ traceName: name }));
                },
            };
        },
        async setEnabled(enabled) {
            await FirebasePerformance.setEnabled({ enabled });
        },
    };
}
