import { buildReefSquidDetailed } from './reef-squid.shared';
import type { ReefSquidModel, ReefSquidOptions } from './reef-squid.types';
export const buildReefSquidLow = (options: ReefSquidOptions): ReefSquidModel => buildReefSquidDetailed(options, 8, 4);
