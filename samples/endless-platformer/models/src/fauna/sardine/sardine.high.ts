import { buildSardineDetailed } from './sardine.shared';
import type { SardineModel, SardineOptions } from './sardine.types';
export const buildSardineHigh = (options: SardineOptions): SardineModel => buildSardineDetailed(options, 16);
