import { ModelTier } from '../../lod';
import { buildReefSquidHigh } from './reef-squid.high';
import { buildReefSquidMedium } from './reef-squid.medium';
import { buildReefSquidLow } from './reef-squid.low';
import type { ReefSquidModel, ReefSquidOptions } from './reef-squid.types';
export type { ReefSquidModel, ReefSquidOptions } from './reef-squid.types';

export function buildReefSquid(tier: ModelTier, options: ReefSquidOptions): ReefSquidModel {
  switch (tier) {
    case ModelTier.High: return buildReefSquidHigh(options);
    case ModelTier.Medium: return buildReefSquidMedium(options);
    case ModelTier.Low: return buildReefSquidLow(options);
  }
}

export function applyReefSquidPose(model: ReefSquidModel, elapsedSeconds: number, panic01 = 0): void {
  for (const [index, arm] of model.arms.entries()) {
    arm.rotation.z = Math.sin(elapsedSeconds * (3.5 + panic01 * 4) + model.phase + index * 0.7) * 0.18;
  }
  model.root.scaling.x = 1 + Math.sin(elapsedSeconds * 3 + model.phase) * 0.04;
}
