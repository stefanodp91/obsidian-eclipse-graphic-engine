import { describe, expect, it } from 'vitest';
import { advanceVerticalSwim, SWIM_MAX_RISE_SPEED } from './swim-control';

function simulateHold(holdSeconds: number, totalSeconds: number): { y: number; maxVelocity: number } {
  const dt = 1 / 60;
  let state = { velocityY: 0, cooldown: 0 };
  let y = 0;
  let maxVelocity = 0;

  for (let elapsed = 0; elapsed < totalSeconds; elapsed += dt) {
    state = advanceVerticalSwim(state, {
      pressed: elapsed === 0,
      held: elapsed < holdSeconds,
    }, dt);
    y += state.velocityY * dt;
    maxVelocity = Math.max(maxVelocity, state.velocityY);
  }

  return { y, maxVelocity };
}

describe('vertical swim control', () => {
  it('keeps a quick tap as a fine correction instead of an abrupt leap', () => {
    const result = simulateHold(0.08, 0.9);

    expect(result.y).toBeGreaterThan(0.2);
    expect(result.y).toBeLessThan(0.8);
  });

  it('turns one deliberate half-second hold into a useful but capped ascent', () => {
    const result = simulateHold(0.5, 0.9);

    expect(result.y).toBeGreaterThan(1);
    expect(result.maxVelocity).toBeLessThanOrEqual(SWIM_MAX_RISE_SPEED);
  });
});
