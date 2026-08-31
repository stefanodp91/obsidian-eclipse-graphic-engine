import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./game.ts', import.meta.url), 'utf8');

describe('underwater light effects', () => {
  it('uses world-space soft particles instead of camera-locked luminous boxes', () => {
    expect(source).not.toContain("CreateBox(`volumetric-sunshaft-");
    expect(source).not.toContain('beam.position.x = camera.position.x');
    expect(source).toContain('new ParticleSystem(');
    expect(source).toContain('isLocal = false');
  });
});
