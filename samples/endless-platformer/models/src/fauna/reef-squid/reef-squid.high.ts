import { buildReefSquidDetailed } from './reef-squid.shared';
import type { ReefSquidModel, ReefSquidOptions } from './reef-squid.types';
export const buildReefSquidHigh = (options: ReefSquidOptions): ReefSquidModel => buildReefSquidDetailed(options, 20, 10);
