// Contorno — candidato A: edge detection in post-process.
//
// Un solo pass fullscreen legge il G-buffer (profondità + normali) e disegna una
// linea dove una delle due ha una discontinuità. Non tocca la geometria: vale
// per le mesh normali, per le istanze e per le mesh unite allo stesso modo, e
// non aggiunge una singola draw call.
//
// Il tratto risulta di spessore COSTANTE in pixel, indipendente dalla distanza.
// È una scelta estetica, non un limite: gli oggetti lontani mantengono un
// contorno leggibile invece di vederlo assottigliare fino a sparire. Il
// candidato B (guscio invertito) fa l'opposto. Servono affiancati per decidere.
//
// Cosa questo candidato NON può fare: disegnare una linea dove non c'è
// discontinuità di profondità o normale — cioè i dettagli interni disegnati su
// una superficie continua. Quelli restano compito del rim d'inchiostro
// (celInkRim) o della texture.

import type { AbstractMesh, Camera, Nullable, Scene, Texture } from '@babylonjs/core';
import {
    Color3, Effect, GeometryBufferRenderer, Mesh, PostProcess, Vector2,
} from '@babylonjs/core';
// ⚠️ IMPORT PER SIDE-EFFECT, e senza di lui il guscio non esiste.
//
// `renderOutline` / `outlineWidth` / `outlineColor` NON sono proprietà native di
// `AbstractMesh`: gliele attacca questo modulo, insieme al renderer che le
// disegna. Il gioco importa Babylon à la carte, quindi senza questa riga
// `mesh.renderOutline` è `undefined` — non `false` — e scriverci sopra non fa
// nulla e non dà errore.
//
// Costa un'ora scoprirlo dal difetto: il contorno a guscio sembrava GRATIS
// (54 fps contro 33 del post-process) e invece non veniva disegnato affatto.
// Il segnale che ha smascherato il finto guadagno sono state le draw call —
// identiche a quelle senza contorno, mentre un guscio ne aggiunge una per
// oggetto. Quando un'ottimizzazione sembra gratis, si conta.
import '@babylonjs/core/Rendering/outlineRenderer';
import { bakeCelHullIntoMesh, isCelHullBaked } from './celHull';

export interface CelOutlineOptions {
    color: Color3;
    /** Raggio del kernel in pixel. Sopra ~2 il tratto si sdoppia sui bordi
     *  ravvicinati (il kernel campiona oltre la silhouette successiva). */
    thickness: number;
    /** Sensibilità alla discontinuità di PROFONDITÀ, come frazione della
     *  profondità del pixel. Scalata così perché la precisione del buffer cala
     *  con la distanza e una soglia assoluta produrrebbe rumore in fondo. */
    depthThreshold: number;
    /** Sensibilità alla discontinuità di NORMALE — è il termine che trova gli
     *  spigoli interni (dove la profondità è continua ma la superficie piega). */
    normalThreshold: number;
    /** Distanza IN METRI oltre la quale il contorno svanisce; la dissolvenza
     *  parte al 60% di questo valore. 0 = mai.
     *
     *  L'unità è metri e non una profondità normalizzata perché il G-buffer di
     *  Babylon scrive la z in spazio VISTA, cioè già in unità di mondo. Con la
     *  lettura sbagliata (0..1) un valore plausibile come 0.16 spegne il
     *  contorno sull'intera scena, e sembra che la dissolvenza non funzioni. */
    fadeDistance: number;
    /** Vista diagnostica dei buffer sorgente. Un edge-detect che non disegna
     *  ha sempre almeno tre cause possibili (buffer vuoto, codifica diversa da
     *  quella attesa, soglia sbagliata) e a occhio sono indistinguibili: questa
     *  è la leva che le separa in un colpo invece che per tentativi. */
    debug: CelOutlineDebug;
    /** Se vero, il G-buffer disegna SOLO le mesh dichiarate protagoniste
     *  (`markCelOutlineEssential`) invece dell'intera scena.
     *
     *  Toglie draw call — misurato su A25 mid, 157 → 95 — ma ne compra pochi
     *  fps: 33.2 → 36.5. Il grosso del costo del contorno NON è la submission
     *  della seconda passata; v. la nota su `gBufferRatio`, che è la leva vera.
     *
     *  Resta utile in combinazione, e per una ragione che non è la velocità: la
     *  lista ridotta è anche una scelta di DISEGNO — il tratto sulle
     *  protagoniste e non sul fondale è una gerarchia, non solo un risparmio.
     *
     *  Il prezzo è visivo e va detto: lo scenario perde il tratto sulle proprie
     *  silhouette. Gli resta il rim d'inchiostro che il materiale disegna da sé
     *  sulle curve, che è un meccanismo diverso e complementare. */
    essentialOnly: boolean;
    /** Frazione della risoluzione dello schermo a cui il G-buffer viene
     *  disegnato. 1 = piena.
     *
     *  ⚠️ Sembra la leva ovvia e NON lo è: misurato su A25 mid, portarlo a 0.5
     *  compra 1.2 fps su un divario di 20. Scriverlo qui perché è esattamente
     *  il genere di ottimizzazione che si rifà due volte — la seconda con la
     *  stessa convinzione della prima. Il costo sta nel pass fullscreen
     *  (v. `postProcessRatio`), non nella sorgente che legge.
     *
     *  Il prezzo è la NITIDEZZA del tratto: il contorno esce dall'edge-detect
     *  su questi buffer, quindi a mezza risoluzione la linea si ingrossa e si
     *  scalinetta sulle diagonali. Va guardato, non dedotto. */
    gBufferRatio: number;
    /** Frazione della risoluzione a cui gira il PASS FULLSCREEN dell'edge-detect.
     *
     *  ⚠️ Dopo aver escluso le altre due, è qui che sta il costo. Misurato su
     *  A25 mid, quattro varianti appaiate a parità di vertici:
     *
     *    contorno pieno                    32.8 fps · DC 158
     *    lista ridotta (−62 draw call)     36.5 fps        → +3.3
     *    G-buffer a metà risoluzione       34.0 fps        → +1.2
     *    contorno spento                   53.2 fps · DC  82  → +20
     *
     *  Le due leve «ovvie» insieme comprano 4 fps su 20. Il resto è questo
     *  pass: gira a risoluzione piena e fa NOVE letture di texture per pixel
     *  (cinque di profondità, quattro di normali) su ~1.8 milioni di pixel, cioè
     *  ~16 milioni di campionamenti per frame su una Mali-G68.
     *
     *  Il prezzo è la nitidezza del tratto, ed è più visibile che sul
     *  `gBufferRatio`: qui si abbassa la risoluzione del DISEGNO, non quella
     *  della sorgente. Va guardato a schermo prima di spedirlo. */
    postProcessRatio: number;
    /** Sorgente a SOLA PROFONDITÀ invece del G-buffer depth+normali.
     *
     *  Il `GeometryBufferRenderer` è un multi-render-target: scrive due texture
     *  a schermo pieno per frame. Il `DepthRenderer` ne scrive una. Se il costo
     *  che le altre leve non spiegano è l'MRT in sé — allocazione, clear e
     *  writeback di due bersagli — questa lo dimezza.
     *
     *  Il prezzo è il TERMINE NORMALI, cioè gli spigoli interni: restano le
     *  silhouette e le discontinuità di profondità, si perdono le pieghe su
     *  superficie continua. Sotto cel non è poco — ma il rim d'inchiostro del
     *  materiale copre in parte lo stesso mestiere, e su una geometria fatta di
     *  facce piatte molte pieghe sono anche salti di profondità. */
    depthOnly: boolean;
}

export type CelOutlineDebug = 'off' | 'depth' | 'normal' | 'edge';

const DEBUG_CODE: Record<CelOutlineDebug, number> = { off: 0, depth: 1, normal: 2, edge: 3 };

export const DEFAULT_CEL_OUTLINE: CelOutlineOptions = {
    color: new Color3(0.04, 0.03, 0.06),
    thickness: 1.0,
    depthThreshold: 0.020,
    normalThreshold: 0.35,
    fadeDistance: 0,
    debug: 'off',
    gBufferRatio: 1,
    postProcessRatio: 1,
    depthOnly: false,
    // Di serie il contorno vale per TUTTA la scena: è il comportamento con cui
    // il look è stato giudicato, e restringerlo è una scelta che il chiamante
    // deve dichiarare.
    essentialOnly: false,
};

const SHADER_NAME = 'celOutline';

const OUTLINE_FRAGMENT = /* glsl */ `
precision highp float;

varying vec2 vUV;

uniform sampler2D textureSampler;
uniform sampler2D depthSampler;
uniform sampler2D normalSampler;

uniform vec2  texelSize;
uniform vec3  outlineColor;
uniform float thickness;
uniform float depthThreshold;
uniform float normalThreshold;
uniform float fadeDistance;
uniform float debugView;

// VINCOLO WEBGPU — tutti i campionamenti stanno in cima, PRIMA di qualsiasi
// ramo. WGSL pretende che textureSample sia chiamata in control flow uniforme
// (gli servono le derivate del quad); un return anticipato sul cielo, o un
// campionamento dentro un if, fanno fallire la compilazione con «must only be
// called from uniform control flow». In WebGL2 lo stesso codice compilerebbe.
// Quindi: si campiona sempre tutto, e le condizioni diventano moltiplicazioni.
void main(void) {
    vec3 scene = texture2D(textureSampler, vUV).rgb;

    vec2 o = texelSize * thickness;
    // Croce di Roberts sulle diagonali: quattro campioni invece degli otto di
    // Sobel. Su un contorno binario la differenza non si vede, e questo pass
    // gira a piena risoluzione.
    vec2 uvA = vUV + vec2(-o.x, -o.y);
    vec2 uvB = vUV + vec2( o.x,  o.y);
    vec2 uvC = vUV + vec2(-o.x,  o.y);
    vec2 uvD = vUV + vec2( o.x, -o.y);

    float dC = texture2D(depthSampler, vUV).r;
    float dA = texture2D(depthSampler, uvA).r;
    float dB = texture2D(depthSampler, uvB).r;
    float dCc = texture2D(depthSampler, uvC).r;
    float dD = texture2D(depthSampler, uvD).r;

    vec3 nA = texture2D(normalSampler, uvA).rgb;
    vec3 nB = texture2D(normalSampler, uvB).rgb;
    vec3 nC = texture2D(normalSampler, uvC).rgb;
    vec3 nD = texture2D(normalSampler, uvD).rgb;

    // Test sulla CURVATURA della profondità, non sulla sua pendenza.
    //
    // Confrontare due campioni opposti (|dA - dB|) sembra la cosa ovvia e non
    // funziona: su una superficie vista di taglio — un terreno che corre verso
    // l'orizzonte — la profondità cambia moltissimo da un pixel al successivo
    // pur non essendoci alcun bordo, e l'intera lontananza si tinge di nero.
    //
    // La media dei due opposti confrontata col centro annulla invece qualunque
    // variazione LINEARE: un piano, per quanto radente, dà risposta zero.
    // Restano solo le discontinuità vere — sagome e pieghe.
    float depthEdge = max(
        abs((dA + dB) * 0.5 - dC),
        abs((dCc + dD) * 0.5 - dC)
    );
    // Soglia proporzionale alla profondità: la precisione del buffer cala con la
    // distanza, e una soglia fissa farebbe comparire rumore in fondo alla scena.
    float depthHit = step(depthThreshold * dC, depthEdge);

    float normalEdge = max(1.0 - dot(nA, nB), 1.0 - dot(nC, nD));
    float normalHit = step(normalThreshold, normalEdge);

    float edge = max(depthHit, normalHit);

    // Cielo/sfondo: il G-buffer resta a 0 dove non è stato scritto nulla. Senza
    // questo azzeramento l'orizzonte diventerebbe una linea nera continua.
    edge *= step(1e-6, dC);

    // fadeDistance == 0 significa "mai": lo smoothstep va neutralizzato senza
    // un ramo, o si ricade nel problema di control flow qui sopra.
    float fadeOn = step(1e-6, fadeDistance);
    float fade = 1.0 - smoothstep(fadeDistance * 0.6, max(fadeDistance, 1e-6), dC);
    edge *= mix(1.0, fade, fadeOn);

    vec3 result = mix(scene, outlineColor, edge);

    // Viste diagnostiche. La profondità è amplificata perché il buffer, se è
    // normalizzato sul far plane, vive tutto nei primi centesimi dell'intervallo
    // e senza scala legge come nero pieno — che è indistinguibile da un buffer
    // non scritto, cioè proprio l'ambiguità che questa vista deve risolvere.
    if (debugView > 2.5)      result = vec3(edge);
    else if (debugView > 1.5) result = nA * 0.5 + 0.5;
    else if (debugView > 0.5) result = vec3(fract(dC * 10.0), dC, dC * 100.0);

    gl_FragColor = vec4(result, 1.0);
}
`;

Effect.ShadersStore[`${SHADER_NAME}PixelShader`] = OUTLINE_FRAGMENT;

/** Mesh che NON devono comparire nel G-buffer del contorno.
 *
 *  Serve per gli elementi la cui SAGOMA non corrisponde a quello che si vede:
 *  billboard, aloni, piani di riflesso. Sono l'eccezione, non la regola — il
 *  contorno esiste per disegnare le forme, e toglierlo a una forma vera la
 *  rende invisibile invece che discreta. */
const outlineExcluded = new WeakSet<object>();

/** Tiene una mesh fuori dal contorno a inchiostro. */
export function excludeFromCelOutline(mesh: object): void {
    outlineExcluded.add(mesh);
}

/** Le mesh PROTAGONISTE: quelle che il contorno disegna anche quando il
 *  G-buffer smette di disegnare tutto il resto (v. `essentialOnly`).
 *
 *  ⚠️ Marcatura in POSITIVO e a carico del gioco, non un'euristica del motore.
 *  Il motore è agnostico di marca e non sa che cos'è un ostacolo: se provasse a
 *  indovinare — per taglia, per distanza, per nome — sbaglierebbe in silenzio al
 *  primo modello nuovo, e il difetto sarebbe «a volte un oggetto non ha il
 *  contorno», che è la classe di bug più cara da inseguire. */
const outlineEssential = new WeakSet<object>();

// ── Modo GUSCIO: il contorno nella mesh invece che nel fotogramma ───────────
//
// Il post-process disegna il tratto leggendo profondità e normali di TUTTA la
// scena, e su A25 quella seconda passata costa ~20 fps che non si riducono
// (cinque leve provate, la migliore ne compra 3.7 — v. le note sui campi qui
// sopra). Il guscio invertito fa lo stesso mestiere con un meccanismo opposto:
// una copia della mesh gonfiata lungo le normali e con le facce anteriori
// scartate, cioè UNA DRAW CALL IN PIÙ PER OGGETTO e nessuna passata di scena,
// nessun render target, nessun multi-render-target.
//
// Qui si usa `renderOutline` di Babylon e non `celHull.ts` di proposito: è la
// stessa tecnica, e per MISURARE il costo va benissimo. `celHull` esiste perché
// tiene colore e spessore su un materiale condiviso invece che su ogni mesh —
// che conta quando lo spessore è l'asse da tarare, non quando la domanda è
// «quanto costa».
//
// ⚠️ Il difetto noto è di FORMA, non di velocità: il guscio si strappa sugli
// spigoli duri, dove le normali per faccia divergono e la copia gonfiata si
// apre. La geometria cel è fatta di spigoli duri. Va guardato a schermo.
let hullMode = false;
let hullWidth = 0.035;
let hullColor: Color3 = new Color3(0.04, 0.03, 0.06);
/** Sotto questa DIAGONALE (in metri) una mesh non riceve il guscio. 0 = tutte.
 *
 *  La taglia è il discrimine giusto per due ragioni insieme: le sagome grandi
 *  sono quelle che fanno la silhouette del fotogramma (perderle si vede,
 *  perdere un ciuffo no), e sono anche quelle su cui il guscio NON sgrana — lo
 *  strappo sugli spigoli è tanto più visibile quanto più il pezzo è piccolo e
 *  fitto. Le protagoniste (`outlineEssential`) passano SEMPRE, a qualunque
 *  taglia: una bolla da raccogliere è piccola ma senza tratto sparisce. */
let hullMinDiagonal = 0;

/** Sopra questo numero di ISTANZE THIN una mesh non riceve il guscio cotto.
 *  Il costo del cotto è il raddoppio dei vertici MOLTIPLICATO per le istanze:
 *  una specie istanziata in massa (×123, ×116 in una scena misurata) paga il guscio cento volte,
 *  per un tratto che su esemplari fitti e ripetuti legge molto meno di quanto
 *  costa. Le protagoniste passano comunque. Infinity = nessun tetto. */
let hullMaxThinInstances = Number.POSITIVE_INFINITY;

/** Applica (o toglie) il guscio a una mesh, se è una mesh che può averlo.
 *
 *  ⚠️ Il test è `'renderOutline' in mesh` e NON `typeof … === 'boolean'`.
 *  Babylon definisce la proprietà su `Mesh.prototype` con un getter che torna
 *  `this._renderOutline`, e quel campo NASCE `undefined`: una mesh a cui nessuno
 *  ha ancora scritto il contorno risponde `undefined`, non `false`. La guardia
 *  sbagliata scartava ogni mesh in silenzio, e il risultato era un contorno che
 *  non si accendeva mai su nessuno mentre tutto sembrava a posto.
 *
 *  Sulle ISTANZE non si scrive: `renderOutline` sta su `Mesh`, non su
 *  `AbstractMesh`. Non serve — l'outline renderer di Babylon disegna il guscio
 *  del MASTER insieme al suo batch di istanze, quindi marcare il master le
 *  copre tutte. */
function applyHull(mesh: object, on: boolean): void {
    if (!('renderOutline' in mesh)) return;
    const m = mesh as { renderOutline?: boolean; outlineWidth?: number; outlineColor?: Color3 };
    m.outlineWidth = hullWidth;
    m.outlineColor = hullColor;
    m.renderOutline = on;
}

/** Osservatore che veste le protagoniste che nascono DOPO l'accensione. */
let hullObserver: { remove(): void } | null = null;

/** Il ripasso per-frame del modo COTTO (v. sotto). Va tenuto per poterlo
 *  rimuovere: la prima stesura lo aggiungeva e basta, e ogni rimontaggio della
 *  pipeline (cambio mondo, cambio qualità) ne accumulava uno in più — ognuno
 *  un giro su `scene.meshes` a ogni frame, su un mondo già CPU-bound. */
let hullBakeSweep: { remove(): void } | null = null;

/**
 * Accende il contorno a guscio sulle mesh protagoniste.
 *
 * ⚠️ Vale sia per quelle già nate sia per quelle che nasceranno, e non è un
 * lusso: la prima stesura si limitava ad applicarlo al momento della marcatura,
 * e siccome i pool e i tile di terreno marcano le loro mesh PRIMA che la
 * pipeline di post-processing venga montata, il risultato era ZERO mesh col
 * guscio — con un guadagno di venti fps che sembrava la soluzione e invece era
 * semplicemente l'assenza del contorno. Misurato, non supposto: `renderOutline`
 * vero su 0 mesh di 729.
 */
/** Il guscio in modo COTTO: la geometria del bordo si appende alla mesh invece
 *  di accendere `renderOutline`. Zero draw call in più — v. la nota in
 *  `bakeCelHullIntoMesh` per le misure che motivano l'esistenza di un terzo
 *  modo. La cottura è irreversibile a runtime: si spegne solo ricaricando. */
let hullBaked = false;

export function setCelOutlineHullMode(
    scene: Scene, on: boolean, width = 0.035, color?: Color3, minDiagonal = 0,
    baked = false, maxThinInstances = Number.POSITIVE_INFINITY,
): void {
    hullMode = on;
    hullBaked = baked;
    hullWidth = width;
    hullMinDiagonal = minDiagonal;
    hullMaxThinInstances = maxThinInstances;
    if (color) hullColor = color;

    hullObserver?.remove();
    hullObserver = null;
    hullBakeSweep?.remove();
    hullBakeSweep = null;

    // ⚠️ Il guscio veste TUTTO ciò che non è escluso, non le sole protagoniste.
    //
    // La prima stesura si fermava alle protagoniste e il risultato, visto a
    // schermo, era che lo SCENARIO perdeva il tratto: fiori, massi, giganti e
    // fondale diventavano macchie piatte accanto a ostacoli bordati. Il
    // contorno non è una decorazione degli oggetti importanti — è ciò che tiene
    // insieme il linguaggio, e a metà legge come un difetto di rendering.
    //
    // La regola è quindi la STESSA del post-process (`!outlineExcluded`), così
    // le due tecniche disegnano lo stesso insieme e sono confrontabili: chi non
    // vuole il tratto lo dichiara mesh per mesh, in un posto solo, e vale per
    // entrambe.
    const wants = (mesh: AbstractMesh): boolean => {
        if (outlineExcluded.has(mesh)) return false;
        if (hullMinDiagonal <= 0 || isEssential(mesh)) return true;
        const bb = mesh.getBoundingInfo().boundingBox;
        const dx = bb.maximum.x - bb.minimum.x;
        const dy = bb.maximum.y - bb.minimum.y;
        const dz = bb.maximum.z - bb.minimum.z;
        return dx * dx + dy * dy + dz * dz >= hullMinDiagonal * hullMinDiagonal;
    };

    const dress = (mesh: AbstractMesh, enable: boolean): void => {
        if (!hullBaked) { applyHull(mesh, enable); return; }
        if (!enable) return;
        // ⚠️ La cottura NON può avvenire alla nascita della mesh: `new Mesh()`
        // la aggiunge alla scena PRIMA che `applyToMesh` le dia i vertici, e
        // una cottura su geometria vuota è un no-op silenzioso. Si coce al
        // primo frame in cui la geometria c'è — il ritardo è invisibile (la
        // mesh nasce fuori campo, nel prewarm o oltre la nebbia).
        if (mesh instanceof Mesh && mesh.getTotalVertices() > 0) {
            // Già cotta = non toccarla più: senza questa uscita, al giro dopo
            // la cottura risponde false («già fatta») e una protagonista cotta
            // riceverebbe ANCHE il guscio per-mesh — contorno doppio e una
            // draw call regalata, per mesh, per sempre.
            if (isCelHullBaked(mesh)) return;
            // Specie di MASSA: sopra il tetto di istanze thin il guscio non
            // si cuoce (v. `hullMaxThinInstances`). Salto senza memoizzare:
            // il conteggio può crescere dopo, e un rifiuto permanente qui
            // sarebbe deciso su un numero non ancora vero.
            if (mesh.thinInstanceCount > hullMaxThinInstances && !isEssential(mesh)) return;
            const baked = bakeCelHullIntoMesh(mesh, hullWidth, hullColor);
            // Le PROTAGONISTE che la cottura rifiuta (materiale non-Standard —
            // una skin PBR su tutte) tengono il guscio per-mesh: è
            // una draw call l'una, e sono una manciata. Solo le protagoniste:
            // per lo scenario che non si può cuocere il tratto lo fa il rim.
            if (!baked && isEssential(mesh) && !noHullFallback.has(mesh)) applyHull(mesh, true);
        }
    };

    for (const mesh of scene.meshes) {
        if (wants(mesh)) dress(mesh, on);
    }
    if (!on) return;
    hullObserver = scene.onNewMeshAddedObservable.add((mesh) => {
        if (wants(mesh)) dress(mesh, true);
    });
    if (hullBaked) {
        // Ripasso a ogni frame per le mesh nate vuote (v. sopra): il predicato
        // e i WeakSet (cotte + rifiutate) rendono il giro un lookup per mesh.
        const obs = scene.onBeforeRenderObservable.add(() => {
            for (const mesh of scene.meshes) {
                if (wants(mesh)) dress(mesh, true);
            }
        });
        hullBakeSweep = { remove: () => scene.onBeforeRenderObservable.remove(obs) };
    }
}

/** Dichiara una mesh protagonista del contorno. */
export function markCelOutlineEssential(mesh: object): void {
    outlineEssential.add(mesh);
}

/** Protagoniste che NON devono ricadere sul guscio `renderOutline` quando la
 *  cottura le rifiuta. Nel modo cotto ogni fallback è una draw call vera (la
 *  mesh si disegna due volte), e sono le draw call — non i vertici — la valuta
 *  scarsa su A25 (~0.13 fps l'una). I tile di terreno sono il caso tipico:
 *  essenziali per la lista del G-buffer, ma il loro bordo lo disegnano già i
 *  props sul giunto — otto draw call per un tratto che c'è già. */
const noHullFallback = new WeakSet<object>();

/** Esclude una protagonista dal fallback `renderOutline` del modo cotto
 *  (resta nel G-buffer del post-process, dove non costa per-mesh). */
export function markCelOutlineNoHullFallback(mesh: object): void {
    noHullFallback.add(mesh);
}

/** Una mesh è protagonista se lo è lei o il master da cui è istanziata: le
 *  istanze sono oggetti a sé e non ereditano nulla dal proprio master — è la
 *  stessa trappola già pagata sui `metadata` dei props. */
function isEssential(mesh: AbstractMesh): boolean {
    if (outlineEssential.has(mesh)) return true;
    const src = (mesh as { sourceMesh?: object }).sourceMesh;
    return src !== undefined && outlineEssential.has(src);
}

export interface CelOutlineHandle {
    readonly postProcess: PostProcess;
    apply(patch: Partial<CelOutlineOptions>): void;
    readonly options: Readonly<CelOutlineOptions>;
    dispose(): void;
}

/** Attacca il contorno post-process alla camera. Ritorna null se il G-buffer
 *  non è disponibile: meglio nessun contorno che un pass che campiona texture
 *  inesistenti e tinge lo schermo di nero. */
export function attachCelOutline(
    scene: Scene,
    camera: Camera,
    overrides: Partial<CelOutlineOptions> = {},
): Nullable<CelOutlineHandle> {
    const opts: CelOutlineOptions = { ...DEFAULT_CEL_OUTLINE, ...overrides };

    // ── Sorgente: G-buffer (depth+normali) o solo profondità ────────────────
    const depthRenderer = opts.depthOnly
        // `storeCameraSpaceZ` = profondità in METRI di spazio vista, cioè la
        // stessa unità che scrive il G-buffer. Senza, le soglie tarate su
        // `fadeDistance` in metri agirebbero su un intervallo diverso e il
        // contorno cambierebbe carattere senza che nessun parametro sia stato
        // toccato — v. la nota su `fadeDistance`.
        ? scene.enableDepthRenderer(camera, false, false, undefined, true)
        : null;

    const gbr = opts.depthOnly ? null : scene.enableGeometryBufferRenderer(opts.gBufferRatio);
    if (!opts.depthOnly && !gbr) return null;
    // World-space normals remain stable while the camera moves. View-space
    // normals would make internal outlines flicker on nearly tangent surfaces.
    if (gbr) gbr.generateNormalsInWorldSpace = true;
    // ⚠️ Esclusione MIRATA, non per categoria.
    //
    // Il primo tentativo tolse dal G-buffer TUTTE le superfici trasparenti, per
    // liberarsi di un caso solo: il quad BILLBOARD del riflesso della bolla,
    // che essendo sempre rivolto alla camera ha per sagoma un rettangolo — e il
    // contorno gli disegnava attorno un riquadro d'inchiostro, per tutta la
    // partita.
    //
    // Il rimedio era troppo largo e ha portato via con sé il contorno delle
    // PICKUP TRASLUCIDI, che sono trasparenti anche loro: senza tratto, una
    // sfera translucida e pallida su una pista di sabbia chiara diventa
    // invisibile. Sparivano dal gioco senza che nulla, nel codice dei
    // collezionabili, potesse spiegarlo.
    //
    // Quindi le trasparenti restano dentro — il contorno è ciò che le rende
    // LEGGIBILI — e chi non vuole il tratto lo dichiara mesh per mesh.
    if (gbr) gbr.renderTransparentMeshes = true;
    // Il predicato vive sul render-target del G-buffer, non sul renderer: è lui
    // a ricostruire la lista delle mesh a ogni passata.
    const sourceRtt = gbr ? gbr.getGBuffer() : depthRenderer?.getDepthMap();
    if (sourceRtt) {
        sourceRtt.renderListPredicate = (mesh: AbstractMesh): boolean =>
            opts.essentialOnly
                ? isEssential(mesh) && !outlineExcluded.has(mesh)
                : !outlineExcluded.has(mesh);
    }
    // ⚠️ La MISURA della sorgente, stampata una volta. `enableGeometryBufferRenderer`
    // torna il renderer GIÀ ESISTENTE se c'è, e in quel caso IGNORA il ratio
    // richiesto: senza questa riga un esperimento "a mezza risoluzione" può
    // essere girato a risoluzione piena senza che nulla lo dica, e il risultato
    // nullo si legge come «la leva non serve» invece che «la leva non è stata
    // tirata». È già successo.
    if (sourceRtt) {
        const sz = sourceRtt.getSize();
        // eslint-disable-next-line no-console
        console.log(`[celOutline] sorgente=${opts.depthOnly ? 'depth' : 'gbuffer'} `
            + `${sz.width}x${sz.height} ratioRichiesto=${opts.gBufferRatio} `
            + `pp=${opts.postProcessRatio} essentialOnly=${opts.essentialOnly}`);
    }

    const depthIdx = gbr ? gbr.getTextureIndex(GeometryBufferRenderer.DEPTH_TEXTURE_TYPE) : -1;
    const normalIdx = gbr ? gbr.getTextureIndex(GeometryBufferRenderer.NORMAL_TEXTURE_TYPE) : -1;
    if (gbr && (depthIdx < 0 || normalIdx < 0)) return null;

    const engine = scene.getEngine();
    const pp = new PostProcess(
        SHADER_NAME,
        SHADER_NAME,
        ['texelSize', 'outlineColor', 'thickness', 'depthThreshold', 'normalThreshold', 'fadeDistance', 'debugView'],
        ['depthSampler', 'normalSampler'],
        opts.postProcessRatio,
        camera,
    );

    const texel = new Vector2(0, 0);
    pp.onApply = (effect): void => {
        let depthTex: Texture | undefined;
        let normalTex: Texture | undefined;
        if (gbr) {
            const textures = gbr.getGBuffer().textures;
            depthTex = textures[depthIdx] as Texture | undefined;
            normalTex = textures[normalIdx] as Texture | undefined;
        } else if (depthRenderer) {
            // Senza normali si lega la profondità a ENTRAMBI i sampler: il
            // termine delle normali resta nello shader ma viene neutralizzato
            // dalla soglia (sotto), e così non serve una seconda variante di
            // shader da tenere in pari con questa.
            depthTex = depthRenderer.getDepthMap() as unknown as Texture;
            normalTex = depthTex;
        }
        if (!depthTex || !normalTex) return;
        effect.setTexture('depthSampler', depthTex);
        effect.setTexture('normalSampler', normalTex);
        texel.set(1 / engine.getRenderWidth(), 1 / engine.getRenderHeight());
        effect.setVector2('texelSize', texel);
        effect.setColor3('outlineColor', opts.color);
        effect.setFloat('thickness', opts.thickness);
        effect.setFloat('depthThreshold', opts.depthThreshold);
        // Soglia irraggiungibile in modo depth-only: `step()` restituisce 0
        // sempre, quindi il termine delle normali si spegne senza rami.
        effect.setFloat('normalThreshold', opts.depthOnly ? 1e9 : opts.normalThreshold);
        effect.setFloat('fadeDistance', opts.fadeDistance);
        effect.setFloat('debugView', DEBUG_CODE[opts.debug]);
    };

    return {
        postProcess: pp,
        options: opts,
        apply(patch) { Object.assign(opts, patch); },
        dispose() {
            pp.dispose(camera);
            if (gbr) scene.disableGeometryBufferRenderer();
            if (depthRenderer) scene.disableDepthRenderer(camera);
        },
    };
}
