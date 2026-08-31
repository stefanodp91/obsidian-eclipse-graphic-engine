import { ModelTier } from '../../lod';
import { buildSardineHigh } from './sardine.high';
import { buildSardineMedium } from './sardine.medium';
import { buildSardineLow } from './sardine.low';
import type { SardineModel, SardineOptions } from './sardine.types';
export type { SardineModel, SardineOptions } from './sardine.types';

export function buildSardine(tier: ModelTier, options: SardineOptions): SardineModel {
  switch (tier) {
    case ModelTier.High: return buildSardineHigh(options);
    case ModelTier.Medium: return buildSardineMedium(options);
    case ModelTier.Low: return buildSardineLow(options);
  }
}

export function applySardinePose(model: SardineModel, elapsedSeconds: number, panic01 = 0): void {
  model.tail.rotation.y = Math.sin(elapsedSeconds * (9 + panic01 * 8) + model.phase) * (0.36 + panic01 * 0.22);
  model.root.rotation.z = Math.sin(elapsedSeconds * 2.2 + model.phase) * 0.025;
}
