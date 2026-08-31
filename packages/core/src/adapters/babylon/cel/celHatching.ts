// Tratteggio procedurale — il retino da penna che si sovrappone alle bande scure.
//
// È il termine che di solito manca a chi imita Borderlands: con sole bande +
// contorno si ottiene un cel-shading pulito da cartone animato. Il tratteggio è
// ciò che aggiunge il "fatto a mano". Viene campionato in SCREEN SPACE nello
// shader (vedi celHatch in celShading.glsl.ts): il tratto appartiene alla carta,
// non alla superficie, ed è proprio questa incoerenza a farlo leggere come
// disegnato invece che come una texture applicata al modello.

import type { Scene } from '@babylonjs/core';
import { DynamicTexture, Texture } from '@babylonjs/core';

export interface CelHatchSpec {
    /** Numero di tratti per lato della tile. Più alto = retino più fitto. */
    density: number;
    /** Spessore del tratto in pixel di tile. */
    weight: number;
    /** Secondo set di tratti a 90°, cioè il tratteggio incrociato. */
    crossed: boolean;
}

export const DEFAULT_CEL_HATCH: CelHatchSpec = {
    density: 14,
    weight: 2.0,
    crossed: false,
};

/** Tile neutra: bianco pieno = nessun tratteggio. Il sampler nello shader deve
 *  essere SEMPRE legato (un sampler non legato in WebGL è comportamento
 *  indefinito, tipicamente nero), quindi "hatching spento" è questa texture,
 *  non l'assenza di texture. */
export const NO_HATCH: CelHatchSpec = { density: 0, weight: 0, crossed: false };

const HATCH_SIZE = 256;

const hatchCache = new WeakMap<Scene, Map<string, DynamicTexture>>();

function hatchKey(spec: CelHatchSpec): string {
    return `${spec.density}|${spec.weight.toFixed(2)}|${spec.crossed ? 'x' : '-'}`;
}

/** Disegna un set di linee diagonali a 45°, ripetuto oltre i bordi così la tile
 *  combacia con se stessa (il tratteggio è campionato in wrap: una tile non
 *  ciclica produrrebbe una griglia di cuciture visibili a schermo). */
function drawDiagonals(ctx: CanvasRenderingContext2D, spec: CelHatchSpec, mirrored: boolean): void {
    const step = HATCH_SIZE / spec.density;
    ctx.save();
    if (mirrored) {
        ctx.translate(HATCH_SIZE, 0);
        ctx.scale(-1, 1);
    }
    ctx.lineWidth = spec.weight;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#000000';
    // Da -HATCH_SIZE a +2*HATCH_SIZE: le diagonali che escono da un lato devono
    // rientrare dall'altro, altrimenti gli angoli della tile restano vuoti.
    for (let i = -spec.density; i < spec.density * 2; i++) {
        const x = i * step;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + HATCH_SIZE, HATCH_SIZE);
        ctx.stroke();
    }
    ctx.restore();
}

function buildHatch(scene: Scene, spec: CelHatchSpec): DynamicTexture {
    // NIENTE mipmap. Un retino è fatto di linee sottili: appena la tile viene
    // rimpicciolita, il mipmap le media col fondo e il tratteggio sbianca fino
    // a sparire — sembra che l'intensità non funzioni, e invece è la texture che
    // si è già dissolta prima di arrivare allo shader. Il retino va usato a
    // scala ~1:1 (vedi il default di `hatchScale`), dove i mipmap non servono.
    const dt = new DynamicTexture(
        `cel-hatch-${spec.density}`,
        { width: HATCH_SIZE, height: HATCH_SIZE },
        scene,
        false,
    );
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, HATCH_SIZE, HATCH_SIZE);

    if (spec.density > 0 && spec.weight > 0) {
        drawDiagonals(ctx, spec, false);
        if (spec.crossed) drawDiagonals(ctx, spec, true);
    }

    dt.update(false);
    dt.wrapU = Texture.WRAP_ADDRESSMODE;
    dt.wrapV = Texture.WRAP_ADDRESSMODE;
    // Maschera di copertura, non colore: nessuna decodifica gamma.
    dt.gammaSpace = false;
    return dt;
}

// Corsia veloce identica a quella di `getCelRamp`, e per lo stesso motivo: questa
// funzione sta nel `bindForSubMesh` del plugin cel, cioè una chiamata per submesh
// per frame. Vedi il commento esteso in celRamp.ts per il ragionamento completo.
let lastHatchScene: Scene | null = null;
let lastHatchSpec: CelHatchSpec | null = null;
let lastHatchTex: DynamicTexture | null = null;

export function getCelHatch(scene: Scene, spec: CelHatchSpec = DEFAULT_CEL_HATCH): DynamicTexture {
    if (lastHatchTex && lastHatchScene === scene && lastHatchSpec === spec) return lastHatchTex;

    let m = hatchCache.get(scene);
    if (!m) { m = new Map(); hatchCache.set(scene, m); }
    const key = hatchKey(spec);
    let tex = m.get(key);
    if (!tex) {
        tex = buildHatch(scene, spec);
        m.set(key, tex);
    }
    lastHatchScene = scene;
    lastHatchSpec = spec;
    lastHatchTex = tex;
    return tex;
}

export function disposeCelHatches(scene: Scene): void {
    if (lastHatchScene === scene) {
        lastHatchScene = null;
        lastHatchSpec = null;
        lastHatchTex = null;
    }
    const m = hatchCache.get(scene);
    if (!m) return;
    for (const tex of m.values()) tex.dispose();
    hatchCache.delete(scene);
}
