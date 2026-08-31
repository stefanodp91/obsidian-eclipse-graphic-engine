import { buildSardineDetailed } from './sardine.shared';
import type { SardineModel, SardineOptions } from './sardine.types';
export const buildSardineMedium = (options: SardineOptions): SardineModel => buildSardineDetailed(options, 10);
