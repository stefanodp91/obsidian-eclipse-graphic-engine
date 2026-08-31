import { buildReefSquidDetailed } from './reef-squid.shared';
import type { ReefSquidModel, ReefSquidOptions } from './reef-squid.types';
export const buildReefSquidMedium = (options: ReefSquidOptions): ReefSquidModel => buildReefSquidDetailed(options, 14, 8);
