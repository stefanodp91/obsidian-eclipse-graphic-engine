import { ModelTier } from '../../lod';
import { buildGreatWhiteHigh } from './great-white.high';
import { buildGreatWhiteMedium } from './great-white.medium';
import { buildGreatWhiteLow } from './great-white.low';
import type { GreatWhiteModel, GreatWhiteOptions, GreatWhitePose } from './great-white.types';

export type { GreatWhiteModel, GreatWhiteOptions, GreatWhitePose } from './great-white.types';

export function buildGreatWhite(tier: ModelTier, options: GreatWhiteOptions): GreatWhiteModel {
  switch (tier) {
    case ModelTier.High: return buildGreatWhiteHigh(options);
    case ModelTier.Medium: return buildGreatWhiteMedium(options);
    case ModelTier.Low: return buildGreatWhiteLow(options);
  }
}

export function greatWhitePoseAt(elapsedSeconds: number, bite01 = 0): GreatWhitePose {
  const strike = Math.max(0, Math.min(1, bite01));
  const phase = strike > 0.66 ? 'strike' : strike > 0 ? 'recover' : 'cruise';
  const frequency = strike > 0 ? 10.5 : 5.4;
  return {
    phase,
    tailYaw: Math.sin(elapsedSeconds * frequency) * (0.34 + strike * 0.22),
    bodyRoll: Math.sin(elapsedSeconds * 1.3) * 0.018,
    jawOpen: Math.sin(strike * Math.PI) * 0.58,
    thrust: 1 + strike * 0.65,
  };
}

export function applyGreatWhitePose(model: GreatWhiteModel, elapsedSeconds: number, bite01 = 0): GreatWhitePose {
  const pose = greatWhitePoseAt(elapsedSeconds, bite01);
  model.tail.rotation.y = pose.tailYaw;
  model.jaw.rotation.z = -pose.jawOpen;
  model.root.rotation.x = pose.bodyRoll;
  return pose;
}
