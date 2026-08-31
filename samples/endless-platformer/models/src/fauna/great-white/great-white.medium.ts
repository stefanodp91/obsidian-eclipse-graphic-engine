import { buildGreatWhiteDetailed } from './great-white.shared';
import type { GreatWhiteModel, GreatWhiteOptions } from './great-white.types';

export function buildGreatWhiteMedium(options: GreatWhiteOptions): GreatWhiteModel {
  return buildGreatWhiteDetailed(options, { bodySteps: 24, radialSegments: 16, toothCount: 6, poreCount: 6 });
}
