// Ramp texture procedurale: la lookup 1-D che trasforma NdotL in una BANDA.
//
// Tutta l'art-direction dello shading cel vive qui dentro. Il numero di gradini,
// la loro durezza e — soprattutto — la TINTA dell'ombra sono i tre assi che
// separano un cel-shading credibile da uno di plastica. Averli in una texture
// invece che in costanti nello shader significa poterli tarare a runtime senza
// una ricompilazione: è il presupposto del lab a colonne.
//
// Stesso pattern di `buildDecorMatcap` in MaterialLibrary.ts: DynamicTexture
// disegnata su canvas 2D, cache per-Scene, una sola istanza per combinazione di
// parametri.

import type { Scene } from '@babylonjs/core';
import { Color3, DynamicTexture, Texture } from '@babylonjs/core';

export interface CelRampSpec {
    /** Numero di gradini. 0 = rampa continua (il riferimento "non-cel" del lab). */
    bands: number;
    /** Colore moltiplicativo nel gradino più in ombra. */
    shadow: Color3;
    /** Colore moltiplicativo nel gradino più in luce. Tipicamente bianco. */
    light: Color3;
    /** Ampiezza della transizione fra gradini, in frazione di banda (0..1).
     *  0 = stacco netto. Sopra ~0.35 le bande si fondono e il look si perde. */
    softness: number;
}

export const DEFAULT_CEL_RAMP: CelRampSpec = {
    bands: 3,
    // Ombra fredda e leggermente satura, non grigia: è la scelta che fa leggere
    // il volume come "dipinto" invece che come diffuse abbassato.
    shadow: new Color3(0.34, 0.36, 0.48),
    light: Color3.White(),
    softness: 0.06,
};

const RAMP_WIDTH = 256;

const rampCache = new WeakMap<Scene, Map<string, DynamicTexture>>();

function rampKey(spec: CelRampSpec): string {
    const c = (col: Color3): string => `${col.r.toFixed(3)},${col.g.toFixed(3)},${col.b.toFixed(3)}`;
    return `${spec.bands}|${spec.softness.toFixed(3)}|${c(spec.shadow)}|${c(spec.light)}`;
}

function css(col: Color3): string {
    const to255 = (v: number): number => Math.round(Math.min(Math.max(v, 0), 1) * 255);
    return `rgb(${to255(col.r)},${to255(col.g)},${to255(col.b)})`;
}

/** Valore quantizzato del gradino i (0..bands-1) sull'asse 0..1. */
function stepValue(i: number, bands: number): number {
    return bands <= 1 ? 1 : i / (bands - 1);
}

function buildRamp(scene: Scene, spec: CelRampSpec): DynamicTexture {
    const dt = new DynamicTexture(
        `cel-ramp-${spec.bands}`,
        { width: RAMP_WIDTH, height: 1 },
        scene,
        false,
    );
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;

    if (spec.bands <= 1) {
        // Rampa continua: il termine di paragone "senza cel" del lab. Serve
        // averlo nella STESSA pipeline (stesso materiale, stesso fog, stesso
        // grade) o il confronto misura le differenze di pipeline, non di look.
        const grad = ctx.createLinearGradient(0, 0, RAMP_WIDTH, 0);
        grad.addColorStop(0, css(spec.shadow));
        grad.addColorStop(1, css(spec.light));
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, RAMP_WIDTH, 1);
    } else {
        const bandPx = RAMP_WIDTH / spec.bands;
        const softPx = Math.min(spec.softness, 0.49) * bandPx;
        for (let i = 0; i < spec.bands; i++) {
            const t = stepValue(i, spec.bands);
            const col = Color3.Lerp(spec.shadow, spec.light, t);
            const x0 = i * bandPx;
            if (softPx <= 0.5 || i === 0) {
                ctx.fillStyle = css(col);
                ctx.fillRect(x0, 0, bandPx + 1, 1);
                continue;
            }
            // Transizione morbida sul BORDO SINISTRO del gradino: parte dal
            // colore del gradino precedente e arriva al proprio. Un gradiente
            // simmetrico a cavallo del confine sposterebbe il centro di ogni
            // banda, e con 2-3 bande lo spostamento si vede.
            const prev = Color3.Lerp(spec.shadow, spec.light, stepValue(i - 1, spec.bands));
            const grad = ctx.createLinearGradient(x0 - softPx, 0, x0 + softPx, 0);
            grad.addColorStop(0, css(prev));
            grad.addColorStop(1, css(col));
            ctx.fillStyle = grad;
            ctx.fillRect(x0 - softPx, 0, softPx * 2, 1);
            ctx.fillStyle = css(col);
            ctx.fillRect(x0 + softPx, 0, bandPx - softPx + 1, 1);
        }
    }

    dt.update(false);
    dt.wrapU = Texture.CLAMP_ADDRESSMODE;
    dt.wrapV = Texture.CLAMP_ADDRESSMODE;
    // La ramp codifica un MOLTIPLICATORE di luce, non un colore da schermo:
    // va campionata così com'è stata scritta, senza decodifica gamma. Stessa
    // ragione per cui il matcap del decor è gammaSpace=false.
    dt.gammaSpace = false;
    dt.anisotropicFilteringLevel = 1;
    return dt;
}

// ── Corsia veloce per il percorso caldo ──────────────────────────────────────
//
// `getCelRamp` viene chiamata dal `bindForSubMesh` del plugin cel, cioè UNA VOLTA
// PER SUBMESH PER FRAME. Costruire la chiave lì significa sei `toFixed(3)` e
// altrettante concatenazioni a ogni draw call: con ~150 draw call a 60 fps sono
// decine di migliaia di stringhe temporanee al secondo, buttate addosso al GC su
// un frame che su A25 è già main-thread-bound. Il costo non stava nella cache —
// che è O(1) e centrava sempre — ma nel CALCOLARE la chiave per interrogarla.
//
// Lo spec arriva da `configureCelPlugin`, che lo SOSTITUISCE invece di mutarlo:
// l'identità dell'oggetto è quindi un test valido, e costa zero allocazioni.
// Fallisce solo verso il lento (una tarature nuova ricalcola la chiave una volta),
// mai verso lo sbagliato.
//
// ⚠️ Corollario del contratto: chi muta uno spec SUL POSTO non vedrà la ramp
// cambiare. La via supportata è passare un oggetto nuovo, come fa il gioco.
let lastRampScene: Scene | null = null;
let lastRampSpec: CelRampSpec | null = null;
let lastRampTex: DynamicTexture | null = null;

/** Ramp condivisa per-Scene: una sola texture per combinazione di parametri. */
export function getCelRamp(scene: Scene, spec: CelRampSpec = DEFAULT_CEL_RAMP): DynamicTexture {
    if (lastRampTex && lastRampScene === scene && lastRampSpec === spec) return lastRampTex;

    let m = rampCache.get(scene);
    if (!m) { m = new Map(); rampCache.set(scene, m); }
    const key = rampKey(spec);
    let tex = m.get(key);
    if (!tex) {
        tex = buildRamp(scene, spec);
        m.set(key, tex);
    }
    lastRampScene = scene;
    lastRampSpec = spec;
    lastRampTex = tex;
    return tex;
}

export function disposeCelRamps(scene: Scene): void {
    // La corsia veloce va invalidata PRIMA di distruggere le texture, o il
    // prossimo bind restituirebbe una texture disposta — che non dà un errore,
    // dà nero.
    if (lastRampScene === scene) {
        lastRampScene = null;
        lastRampSpec = null;
        lastRampTex = null;
    }
    const m = rampCache.get(scene);
    if (!m) return;
    for (const tex of m.values()) tex.dispose();
    rampCache.delete(scene);
}
