// Engine-owned named constants — no magic numbers in implementation.
// Calibrated for Babylon.js fixed-step physics + mobile GPU tier probing.

// ── Device probe tier thresholds ────────────────────────────────────────────
// Boot probe measures rendered scale vs target scale. Values below classify the
// device into a quality tier before gameplay starts.

/** Scale ratio above which the device is considered 'hi' (flagship) tier. */
export const PROBE_TIER_THRESHOLD_HI = 0.95;

/** Scale ratio above which the device is considered 'mid' tier (below = 'lo'). */
export const PROBE_TIER_THRESHOLD_MID = 0.78;

/** Conservative factor applied to the boot probe result. A small pessimism
 *  prevents a device that barely sustains 'hi' at boot from being mis-classified
 *  (gameplay is heavier than the pre-game menu scene probed during boot). */
export const BOOT_PROBE_PESSIMISM = 0.95;

// ── Warmup (per-level) probe LOD downgrade ratios ───────────────────────────
// Warmup probe measures median frame time vs target. If the ratio exceeds a
// threshold the level switches to a lighter LOD tier for this session.

/** Frame-time ratio above which 'mid' assets are selected (~46fps @ 60Hz). */
export const LOD_DOWNGRADE_MID_RATIO = 1.30;

/** Frame-time ratio above which 'lo' assets are selected (~37fps @ 60Hz). */
export const LOD_DOWNGRADE_LO_RATIO = 1.60;

// ── Physics accumulator ──────────────────────────────────────────────────────
/** Maximum physics substeps per render frame. Scene.MaxDeltaTime is set to
 *  `stepMs × MAX_DELTA_SUBSTEPS` to bound Havok spiral-of-death on slow frames. */
export const MAX_DELTA_SUBSTEPS = 4;

// ── Probe frame budgets ──────────────────────────────────────────────────────
// Initial frames skipped before sampling (jitter / context-switch noise).
/** Frames to discard at probe start before recording frame times. */
export const PROBE_SKIP_FRAMES = 10;

/** Samples collected by the boot (device) probe. More samples → stable median
 *  at the cost of a longer loading-screen delay (~1s @ 60Hz). */
export const BOOT_PROBE_MEASURE_FRAMES = 60;

/** Samples collected by the per-level warmup probe. Shorter than the boot
 *  probe since the scene is already warm and the loading screen is visible. */
export const WARMUP_PROBE_MEASURE_FRAMES = 30;
