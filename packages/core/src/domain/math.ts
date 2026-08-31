// Pure math utilities. No engine or framework dependencies.

export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function randomInRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

export function toRadians(degrees: number): number {
    return (degrees * Math.PI) / 180;
}

/** Apply a terrain pose (pitch + roll) to a node's Euler rotation, leaving Y
 *  (yaw) untouched so spin/yaw animations remain orthogonal to surface alignment. */
export function applyTerrainPose(
    node: { rotation: { x: number; z: number } },
    tilt: { rotX: number; rotZ: number },
): void {
    node.rotation.x = tilt.rotX;
    node.rotation.z = tilt.rotZ;
}
