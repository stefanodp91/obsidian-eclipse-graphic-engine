import { buildGreatWhiteDetailed } from './great-white.shared';
import type { GreatWhiteModel, GreatWhiteOptions } from './great-white.types';

export function buildGreatWhiteHigh(options: GreatWhiteOptions): GreatWhiteModel {
  return buildGreatWhiteDetailed(options, { bodySteps: 34, radialSegments: 24, toothCount: 9, poreCount: 9 });
}
