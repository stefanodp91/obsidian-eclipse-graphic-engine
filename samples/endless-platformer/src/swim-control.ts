export interface VerticalSwimState {
  readonly velocityY: number;
  readonly cooldown: number;
}

export interface VerticalSwimInput {
  readonly pressed: boolean;
  readonly held: boolean;
}

export const SWIM_GRAVITY = 3.35;
export const SWIM_TAP_IMPULSE = 1.8;
export const SWIM_HOLD_ACCELERATION = 4.6;
export const SWIM_MAX_RISE_SPEED = 3;
export const SWIM_PRESS_COOLDOWN = 0.2;

/** A tap makes a fine correction; holding adds gradual thrust without exceeding the rise cap. */
export function advanceVerticalSwim(
  state: VerticalSwimState,
  input: VerticalSwimInput,
  dt: number,
): VerticalSwimState {
  let cooldown = Math.max(0, state.cooldown - dt);
  let velocityY = state.velocityY;

  if (input.pressed && cooldown === 0) {
    velocityY = Math.min(SWIM_MAX_RISE_SPEED, velocityY + SWIM_TAP_IMPULSE);
    cooldown = SWIM_PRESS_COOLDOWN;
  }

  if (input.held) {
    velocityY = Math.min(
      SWIM_MAX_RISE_SPEED,
      velocityY + SWIM_HOLD_ACCELERATION * dt,
    );
  }

  velocityY -= SWIM_GRAVITY * dt;
  return { velocityY, cooldown };
}
