/** SSoT for the Havok fixed-step rate relative to the effective display mode.
 *  Shared by the initial physics plugin setup and the live re-apply
 *  subscription so the two callers never drift.
 *
 *  120 Hz physics applies ONLY when `isHighRefreshRate` is true (display
 *  cap verified at boot) — otherwise clamped to 60 to avoid ~2× Havok CPU
 *  against a 60 Hz panel where the extra steps produce zero visual gain.
 *  Continuous forces integrate identically per second at either rate;
 *  impulses + velocity sets are step-rate-independent. */
export function computePhysicsStepHz(
    physicsStepHz: number,
    isHighRefreshRate: boolean,
): number {
    return isHighRefreshRate ? physicsStepHz : Math.min(physicsStepHz, 60);
}
