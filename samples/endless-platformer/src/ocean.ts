export interface OceanPose {
  readonly surfaceY: number;
  readonly driftX: number;
  readonly liftY: number;
}

/** The single motion law used by the visible surface, particles and swimmer. */
export function oceanPoseAt(timeSeconds: number, worldX: number): OceanPose {
  const primary = Math.sin(worldX * 0.31 + timeSeconds * 1.25);
  const secondary = Math.sin(worldX * 0.77 - timeSeconds * 0.72);
  return {
    surfaceY: 6.15 + primary * 0.22 + secondary * 0.08,
    driftX: 0.22 + primary * 0.04,
    liftY: secondary * 0.07,
  };
}
