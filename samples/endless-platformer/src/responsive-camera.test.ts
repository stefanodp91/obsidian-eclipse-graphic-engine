import { describe, expect, it } from 'vitest';
import { cameraLeadForAspect, verticalFovForAspect } from './responsive-camera';

describe('responsive camera', () => {
  it('preserves the authored landscape framing', () => {
    expect(verticalFovForAspect(16 / 9)).toBeCloseTo(0.72);
    expect(verticalFovForAspect(21 / 9)).toBeCloseTo(0.72);
  });

  it('widens the vertical view for portrait screens without an extreme zoom-out', () => {
    const portraitFov = verticalFovForAspect(9 / 16);
    expect(portraitFov).toBeGreaterThan(0.72);
    expect(portraitFov).toBeLessThanOrEqual(1.2);
  });

  it('falls back safely while the canvas has no measurable size', () => {
    expect(verticalFovForAspect(0)).toBeCloseTo(0.72);
    expect(verticalFovForAspect(Number.NaN)).toBeCloseTo(0.72);
  });

  it('keeps the player inside the narrower portrait composition', () => {
    expect(cameraLeadForAspect(16 / 9)).toBeCloseTo(8.1);
    expect(cameraLeadForAspect(9 / 16)).toBeCloseTo(3);
    expect(cameraLeadForAspect(3 / 4)).toBeGreaterThan(3);
    expect(cameraLeadForAspect(3 / 4)).toBeLessThan(8.1);
  });
});
