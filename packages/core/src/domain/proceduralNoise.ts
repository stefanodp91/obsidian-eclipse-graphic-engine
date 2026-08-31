// Cheap deterministic 3D value-noise (sin-hash + smoothstep) and a variable-octave
// fBm over it. Coordinate-deterministic (no rng), explicit octave count, range
// ~[0,1]. This exact field drives build-time procedural geometry (vertex
// displacement / paint / rib math depend on this distribution) — brand-agnostic
// pure math, no Babylon dependency.

function hash3(x: number, y: number, z: number): number {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
}
function smooth(t: number): number { return t * t * (3 - 2 * t); }

/** 3D value noise (smoothstep-interpolated hash lattice). Range ~[0,1]. */
export function valueNoise3(x: number, y: number, z: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = smooth(xf), v = smooth(yf), w = smooth(zf);
    const c000 = hash3(xi,   yi,   zi),   c100 = hash3(xi+1, yi,   zi);
    const c010 = hash3(xi,   yi+1, zi),   c110 = hash3(xi+1, yi+1, zi);
    const c001 = hash3(xi,   yi,   zi+1), c101 = hash3(xi+1, yi,   zi+1);
    const c011 = hash3(xi,   yi+1, zi+1), c111 = hash3(xi+1, yi+1, zi+1);
    const x00 = c000 + (c100 - c000) * u;
    const x10 = c010 + (c110 - c010) * u;
    const x01 = c001 + (c101 - c001) * u;
    const x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v;
    const y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
}

/** Variable-octave fBm over `valueNoise3`. Range ~[0,1]. */
export function fbm(x: number, y: number, z: number, octaves: number): number {
    let amp = 0.5, freq = 1.0, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum  += valueNoise3(x * freq, y * freq, z * freq) * amp;
        norm += amp;
        amp  *= 0.5; freq *= 2.0;
    }
    return sum / norm;
}
