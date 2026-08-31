const LANDSCAPE_ASPECT = 16 / 9;
const LANDSCAPE_VERTICAL_FOV = 0.72;
const MAX_PORTRAIT_VERTICAL_FOV = 1.2;
const LANDSCAPE_CAMERA_LEAD = 8.1;
const PORTRAIT_CAMERA_LEAD = 3;

/**
 * Keeps most of the horizontal play area visible on narrow screens while
 * limiting the amount of world revealed above and below the ocean route.
 */
export function verticalFovForAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return LANDSCAPE_VERTICAL_FOV;

  const matchingHorizontalView = 2 * Math.atan(
    Math.tan(LANDSCAPE_VERTICAL_FOV / 2) * LANDSCAPE_ASPECT / aspect,
  );

  return Math.min(
    MAX_PORTRAIT_VERTICAL_FOV,
    Math.max(LANDSCAPE_VERTICAL_FOV, matchingHorizontalView),
  );
}

/** Places the player farther from the left edge as the viewport narrows. */
export function cameraLeadForAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return LANDSCAPE_CAMERA_LEAD;

  const progress = Math.min(1, Math.max(0, (aspect - 9 / 16) / (LANDSCAPE_ASPECT - 9 / 16)));
  return PORTRAIT_CAMERA_LEAD
    + (LANDSCAPE_CAMERA_LEAD - PORTRAIT_CAMERA_LEAD) * progress;
}
