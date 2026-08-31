import { buildGreatWhiteDetailed } from './great-white.shared';
import type { GreatWhiteModel, GreatWhiteOptions } from './great-white.types';

export function buildGreatWhiteLow(options: GreatWhiteOptions): GreatWhiteModel {
  return buildGreatWhiteDetailed(options, { bodySteps: 16, radialSegments: 10, toothCount: 4, poreCount: 0 });
}
