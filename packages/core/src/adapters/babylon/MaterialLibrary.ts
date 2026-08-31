// Shared material cache scoped per Babylon.js Scene.
// Prevents duplicate material instances for mesh types that all look identical.
// Each key → 1 material shared by N meshes.
// Ref-counted: disposed only when last user calls release().
//
// Two caches: standard (all tiers) and PBR (recommended+).
// Same key can exist in at most one cache per scene — acquireTieredMaterial
// picks the right cache at boot based on quality tier. releaseMaterial checks
// both, so all existing caller patterns (releaseMaterial by key) stay valid.

import type { Scene, AbstractMesh, BaseTexture } from '@babylonjs/core';
import { Color3, DynamicTexture, PBRMaterial, StandardMaterial, Texture } from '@babylonjs/core';
import { getActiveEngineProfile } from '../../domain/engineProfile';
import type { QualityPreset } from '../../domain/qualityTypes';

// ── Provider injection ────────────────────────────────────────────────────────
// Wire the app-side store lookup. Call once at scene-ready before first acquire.
// Default 'mobile-mid' makes the library usable in tests / storybook without
// a wired store.

let _getQualityPreset: () => QualityPreset = () => 'mobile-mid';

export function configureQualityPresetProvider(fn: () => QualityPreset): void {
    _getQualityPreset = fn;
}

// ── PBR low-tier mask (injectable) ────────────────────────────────────────────
// On qualityTier='lo', allowlisted commodity keys get expensive PBR features
// stripped (clearCoat / subSurface refraction+translucency / iridescence).
// App registers game-specific material keys via configurePBRLowMaskKeys at boot.
// Default: empty set (no masking).

const _lowMaskKeys = new Set<string>();

/** Register material keys that receive PBR feature masking on 'lo' tier.
 *  Call at app-boot before scene creation. Additive — safe to call multiple times. */
export function configurePBRLowMaskKeys(keys: readonly string[]): void {
    for (const k of keys) _lowMaskKeys.add(k);
}

// ── Cache structures ──────────────────────────────────────────────────────────

type StdEntry = { mat: StandardMaterial; refs: number };
type PBREntry = { mat: PBRMaterial; refs: number };
const cache    = new WeakMap<Scene, Map<string, StdEntry>>();
const pbrCache = new WeakMap<Scene, Map<string, PBREntry>>();

function getMap(scene: Scene): Map<string, StdEntry> {
    let m = cache.get(scene);
    if (!m) { m = new Map(); cache.set(scene, m); }
    return m;
}

function getPBRMap(scene: Scene): Map<string, PBREntry> {
    let m = pbrCache.get(scene);
    if (!m) { m = new Map(); pbrCache.set(scene, m); }
    return m;
}

function applyProfileMaterialTweaks(mat: StandardMaterial): void {
    const profile = getActiveEngineProfile(_getQualityPreset());
    // `disableLighting` è incompatibile col cel per costruzione: le bande si
    // ricavano dalla luce ACCUMULATA, e senza passata di illuminazione non c'è
    // nulla da quantizzare — il materiale uscirebbe piatto, senza un errore da
    // nessuna parte. Il risparmio che quel flag cerca, sotto cel si ottiene con
    // meno bande, non spegnendo le luci.
    if (profile.disableLighting && decorShadingMode !== 'cel') {
        mat.disableLighting = true;
    }
    if (profile.emissiveBoost !== 1.0 && mat.emissiveColor) {
        mat.emissiveColor = mat.emissiveColor.scale(profile.emissiveBoost);
    }
}

// ── Canonical material constructors ──────────────────────────────────────────

export function createUnlitEmissiveMat(name: string, scene: Scene, color: Color3): StandardMaterial {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor    = Color3.Black();
    m.specularColor   = Color3.Black();
    m.emissiveColor   = color;
    m.disableLighting = true;
    return m;
}

export function createUnlitEmissiveCrystalMat(name: string, scene: Scene, color: Color3, alpha = 0.82): StandardMaterial {
    const m = createUnlitEmissiveMat(name, scene, color);
    m.alpha           = alpha;
    m.backFaceCulling = false;
    return m;
}

/**
 * Superficie che si illumina DA SÉ, tenendo il colore nei VERTICI.
 *
 * È `createUnlitEmissiveMat` per una mesh a colore-per-vertice: là il colore è
 * una uniform e l'oggetto esce di una tinta sola, qui l'emissivo è bianco e a
 * dargli il colore è il vertice. Nello StandardMaterial funziona perché
 * `finalDiffuse = clamp(diffuseBase*diffuseColor + emissiveColor + ambient)`
 * viene poi MOLTIPLICATO per `baseColor`, dentro cui è già entrato `vColor`:
 * con il diffuse a nero e l'emissivo a uno, quello che resta a schermo è
 * esattamente la tinta dipinta nei vertici, a piena intensità e senza che
 * nessuna luce di scena la tocchi.
 *
 * Serve per ciò che EMETTE invece di essere illuminato — un fungo
 * bioluminescente, una vena di lava, una runa accesa: oggetti a cui una scena
 * notturna non deve poter togliere luminosità, perché la loro è propria.
 *
 * ⚠️ In un mondo cel va accompagnata da `excludeFromCel`: non c'è luce
 * accumulata da quantizzare (`disableLighting`), quindi il plugin non ha nulla
 * da fare qui — e il contorno a inchiostro invece resta, che è ciò che si vuole
 * (una forma che brilla ma è ancora disegnata).
 *
 * `gain` sotto 1 spegne, sopra 1 spinge verso il bianco: oltre l'unità la
 * clamp dello shader satura i canali già alti prima degli altri, quindi è una
 * leva di BRUCIATURA, non di luminosità — si alza solo se il bianco caldo al
 * centro è l'effetto voluto.
 */
export function createSelfLitVertexColorMat(
    name: string, scene: Scene, gain = 1,
): StandardMaterial {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor    = Color3.Black();
    m.specularColor   = Color3.Black();
    m.emissiveColor   = new Color3(gain, gain, gain);
    m.disableLighting = true;
    return m;
}

export function createLitVertexColorMat(
    name: string,
    scene: Scene,
    /** Floor emissivo. Omesso = default decor (riferimento della taratura
     *  ShadingLab). Un valore ESPLICITO è una scelta di art-direction per quella
     *  superficie e viene rispettato alla lettera — vedi `FLAT_EMISSIVE_FLOOR_K`. */
    emissiveFloor?: Color3,
    forceFlat = false,
): StandardMaterial {
    const floor = emissiveFloor ?? DECOR_EMISSIVE_FLOOR;
    // Branch cel: il chiaroscuro arriva dal plugin (bande quantizzate sulla luce
    // accumulata), quindi qui serve un materiale NUDO — bianco, senza specular e
    // soprattutto SENZA floor emissivo.
    //
    // Il floor va tolto, non ridotto: è una lift additiva uniforme, e sommata
    // dopo la quantizzazione riporta tutte le bande verso l'alto fino a
    // schiacciarle l'una sull'altra. È lo stesso motivo per cui il matcap ne
    // usa una versione scalata invece che piena, portato alla conclusione: col
    // cel il pavimento dell'ombra è il gradino più basso della ramp, e ce n'è
    // uno solo.
    //
    // Un floor ESPLICITO viene comunque ignorato in questo ramo: era
    // art-direction tarata contro il modello di illuminazione precedente, e
    // trascinarla qui significherebbe portarsi dietro una compensazione per un
    // problema che non esiste più.
    if (decorShadingMode === 'cel') {
        const m = new StandardMaterial(name, scene);
        m.diffuseColor = Color3.White();
        m.specularColor = Color3.Black();
        m.emissiveColor = Color3.Black();
        return m;
    }
    // Branch S2: quando il mode decor è matcap, la stessa factory instrada al
    // sibling matcap, scalando il floor (la ramp porta il chiaroscuro — un floor
    // pieno la laverebbe via). Mode 'flat' = path storico.
    // `forceFlat`: opt-out per le superfici a GRANDE area schermo (ground tiles,
    // backdrop) — misura A25 2026-07-24: il reflection path per-fragment su
    // area piena costa ~+2ms p95 fino a rompere il gate mid; il matcap
    // resta sul decor medio-piccolo dove è stato giudicato.
    if (!forceFlat && decorShadingMode !== 'flat') {
        return createMatcapVertexColorMat(
            name, scene, decorShadingMode,
            floor.scale(MATCAP_EMISSIVE_FLOOR_K),
            MATCAP_G4_LEVEL,
        );
    }
    return createFlatLitVertexColorMat(name, scene, emissiveFloor);
}

/** Il materiale decor STORICO — flat lit + vertex color + floor emissivo —
 *  costruito DIRETTAMENTE, senza passare dal mode di shading della scena.
 *
 *  Esiste per chi deve restare fuori dal linguaggio del mondo: sotto cel la
 *  factory qui sopra restituisce un materiale nudo, giusto per una superficie
 *  che il plugin quantizzerà e sbagliato per una che ne è esclusa (uscirebbe
 *  senza chiaroscuro E senza bande, cioè piatta e spenta). Chi la chiama si
 *  prende anche l'onere di `excludeFromCel`: questa funzione sceglie la ricetta,
 *  non l'esclusione. */
export function createFlatLitVertexColorMat(
    name: string,
    scene: Scene,
    emissiveFloor?: Color3,
): StandardMaterial {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor  = Color3.White();
    m.specularColor = Color3.Black();
    // Path flat = tier `lo` (dove il matcap non arriva per dottrina low-stricter)
    // + le superfici `forceFlat` di flagship/mid. Erano le uniche parti di scena
    // rimaste col floor PIENO, cioè esattamente il look "plastica dipinta" che
    // l'asse EmissiveFloor del lab ha bocciato: applica lì il candidato
    // approvato (×0.42). Un floor esplicito resta verbatim — è art-direction
    // per-superficie e non va riscalato alla cieca.
    m.emissiveColor = emissiveFloor ?? DECOR_EMISSIVE_FLOOR.scale(FLAT_EMISSIVE_FLOOR_K);
    return m;
}

export function createFlatLitMat(
    name: string,
    scene: Scene,
    diffuse: Color3,
    emissive: Color3,
): StandardMaterial {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor  = diffuse;
    m.specularColor = Color3.Black();
    m.emissiveColor = emissive;
    return m;
}

// ── Decor matcap (shape-gradient shading, CPU-neutral) ────────────────────────
// A matcap ("material capture") is a small sphere-lit image sampled by the view
// normal: it fakes soft-body shading in ONE fragment lookup, with zero new draw
// calls / meshes / masters / render passes — it folds into the decor material.
// It replaces the flat-vertex-color "plastica dipinta" look on flagship/mid
// decor with a real light→shadow ramp. On a CPU-bound frame this is free (it
// swaps lit math for a texture read). Prototyped in Storybook before wiring into
// the game (createLitVertexColorMat branch stays default-OFF until owner sign-off).

export type DecorMatcapKind = 'soft' | 'rock';

/** Mode globale dello shading decor: 'flat' (default, stato attuale) oppure uno
 *  dei matcap kind. Va impostato al boot, PRIMA che i master decor vengano
 *  costruiti: i materiali già creati non vengono retrofittati. Sprint 2
 *  impalcatura — il gioco non lo chiama ancora (accensione = Sprint 4). */
export type DecorShadingMode = 'flat' | 'cel' | DecorMatcapKind;

let decorShadingMode: DecorShadingMode = 'flat';

/** Pacchetto G4 approvato dall'owner (taratura ShadingLab, 3 giri 2026-07-24):
 *  matcap soft ATTENUATO — il livello additivo pieno (0.38) lavava la struttura
 *  dei vertex color. Level 0.22 + floor ×0.7 = chiaroscuro di forma con i
 *  colori del flat. */
export const MATCAP_G4_LEVEL = 0.22;

/** AO cavity bakeata nei vertex color (applyBakedSunLight) quando il pacchetto
 *  G4 è attivo — taratura owner: 0.6 (colonna destra CavityAO). Costo runtime
 *  zero (solo bake-time). */
export const MATCAP_G4_CAVITY = 0.6;

/** Fattore di riduzione dell'emissive floor quando il matcap è attivo
 *  (taratura owner giro 3: ×0.7, non il ×0.42 del rapporto fra i default —
 *  col matcap attenuato il floor scende meno). */
export const MATCAP_EMISSIVE_FLOOR_K = 0.7;

/** Floor emissivo di riferimento del decor — il valore su cui è stata fatta
 *  TUTTA la taratura ShadingLab (gli assi del lab partono da qui). Non è più il
 *  valore spedito sul path flat: vedi `FLAT_EMISSIVE_FLOOR_K`. */
export const DECOR_EMISSIVE_FLOOR = new Color3(0.34, 0.32, 0.30);

/** Riduzione del floor sul path FLAT (tier `lo` + superfici `forceFlat`), dove
 *  non arriva il matcap: candidato approvato sull'asse isolato EmissiveFloor del
 *  lab (giro 2, ×0.42). Il matcap usa il suo ×0.7 perché aggiunge luce propria —
 *  le due riduzioni non si sommano mai, i due rami sono alternativi. */
export const FLAT_EMISSIVE_FLOOR_K = 0.42;

export function setDecorShadingMode(mode: DecorShadingMode): void {
    decorShadingMode = mode;
}

// ── Leva di MISURA per il congelamento sotto cel ─────────────────────────────
//
// Sotto cel i materiali Standard NON vengono congelati, perché un materiale
// congelato non ricarica le uniform e il plugin cel le carica in `bindForSubMesh`.
// Il costo di quella rinuncia (niente re-bind saltato, niente world matrix
// riusata) non è mai stato misurato — il commento in `acquireMaterial` lo dice
// esplicitamente.
//
// ⚠️ Accendere questa leva RENDERIZZA SBAGLIATO di proposito: la ramp viene
// campionata a t=0 e la scena esce nella banda più scura. Serve a quantificare
// il costo del percorso non-congelato, per decidere se vale la pena costruire il
// fix vero (congelare, e scongelare/ri-legare solo quando `configureCelPlugin`
// cambia le impostazioni — che cambiano a ingresso mondo, non per frame).
// Default `false` = comportamento corrente. Non è una configurazione da spedire.
let celFreezeMaterials = false;

export function setCelFreezeMaterials(on: boolean): void {
    celFreezeMaterials = on;
}

/** True quando i materiali vanno congelati anche sotto cel (solo misura). */
export function shouldFreezeUnderCel(): boolean {
    return celFreezeMaterials;
}

export function getDecorShadingMode(): DecorShadingMode {
    return decorShadingMode;
}

// Chiave cache: `${kind}@${level}` — il level additivo è tarabile per-materiale
// (un matcap troppo additivo lava i vertex color, feedback owner 2026-07-24).
const matcapCache = new WeakMap<Scene, Map<string, DynamicTexture>>();

function buildDecorMatcap(scene: Scene, kind: DecorMatcapKind): DynamicTexture {
    const SIZE = 128;
    const dt = new DynamicTexture(`decor-matcap-${kind}`, { width: SIZE, height: SIZE }, scene, false);
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;
    // Light from the upper-left; radial falloff to a dark rim (the unlit side of
    // the sphere). 'rock' = higher-contrast ramp + a tight specular hotspot
    // (glossy basalt); 'soft' = low-contrast matte ramp (foliage / organic).
    const lx = SIZE * 0.36, ly = SIZE * 0.32;
    const grad = ctx.createRadialGradient(lx, ly, SIZE * 0.04, SIZE * 0.5, SIZE * 0.5, SIZE * 0.72);
    if (kind === 'rock') {
        grad.addColorStop(0.00, '#ffffff');
        grad.addColorStop(0.14, '#d7d7d7');
        grad.addColorStop(0.48, '#7d7d7d');
        grad.addColorStop(1.00, '#242424');
    } else {
        grad.addColorStop(0.00, '#e8e8e8');
        grad.addColorStop(0.50, '#8f8f8f');
        grad.addColorStop(1.00, '#333333');   // deeper shadow side → più forma, meno "plastilina"
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIZE, SIZE);
    if (kind === 'rock') {
        const hs = ctx.createRadialGradient(lx, ly, 0, lx, ly, SIZE * 0.13);
        hs.addColorStop(0, 'rgba(255,255,255,0.85)');
        hs.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = hs;
        ctx.fillRect(0, 0, SIZE, SIZE);
    }
    dt.update(false);
    dt.coordinatesMode = Texture.SPHERICAL_MODE;   // reflection-vector sphere map = matcap
    dt.wrapU = Texture.CLAMP_ADDRESSMODE;
    dt.wrapV = Texture.CLAMP_ADDRESSMODE;
    dt.gammaSpace = false;                          // encodes a shading ramp, sample linear
    dt.level = kind === 'rock' ? 0.55 : 0.38;       // additive contribution (subtle: shade, don't wash)
    return dt;
}

/** Shared per-scene procedural matcap: ONE 128² texture per (kind, level) →
 *  every decor material of that combo reuses it (CPU-neutral). `level` override
 *  del contributo additivo (default per-kind: rock 0.55 / soft 0.38). */
export function getDecorMatcap(scene: Scene, kind: DecorMatcapKind = 'soft', level?: number): DynamicTexture {
    let m = matcapCache.get(scene);
    if (!m) { m = new Map(); matcapCache.set(scene, m); }
    const key = `${kind}@${level ?? 'default'}`;
    let tex = m.get(key);
    if (!tex) {
        tex = buildDecorMatcap(scene, kind);
        if (level !== undefined) tex.level = level;
        m.set(key, tex);
    }
    return tex;
}

/** Matcap-shaded sibling of createLitVertexColorMat: same white-diffuse /
 *  vertex-color-driven albedo, but with a matcap sphere-map adding a view-
 *  dependent shape gradient (one fragment lookup, no new DC/mesh/pass). The
 *  emissive floor is LOWER than the flat variant because the matcap now carries
 *  the light→shadow ramp instead of a flat lift. Default-OFF in the game: reached
 *  only when the tier branch (or a story) asks for it. */
export function createMatcapVertexColorMat(
    name: string,
    scene: Scene,
    kind: DecorMatcapKind = 'soft',
    emissiveFloor: Color3 = new Color3(0.14, 0.13, 0.12),
    matcapLevel?: number,
): StandardMaterial {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor  = Color3.White();
    m.specularColor = Color3.Black();
    m.emissiveColor = emissiveFloor;
    m.reflectionTexture = getDecorMatcap(scene, kind, matcapLevel);
    return m;
}

// ── Shared material acquire / release ─────────────────────────────────────────

export function acquireMaterial(
    scene: Scene,
    key: string,
    factory: (mat: StandardMaterial) => void,
): StandardMaterial {
    const m = getMap(scene);
    let entry = m.get(key);
    if (!entry) {
        const mat = new StandardMaterial(key, scene);
        factory(mat);
        applyProfileMaterialTweaks(mat);
        // Un materiale congelato NON ricarica le uniform dopo il primo bind, e
        // il plugin cel le carica proprio lì (`bindForSubMesh`). Congelarlo
        // lascia `celRampScale` a zero, la ramp viene campionata a t=0 e ogni
        // superficie esce nella banda più scura: una scena uniformemente buia
        // che non reagisce a NESSUNA taratura — il sintomo più fuorviante
        // possibile, perché somiglia a un errore di calibrazione.
        //
        // Il congelamento è un'ottimizzazione reale (salta il ricalcolo della
        // world matrix e il re-bind), quindi rinunciarci ha un costo: è una
        // delle voci che il gate perf su A25 deve misurare.
        if (decorShadingMode !== 'cel' || celFreezeMaterials) mat.freeze();
        entry = { mat, refs: 0 };
        m.set(key, entry);
    }
    entry.refs++;
    return entry.mat;
}

function maskExpensivePbrFeatures(mat: PBRMaterial): void {
    mat.clearCoat.isEnabled = false;
    mat.subSurface.isRefractionEnabled = false;
    mat.subSurface.isTranslucencyEnabled = false;
    mat.iridescence.isEnabled = false;
}

export function acquirePBRMaterial(
    scene: Scene,
    key: string,
    factory: (mat: PBRMaterial) => void,
): PBRMaterial {
    const m = getPBRMap(scene);
    let entry = m.get(key);
    if (!entry) {
        const mat = new PBRMaterial(key, scene);
        factory(mat);
        if (_lowMaskKeys.has(key)
            && getActiveEngineProfile(_getQualityPreset()).qualityTier === 'lo') {
            maskExpensivePbrFeatures(mat);
        }
        mat.freeze();
        entry = { mat, refs: 0 };
        m.set(key, entry);
    }
    entry.refs++;
    return entry.mat;
}

/**
 * Materiale a due strade: PBR dove la luce è accesa, Standard dove non lo è.
 *
 * ⚠️ SOTTO CEL LA SCELTA NON ESISTE — e la sua assenza era un difetto muto.
 *
 * Il plugin cel vive su `StandardMaterial` e su nient'altro: su un PBR non si
 * attacca affatto. Senza questo ramo, ogni oggetto acquisito da qui su un
 * telefono di fascia alta o media (dove `disableLighting` è falso) usciva
 * illuminato in PBR **dentro un mondo cel** — nessun errore, nessun avviso, e a
 * schermo una manciata di oggetti lucidi in mezzo a una scena a bande. È lo
 * stesso difetto che il banco `cel/` aveva pagato in vetrina, dove il modo
 * cotto non disegnava niente perché `tryBakeCelHull` rifiuta in silenzio ogni
 * materiale non-Standard: la stessa regola, dall'altro lato.
 *
 * E non basta prendere la strada Standard: la fabbrica del chiamante è tarata
 * per il modello di illuminazione PRECEDENTE, quindi porta uno specular e un
 * FLOOR EMISSIVO. Sotto cel il floor è una lift additiva uniforme sommata DOPO
 * la quantizzazione: riporta tutte le bande verso l'alto finché si schiacciano
 * l'una sull'altra, cioè lava via esattamente il chiaroscuro che il cel esiste
 * per dare. Si azzerano entrambi, come fa già `createLitVertexColorMat` — dove
 * serve un bagliore vero, sotto cel la strada è il lift emissivo del plugin, non
 * il pavimento del materiale.
 */
export function acquireTieredMaterial(
    scene: Scene,
    key: string,
    stdFactory: (mat: StandardMaterial) => void,
    pbrFactory: (mat: PBRMaterial) => void,
): StandardMaterial | PBRMaterial {
    if (decorShadingMode === 'cel') {
        return acquireMaterial(scene, key, (mat) => {
            stdFactory(mat);
            mat.specularColor = Color3.Black();
            mat.emissiveColor = Color3.Black();
        });
    }
    const profile = getActiveEngineProfile(_getQualityPreset());
    if (!profile.disableLighting) {
        return acquirePBRMaterial(scene, key, pbrFactory);
    }
    return acquireMaterial(scene, key, stdFactory);
}

/**
 * Le texture che il materiale POSSIEDE, per convenzione di nome.
 *
 * `Material.dispose()` non tocca le texture (il default di Babylon è
 * `forceDisposeTextures=false`), ed è il default GIUSTO: una texture condivisa
 * — il matcap del decor, la bump del bush3d, la ramp cel — appartiene alla sua
 * cache, non all'ultimo materiale che la lascia, e distruggerla di lì
 * annerirebbe tutti gli altri. Ma le bump procedurali per-materiale
 * (`${m.name}-reef-bump`, `${m.name}-skin-bump`: v. `materials.types.ts`) non
 * hanno nessun'altra casa, quindi senza questa riga restano in scena per
 * sempre. Misurato alternando due mondi senza mai chiudere l'app: texture di
 * scena 18 → 56 in quattro giri, una copia nuova di ogni bump a ogni rientro
 * nel mondo, e l'heap dietro (fino a ~900 MB) — su telefono è il punto in cui
 * il sistema uccide la WebView.
 *
 * Il discrimine è il PREFISSO col nome del materiale, ed è quello onesto: è la
 * convenzione con cui chi la crea dichiara che quella texture è sua e di
 * nessun altro. Le condivise non lo portano mai — non potrebbero, non
 * appartengono a un materiale solo — quindi non c'è modo che questa passata le
 * prenda per sbaglio.
 */
function ownedTextures(mat: StandardMaterial | PBRMaterial): BaseTexture[] {
    const prefix = `${mat.name}-`;
    return mat.getActiveTextures().filter((t) => t.name?.startsWith(prefix));
}

/** Dispose del materiale + delle sue texture proprie. La lista si prende PRIMA
 *  del dispose: dopo, il materiale non le espone più. */
function disposeWithOwnedTextures(mat: StandardMaterial | PBRMaterial): void {
    const owned = ownedTextures(mat);
    mat.unfreeze();
    mat.dispose();
    for (const tex of owned) tex.dispose();
}

export function releaseMaterial(scene: Scene, key: string): void {
    const m = cache.get(scene);
    if (m) {
        const entry = m.get(key);
        if (entry) {
            if (process.env['NODE_ENV'] !== 'production' && pbrCache.get(scene)?.has(key)) {
                // eslint-disable-next-line no-console
                console.warn(`[MaterialLibrary] key "${key}" found in BOTH caches (std+PBR) — invariant violated, release is ambiguous`);
            }
            entry.refs--;
            if (entry.refs <= 0) {
                disposeWithOwnedTextures(entry.mat);
                m.delete(key);
            }
            return;
        }
    }
    releasePBRMaterial(scene, key);
}

export function releasePBRMaterial(scene: Scene, key: string): void {
    const m = pbrCache.get(scene);
    if (!m) return;
    const entry = m.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
        disposeWithOwnedTextures(entry.mat);
        m.delete(key);
    }
}

export function disposeAll(scene: Scene): void {
    const std = cache.get(scene);
    if (std) {
        for (const entry of std.values()) disposeWithOwnedTextures(entry.mat);
        cache.delete(scene);
    }
    const pbr = pbrCache.get(scene);
    if (pbr) {
        for (const entry of pbr.values()) disposeWithOwnedTextures(entry.mat);
        pbrCache.delete(scene);
    }
    const matcaps = matcapCache.get(scene);
    if (matcaps) {
        for (const tex of matcaps.values()) tex.dispose();
        matcapCache.delete(scene);
    }
}

export function peekMaterial(scene: Scene, key: string): StandardMaterial | null {
    return cache.get(scene)?.get(key)?.mat ?? null;
}

export function peekPBRMaterial(scene: Scene, key: string): PBRMaterial | null {
    return pbrCache.get(scene)?.get(key)?.mat ?? null;
}

export function forceCompileMaterial(
    scene: Scene,
    key: string,
    mesh: AbstractMesh,
): Promise<void> {
    // One-cache-per-key invariant (M-3): a key lives in EITHER the Standard or
    // the PBR cache, never both. Compile BOTH the non-instanced and the
    // hardware-instanced (INSTANCES define) variant regardless of material class:
    // pooled meshes render as InstancedMesh (createInstance), so the instanced
    // form is the one used live, while a direct material lookup wants the plain
    // form. Standard previously compiled only the non-instanced variant, leaving
    // its INSTANCES form to compile on the first live render (low tier, where
    // obstacle materials are Standard) — a transition-window recompile.
    const mat = peekMaterial(scene, key) ?? peekPBRMaterial(scene, key);
    if (!mat) return Promise.resolve();
    const compile = (useInstances: boolean): Promise<void> =>
        new Promise<void>((resolve) => {
            mat.forceCompilation(mesh, () => resolve(), { clipPlane: false, useInstances });
        });
    return Promise.all([compile(false), compile(true)]).then(() => undefined);
}
