// Color helpers: hex → Color3/Color4/CSS conversions + lighten/darken.

import { Color3, Color4 } from '@babylonjs/core';

/** [r, g, b] triplet normalized to [0, 1]. */
export type Rgb01 = readonly [number, number, number];

const BYTE_MAX = 255;

export function hexToRgb01(hex: number): Rgb01 {
    return [
        ((hex >> 16) & 0xFF) / BYTE_MAX,
        ((hex >> 8) & 0xFF) / BYTE_MAX,
        (hex & 0xFF) / BYTE_MAX,
    ];
}

export function hexToColor3(hex: number): Color3 {
    const [r, g, b] = hexToRgb01(hex);
    return new Color3(r, g, b);
}

export function hexToColor4(hex: number, alpha = 1): Color4 {
    const [r, g, b] = hexToRgb01(hex);
    return new Color4(r, g, b, alpha);
}

/** "#rrggbb" string suitable for CSS / canvas fillStyle. */
export function hexToCss(hex: number): string {
    return `#${hex.toString(16).padStart(6, '0')}`;
}

/** Linearly blend `hex` toward white by `amount` in [0, 1]. */
export function lightenHex(hex: number, amount: number): number {
    const r = (hex >> 16) & 0xFF;
    const g = (hex >> 8) & 0xFF;
    const b = hex & 0xFF;
    const lr = Math.round(r + (BYTE_MAX - r) * amount);
    const lg = Math.round(g + (BYTE_MAX - g) * amount);
    const lb = Math.round(b + (BYTE_MAX - b) * amount);
    return (lr << 16) | (lg << 8) | lb;
}

/** Linearly blend `hex` toward black by `amount` in [0, 1]. */
export function darkenHex(hex: number, amount: number): number {
    const r = (hex >> 16) & 0xFF;
    const g = (hex >> 8) & 0xFF;
    const b = hex & 0xFF;
    const lr = Math.round(r * (1 - amount));
    const lg = Math.round(g * (1 - amount));
    const lb = Math.round(b * (1 - amount));
    return (lr << 16) | (lg << 8) | lb;
}

/** Lighten a normalized rgb triplet toward white. */
export function lightenRgb01(rgb: Rgb01, amount: number): Rgb01 {
    return [
        rgb[0] + (1 - rgb[0]) * amount,
        rgb[1] + (1 - rgb[1]) * amount,
        rgb[2] + (1 - rgb[2]) * amount,
    ];
}
