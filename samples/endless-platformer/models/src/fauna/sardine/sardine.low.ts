import { buildSardineDetailed } from './sardine.shared';
import type { SardineModel, SardineOptions } from './sardine.types';
export const buildSardineLow = (options: SardineOptions): SardineModel => buildSardineDetailed(options, 7);
