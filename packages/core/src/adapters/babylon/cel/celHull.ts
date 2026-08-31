// Contorno — candidato B: guscio invertito.
//
// Una copia della mesh, gonfiata lungo le normali, tinta di inchiostro e con le
// facce ANTERIORI scartate: resta visibile solo il bordo che sporge dietro la
// mesh originale. È la tecnica dei giochi cel-shaded giapponesi ed è quella che
// dà il tratto "a pennello": lo spessore è in unità di mondo, quindi il contorno
// si assottiglia con la distanza esattamente come farebbe un disegno in
// prospettiva.
//
// Il costo è una draw call in più per mesh. In un prototipo non conta; nel
// gioco conterebbe, ed è precisamente il compromesso che l'owner deve poter
// vedere prima di sceglierlo.
//
// Perché non `mesh.renderOutline` di Babylon: fa la stessa cosa ma il colore e
// lo spessore stanno sulla mesh, non su un materiale condiviso, quindi ogni
// ritaratura è un ciclo su tutte le mesh invece di una uniform. In un lab dove
// lo spessore è l'asse da tarare, la differenza è tutta lì.

import type { Material, Scene } from '@babylonjs/core';
import { Color3, Mesh, ShaderMaterial, VertexBuffer, VertexData } from '@babylonjs/core';
import { setCelPluginOn } from './CelMaterialPlugin';
import { CEL_HULL_VERTEX_SHADER, CEL_HULL_FRAGMENT_SHADER } from './celShading.glsl';

export interface CelHullOptions {
    /** Estrusione lungo la normale, in unità di mondo. */
    thickness: number;
    color: Color3;
}

export const DEFAULT_CEL_HULL: CelHullOptions = {
    thickness: 0.035,
    color: new Color3(0.04, 0.03, 0.06),
};

export interface CelHullHandle {
    readonly material: ShaderMaterial;
    /** I gusci creati finora — uno per mesh sorgente. */
    readonly hulls: readonly Mesh[];
    add(source: Mesh): Mesh | null;
    apply(patch: Partial<CelHullOptions>): void;
    setEnabled(on: boolean): void;
    dispose(): void;
}

/** Un solo materiale guscio per scena, condiviso da tutti i gusci: ritarare lo
 *  spessore è allora una singola uniform invece di N materiali da aggiornare. */
export function createCelHullFactory(
    scene: Scene,
    overrides: Partial<CelHullOptions> = {},
): CelHullHandle {
    const opts: CelHullOptions = { ...DEFAULT_CEL_HULL, ...overrides };

    const material = new ShaderMaterial(
        'cel-hull',
        scene,
        { vertexSource: CEL_HULL_VERTEX_SHADER, fragmentSource: CEL_HULL_FRAGMENT_SHADER },
        {
            attributes: ['position', 'normal'],
            uniforms: ['world', 'viewProjection', 'hullThickness', 'hullColor'],
        },
    );
    // Il guscio deve mostrare solo il proprio ROVESCIO: le facce anteriori vanno
    // scartate, o la copia gonfiata coprirebbe l'originale e si vedrebbe una
    // sagoma nera piena. `cullBackFaces = false` è la leva esplicita di Babylon
    // per invertire quale lato viene scartato; `sideOrientation` NON basta,
    // perché viene ricombinato con quello della mesh e il risultato dipende dal
    // sistema di coordinate della scena.
    material.backFaceCulling = true;
    material.cullBackFaces = false;
    material.setFloat('hullThickness', opts.thickness);
    material.setColor3('hullColor', opts.color);

    const hulls: Mesh[] = [];

    return {
        material,
        hulls,
        add(source) {
            const hull = source.clone(`${source.name}-hull`, source.parent, true);
            if (!hull) return null;
            hull.material = material;
            // Il guscio è puro decoro: niente picking, niente ombre, niente
            // contributo al bounding usato dal culling della sorgente.
            hull.isPickable = false;
            hull.receiveShadows = false;
            hull.doNotSyncBoundingInfo = true;
            hulls.push(hull);
            return hull;
        },
        apply(patch) {
            Object.assign(opts, patch);
            if (patch.thickness !== undefined) material.setFloat('hullThickness', opts.thickness);
            if (patch.color) material.setColor3('hullColor', opts.color);
        },
        setEnabled(on) {
            for (const h of hulls) h.setEnabled(on);
        },
        dispose() {
            for (const h of hulls) h.dispose();
            hulls.length = 0;
            material.dispose();
        },
    };
}

// ── Guscio COTTO NELLA GEOMETRIA: zero draw call ────────────────────────────
//
// La terza incarnazione del contorno, dopo il post-process e il guscio a
// `renderOutline`. Misurate entrambe su A25 mid (scena esterna densa, 112k verts, device
// ~38°C): il post-process costa ~20 fps di tassa fissa che nessuna leva riduce
// (cinque provate); il guscio per-mesh costa ~0.13 fps per draw call e su uno
// scenario intero sono +127 DC = −14 fps. La relazione fps↔DC è lineare e i
// VERTICI invece sono gratis (togliere 35k verts non muove nulla): il frame è
// submission-bound, non raster-bound.
//
// Da qui la mossa: appendere i triangoli del guscio ALLA STESSA mesh. Estrusi
// lungo la normale, avvolti al contrario, tinti d'inchiostro nei vertici — il
// backface culling mostra solo il bordo che sporge, esattamente come il guscio
// classico, ma dentro la draw call che la mesh già paga. Il costo è raster e
// memoria (+100% dei triangoli del pezzo), cioè la valuta che su questo frame
// non vale niente.
//
// ⚠️ Le normali dell'estrusione vanno LISCIATE per posizione, non prese dalla
// mesh: i modelli cel sono flat-shaded, cioè hanno i vertici sdoppiati per
// faccia con normali divergenti — estrudere lungo quelle apre il guscio a ogni
// spigolo (è lo strappo per cui il candidato B era stato scartato). Mediare le
// normali di tutti i vertici che condividono una posizione richiude il guscio
// per costruzione: è il fix classico, e qui è anche ciò che rende il tratto
// PULITO dove il guscio per-mesh sgranava.


/** Le mesh già cotte: la cottura è irreversibile sulla mesh viva (si toglie
 *  ricostruendo il modello), quindi va fatta una volta sola. */
const bakedHulls = new WeakSet<object>();

/** Le mesh RIFIUTATE, e la memoria è obbligatoria: il chiamante di produzione
 *  riprova a ogni frame (le mesh nascono vuote e si cuociono al primo frame
 *  con la geometria), e senza questo set ogni rifiuto — buffer updatable,
 *  materiale non-Standard, componenti aperte — rifarebbe l'ANALISI INTERA
 *  (cluster, union-find, volumi) sessanta volte al secondo su un mondo che è
 *  già CPU-bound. Tutti i motivi di rifiuto sono permanenti per costruzione:
 *  updatable è una dichiarazione, il materiale è assegnato alla nascita, la
 *  topologia non cambia senza ricostruire la mesh (e una mesh ricostruita è
 *  un oggetto nuovo). */
const bakeRejected = new WeakSet<object>();

/** Varianti a CULLING ACCESO dei materiali condivisi, una per materiale
 *  sorgente (chiave: uniqueId) — non una per mesh, o il costo di bind
 *  crescerebbe con la scena invece che col numero di materiali.
 *
 *  ⚠️ Perché servono: la MaterialLibrary del gioco costruisce i condivisi con
 *  `backFaceCulling = false` (il fogliame a due facce lo pretende), e senza
 *  culling il guscio cotto disegna anche le facce FRONTALI — l'oggetto esce
 *  coperto d'inchiostro, visto a schermo come una scena interamente inchiostrata. Il
 *  guscio vive del culling: le sue facce guardano in dentro apposta.
 *
 *  Su un volume CHIUSO (l'unico tipo di mesh che questa cottura accetta)
 *  accendere il culling non cambia un pixel del modello: le facce posteriori
 *  di un solido chiuso non si vedono mai. Cambia solo il guscio, che
 *  finalmente mostra il bordo e nasconde il resto.
 *
 *  La variante NON passa dalla MaterialLibrary: è un clone fuori conteggio,
 *  vive quanto la scena e si libera col suo dispose. Il cel plugin va riacceso
 *  a mano sul clone — l'accensione globale itera i materiali VIVI al momento
 *  della chiamata, e il clone nasce dopo. */
const hullMatVariants = new Map<number, Material>();

function cullingOnVariant(mat: Material): Material | null {
    const hit = hullMatVariants.get(mat.uniqueId);
    if (hit) return hit;
    const cloneFn = (mat as Material & { clone?: (name: string) => Material | null }).clone;
    if (typeof cloneFn !== 'function') return null;
    const clone = cloneFn.call(mat, `${mat.name}-hullcull`);
    if (!clone) return null;
    clone.backFaceCulling = true;
    // ⚠️ Orientamento INVERTITO rispetto al default. I modelli cel sono nati e
    // sono sempre stati guardati sotto culling spento, dove l'avvolgimento non
    // conta: misurato accendendolo, le loro facce leggono come RETRO per la
    // convenzione di Babylon — il solido sparisce e resta l'interno del guscio,
    // cioè una scena di sagome d'inchiostro. Il verso giusto si dichiara qui,
    // sul materiale variante, e i modelli approvati non si toccano.
    clone.sideOrientation = 0; // Material.ClockWiseSideOrientation
    setCelPluginOn(clone, true);
    hullMatVariants.set(mat.uniqueId, clone);
    return clone;
}

/** La mesh ha già il guscio cotto dentro. Serve al chiamante che ripassa per
 *  frame: «già cotta» e «rifiutata» rispondono entrambe false alla cottura, ma
 *  solo la seconda deve ricadere sul guscio per-mesh. */
export function isCelHullBaked(mesh: object): boolean {
    return bakedHulls.has(mesh);
}

/** Appende il guscio d'inchiostro alla geometria della mesh. Ritorna false se
 *  la mesh non è cocibile (niente geometria propria, già cotta, o senza il
 *  corredo posizioni+indici). Un rifiuto è PERMANENTE (v. `bakeRejected`). */
/** L'ingombro del CORPO, cioè la geometria com'era prima che il guscio esistesse.
 *
 *  ⚠️ ESISTE PERCHÉ LA COTTURA CAMBIA LA MISURA, NON SOLO IL DISEGNO. Il guscio
 *  è una copia della mesh gonfiata lungo le normali e cotta **nella stessa
 *  geometria**: dopo `bakeCelHullIntoMesh` la mesh ha il doppio dei vertici e
 *  una scatola più grande in modo non uniforme (misurato in gioco sul tronco
 *  di un tronco, `1.388/0.550/0.547` → `1.423/0.579/0.571`). Chiunque **deduca**
 *  una misura dalla mesh — una hitbox, un raggio di rotolamento, una
 *  semilarghezza letale — dopo la cottura sta misurando anche l'inchiostro del
 *  contorno, e non ha modo di accorgersene: la mesh è la stessa, la chiave è la
 *  stessa, e il numero è semplicemente un altro.
 *
 *  La cura non è che ogni fabbrica si ricordi di misurare prima (una copia a
 *  mano diverge alla prima distrazione): è che **la misura vera resti
 *  disponibile** dopo la cottura, a chi la chiede. Chi non l'ha cotta non trova
 *  nulla e legge la mesh, che per lui è ancora la verità.
 *
 *  Il registro è una `WeakMap`: non trattiene le mesh in vita, e una mesh
 *  ricostruita con la stessa chiave riparte pulita. */
const bodyBoxes = new WeakMap<Mesh, { min: readonly [number, number, number]; max: readonly [number, number, number] }>();

/** L'ingombro LOCALE del corpo, se questa mesh ha il guscio cotto dentro.
 *  `null` per ogni altra mesh — che è la risposta giusta: là la scatola della
 *  mesh è già la geometria. */
export function celBodyBoxOf(
    mesh: Mesh,
): { min: readonly [number, number, number]; max: readonly [number, number, number] } | null {
    return bodyBoxes.get(mesh) ?? null;
}

export function bakeCelHullIntoMesh(
    mesh: Mesh, width: number, color: Color3,
): boolean {
    if (bakedHulls.has(mesh) || bakeRejected.has(mesh)) return false;
    const ok = tryBakeCelHull(mesh, width, color);
    if (ok) bakedHulls.add(mesh);
    // Una mesh ancora VUOTA non è un rifiuto: è una mesh non ancora nata (il
    // pool la riempie dopo). Permanente è solo il no su geometria vera.
    else if (mesh.getTotalVertices() > 0) bakeRejected.add(mesh);
    return ok;
}

function tryBakeCelHull(
    mesh: Mesh, width: number, color: Color3,
): boolean {
    // ⚠️ Le mesh con buffer AGGIORNABILI non si cuociono. Il buffer updatable è
    // la dichiarazione che qualcuno lo riscrive a runtime — un tile di terreno
    // rititnge i colori quando cambia la palette della scena, un'altra superficie
    // ricampiona le quote — e la cottura lo sostituirebbe con uno statico più
    // lungo: la riscrittura successiva diventerebbe un no-op silenzioso, cioè
    // il pavimento della scena PRECEDENTE che resta a schermo. È la stessa
    // classe di difetto già pagata sul keep-warm dei tile.
    const colorBuf = mesh.getVertexBuffer(VertexBuffer.ColorKind);
    const posBuf = mesh.getVertexBuffer(VertexBuffer.PositionKind);
    if (colorBuf?.isUpdatable() || posBuf?.isUpdatable()) return false;
    // Solo il percorso cel (StandardMaterial): il guscio ha bisogno della
    // variante a culling acceso, e clonare un materiale NON-cel sotto i piedi
    // del sistema che lo anima (la skin PBR della bolla aggiorna il SUO
    // riferimento per frame: la mesh renderebbe il clone mentre la skin scrive
    // l'originale) è un difetto silenzioso già in agguato. Le protagoniste
    // non-Standard tengono il guscio per-mesh classico, che il materiale non
    // lo tocca.
    if (mesh.material?.getClassName() !== 'StandardMaterial') return false;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices || indices.length === 0) return false;
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
    if (!normals) return false;
    const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
    const count = positions.length / 3;

    // Normali lisciate: media per POSIZIONE (chiave quantizzata al decimo di
    // millimetro — le copie flat-shaded coincidono esattamente, la quantizza
    // serve solo a rendere onesto il confronto float).
    const clusters = new Map<string, [number, number, number]>();
    for (let v = 0; v < count; v++) {
        const k = `${Math.round((positions[v * 3] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 1] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 2] ?? 0) * 1e4)}`;
        const acc = clusters.get(k);
        if (acc) {
            acc[0] += normals[v * 3] ?? 0; acc[1] += normals[v * 3 + 1] ?? 0; acc[2] += normals[v * 3 + 2] ?? 0;
        } else {
            clusters.set(k, [normals[v * 3] ?? 0, normals[v * 3 + 1] ?? 0, normals[v * 3 + 2] ?? 0]);
        }
    }

    // ⚠️ Il guscio invertito vale solo per i VOLUMI CHIUSI, e questa è la
    // guardia che lo dice. Su un PIANO (lama d'erba, foglia, petalo — mezza
    // flora cel) i due lati hanno vertici coincidenti con normali opposte: la
    // media si annulla, l'estrusione degenera e il guscio esce complanare alla
    // faccia — z-fighting nero su tutto il pezzo, visto a schermo come un
    // scena interamente inchiostrata. Se una parte significativa dei cluster è
    // degenere, la mesh non è un volume e non si coce: meglio nessun tratto
    // che un tratto che divora il modello.
    let degenerate = 0;
    for (const n of clusters.values()) {
        if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 0.25) degenerate++;
    }
    if (degenerate > clusters.size * 0.05) return false;

    // ── DUE PERCORSI, e la differenza è chi garantisce l'avvolgimento ───────
    //
    // 1. Materiale col CULLING GIÀ ACCESO (qualunque materiale simile): il modello è
    //    stato guardato e approvato proprio così, quindi l'avvolgimento è
    //    dimostrato dallo schermo. Si emette il guscio come puro rovescio degli
    //    indici d'autore e NON si tocca nient'altro. ⚠️ Qui la normalizzazione
    //    non è inutile: è DANNOSA — provata, anneriva l'intero campo, perché i
    //    petali sono dischi aperti (volume firmato ≈ 0, segno privo di senso) e
    //    il flip "canonico" rompeva un verso che era già giusto.
    //
    // 2. Materiale col culling SPENTO: l'avvolgimento non è mai stato visto,
    //    e i builder non concordano (le primitive di Babylon in un verso, i
    //    solidi spazzati custom nell'altro; le UNIONI li mischiano dentro la
    //    stessa mesh). Qui si normalizza PER COMPONENTE CONNESSA (union-find
    //    sui cluster di posizione, volume firmato per componente) — ed è
    //    legittimo riscrivere gli indici perché sotto culling spento il verso è
    //    invisibile per definizione: vetrina e VRT non cambiano di un pixel.
    //    Ma vale SOLO se ogni componente è davvero chiusa: una componente
    //    aperta non ha un fuori, e cuocerla col culling acceso significherebbe
    //    farne sparire un lato. Se ce n'è una, la mesh non si coce.
    const nativeCulling = mesh.material?.backFaceCulling === true;

    const clusterKeys = [...clusters.keys()];
    const clusterIndex = new Map<string, number>();
    clusterKeys.forEach((k, i) => clusterIndex.set(k, i));
    const keyOf = (v: number): number => {
        const k = `${Math.round((positions[v * 3] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 1] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 2] ?? 0) * 1e4)}`;
        return clusterIndex.get(k) ?? 0;
    };
    const parent = new Int32Array(clusterKeys.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (x: number): number => {
        let r = x;
        while (parent[r] !== r) r = parent[r] ?? r;
        while (parent[x] !== r) { const nxt = parent[x] ?? r; parent[x] = r; x = nxt; }
        return r;
    };
    const union = (a: number, b: number): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const faceCluster = new Int32Array(indices.length / 3);
    for (let i = 0; i < indices.length; i += 3) {
        const ca = keyOf(indices[i] ?? 0), cb = keyOf(indices[i + 1] ?? 0), cc = keyOf(indices[i + 2] ?? 0);
        union(ca, cb); union(cb, cc);
        faceCluster[i / 3] = ca;
    }
    const vol6ByRoot = new Map<number, number>();
    for (let i = 0; i < indices.length; i += 3) {
        const a = (indices[i] ?? 0) * 3, b = (indices[i + 1] ?? 0) * 3, c = (indices[i + 2] ?? 0) * 3;
        const ax = positions[a] ?? 0, ay = positions[a + 1] ?? 0, az = positions[a + 2] ?? 0;
        const bx = positions[b] ?? 0, by = positions[b + 1] ?? 0, bz = positions[b + 2] ?? 0;
        const cx = positions[c] ?? 0, cy = positions[c + 1] ?? 0, cz = positions[c + 2] ?? 0;
        const t = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
        const r = find(faceCluster[i / 3] ?? 0);
        vol6ByRoot.set(r, (vol6ByRoot.get(r) ?? 0) + t);
    }
    // ── Componenti APERTE: il guscio NON si emette, su nessun percorso ──────
    //
    // Il metro è l'area^1.5 della componente: un volume vero cresce col cubo,
    // un disco resta al pelo dello zero. E la regola non è prudenza, è
    // geometria — su una superficie aperta il rovescio del guscio diventa
    // visibile ESATTAMENTE dove l'originale è scartato dal culling: misurato a
    // schermo su mesh a disco aperto, i petali via dalla camera sparivano e i
    // loro gusci d'inchiostro comparivano al loro posto — forme nere piene.
    // Le componenti aperte tengono il rim del materiale; il
    // guscio va solo dove c'è un fuori.
    const areaByRoot = new Map<number, number>();
    for (let i = 0; i < indices.length; i += 3) {
        const a = (indices[i] ?? 0) * 3, bI = (indices[i + 1] ?? 0) * 3, c = (indices[i + 2] ?? 0) * 3;
        const ux = (positions[bI] ?? 0) - (positions[a] ?? 0), uy = (positions[bI + 1] ?? 0) - (positions[a + 1] ?? 0), uz = (positions[bI + 2] ?? 0) - (positions[a + 2] ?? 0);
        const vx = (positions[c] ?? 0) - (positions[a] ?? 0), vy = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0), vz = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0);
        const cx2 = uy * vz - uz * vy, cy2 = uz * vx - ux * vz, cz2 = ux * vy - uy * vx;
        const r = find(faceCluster[i / 3] ?? 0);
        areaByRoot.set(r, (areaByRoot.get(r) ?? 0) + Math.hypot(cx2, cy2, cz2) * 0.5);
    }
    // ── Coerenza di AVVOLGIMENTO per componente ─────────────────────────────
    //
    // Il test del volume non basta, e il difetto pagato a schermo sono le
    // mesh renderizzate NERE PIENE: una componente può superare |vol|/area^1.5 ed essere
    // avvolta in versi MISTI (la cavità del fiore è modellata flippando facce
    // — legittimo d'autore, il corpo rende identico). Ma il guscio è il
    // ROVESCIO degli indici: dove l'autore ha flippato, il rovescio guarda la
    // camera, e quel pezzo esce coperto d'inchiostro.
    //
    // Il metro onesto è topologico: in un solido chiuso avvolto coerente ogni
    // spigolo (per POSIZIONE, cioè per cluster) compare ESATTAMENTE due volte,
    // nei due versi opposti. Un verso doppio = avvolgimento misto; un verso
    // senza opposto = bordo aperto. In entrambi i casi la componente non
    // riceve il guscio — meglio nessun tratto d'inchiostro che un fiore nero.
    // Gli spigoli collassati (a==b, facce degeneri) sono neutri: la loro
    // faccia è invisibile in ogni caso.
    const EDGE_K = 1 << 21; // cluster id < 2^21 ⇒ chiave a*2^21+b entro i safe integer
    const dirEdges = new Map<number, number>();
    const edgeOf = (a: number, b: number): number => a * EDGE_K + b;
    for (let i = 0; i < indices.length; i += 3) {
        const ca = keyOf(indices[i] ?? 0), cb = keyOf(indices[i + 1] ?? 0), cc = keyOf(indices[i + 2] ?? 0);
        for (const [a, b] of [[ca, cb], [cb, cc], [cc, ca]] as const) {
            if (a === b) continue;
            const k = edgeOf(a, b);
            dirEdges.set(k, (dirEdges.get(k) ?? 0) + 1);
        }
    }
    const consistentRoot = new Map<number, boolean>();
    for (let i = 0; i < indices.length; i += 3) {
        const root = find(faceCluster[i / 3] ?? 0);
        if (consistentRoot.get(root) === false) continue;
        const ca = keyOf(indices[i] ?? 0), cb = keyOf(indices[i + 1] ?? 0), cc = keyOf(indices[i + 2] ?? 0);
        let ok = true;
        for (const [from, to] of [[ca, cb], [cb, cc], [cc, ca]] as const) {
            if (from === to) continue;
            if (dirEdges.get(edgeOf(from, to)) !== 1 || dirEdges.get(edgeOf(to, from)) !== 1) { ok = false; break; }
        }
        consistentRoot.set(root, (consistentRoot.get(root) ?? true) && ok);
    }
    const closedRoot = new Map<number, boolean>();
    for (const [root, area] of areaByRoot) {
        const v = Math.abs(vol6ByRoot.get(root) ?? 0) / 6;
        closedRoot.set(root,
            v >= Math.pow(area, 1.5) * 0.01 && consistentRoot.get(root) === true);
    }
    const faceClosed = (faceIdx: number): boolean =>
        closedRoot.get(find(faceCluster[faceIdx] ?? 0)) === true;
    // Percorso col CLONE (culling spento all'origine): le componenti aperte
    // oggi si vedono da ENTRAMBI i lati, e il variante col culling ne
    // taglierebbe uno — qui una componente aperta non degrada il guscio,
    // squalifica la mesh.
    if (!nativeCulling) {
        for (const closed of closedRoot.values()) {
            if (!closed) return false;
        }
    }
    // Se nessuna componente è chiusa non c'è niente da bordare.
    let anyClosed = false;
    for (const closed of closedRoot.values()) { if (closed) { anyClosed = true; break; } }
    if (!anyClosed) return false;

    // Il verso canonico è quello delle primitive di Babylon (il sasso del
    // una mesh da primitive, vista rendere GIUSTA sotto il variante): volume firmato
    // NEGATIVO nel sistema left-handed del motore. Col culling nativo non si
    // flippa MAI (v. sopra): l'avvolgimento d'autore è la verità.
    const flipFace = (faceIdx: number): boolean =>
        !nativeCulling && (vol6ByRoot.get(find(faceCluster[faceIdx] ?? 0)) ?? 0) > 0;

    // ⚠️ Il verso del GUSCIO invece si decide PER COMPONENTE, e non è «il
    // rovescio dell'autore». Mesh nere piene l'hanno pagato a schermo:
    // componenti chiuse, coerenti — e avvolte col volume POSITIVO, cioè
    // l'inverso delle primitive. Su un pezzo SOTTILE l'inversione non si vede
    // (sotto culling guardi l'interno della parete lontana, che per una lamina
    // coincide con l'esterno di quella vicina), quindi il modello era stato
    // approvato così e «dimostrato dallo schermo» non dimostrava il verso. Ma
    // il rovescio di un avvolgimento invertito è FRONTALE: il guscio copriva
    // il fiore d'inchiostro. La regola giusta: il guscio si emette SEMPRE in
    // orientamento positivo — rovescio del canone — qualunque sia il verso
    // d'autore del corpo. Per i componenti canonici è il rovescio; per gli
    // invertiti è il verso d'autore stesso; in entrambi i casi il culling ne
    // mostra solo la sporgenza oltre la silhouette.
    const facePositive = (faceIdx: number): boolean =>
        (vol6ByRoot.get(find(faceCluster[faceIdx] ?? 0)) ?? 0) > 0;

    // ⚠️ E con l'avvolgimento invertito si invertono anche le NORMALI: i
    // builder le derivano dalle facce, quindi su quei componenti puntano in
    // DENTRO e l'estrusione «lungo la normale» sgonfierebbe il guscio — che
    // finisce davanti alla parete visibile e copre d'inchiostro (i petali
    // neri rimasti dopo il fix del verso). Il guscio deve GONFIARE sempre:
    // il verso d'estrusione si decide per componente, col segno del dot fra
    // normale lisciata e raggio dal baricentro.
    const centroid = new Map<number, [number, number, number, number]>();
    for (let v = 0; v < count; v++) {
        const r = find(keyOf(v));
        const acc = centroid.get(r);
        const x = positions[v * 3] ?? 0, y = positions[v * 3 + 1] ?? 0, z = positions[v * 3 + 2] ?? 0;
        if (acc) { acc[0] += x; acc[1] += y; acc[2] += z; acc[3]++; }
        else centroid.set(r, [x, y, z, 1]);
    }
    const outwardDot = new Map<number, number>();
    for (let v = 0; v < count; v++) {
        const r = find(keyOf(v));
        const c = centroid.get(r);
        if (!c) continue;
        const k = `${Math.round((positions[v * 3] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 1] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 2] ?? 0) * 1e4)}`;
        const n = clusters.get(k);
        if (!n) continue;
        const dx = (positions[v * 3] ?? 0) - c[0] / c[3];
        const dy = (positions[v * 3 + 1] ?? 0) - c[1] / c[3];
        const dz = (positions[v * 3 + 2] ?? 0) - c[2] / c[3];
        outwardDot.set(r, (outwardDot.get(r) ?? 0) + n[0] * dx + n[1] * dy + n[2] * dz);
    }
    const extrudeSign = (clusterRoot: number): number =>
        (outwardDot.get(clusterRoot) ?? 0) >= 0 ? 1 : -1;

    // ── LO SPESSORE LOCALE, e perché il guscio non può essere assoluto ──────
    //
    // ⚠️ IL DIFETTO CHE HA IMPOSTO QUESTO BLOCCO, misurato in partita su una scena consumer il
    // 2026-08-18. Il guscio era largo `width` ovunque, e un ciuffo d'erba a lamine sottili
    // (1,07 × 0,46 m di ingombro, ma lamine spesse pochi millimetri) usciva
    // come un UNCINO NERO GRASSO: la lamina è più sottile del suo stesso
    // guscio, quindi il guscio non la contorna — la sostituisce. Sul
    // fotogramma quegli archi valevano luminanza **3** contro una sabbia a
    // 203, mentre la più scura delle diciassette specie di quel livello, in
    // albedo, sta a 97. Un albedo 97 non scende a 3 per ombreggiatura: quel
    // nero era dipinto dal guscio. Prova: alzando la soglia d'accensione i
    // pixel quasi neri passavano dall'1,62% allo 0,30%.
    //
    // ⚠️ E il criterio d'accensione non poteva vederlo: `minDiagonal` legge
    // l'INGOMBRO, che su una pianta arcuata dice quanto è larga, non quanto è
    // grossa. La grandezza che conta è il RAPPORTO fra la larghezza del tratto
    // e lo spessore del pezzo che deve contornare — e lo spessore è locale,
    // non una proprietà della mesh: un ciuffo fuso in un master unico ha un
    // bounding box grande in tutte e tre le direzioni pur essendo fatto di
    // lamine.
    //
    // Quindi lo spessore si misura VERTICE PER VERTICE, e in modo geometrico:
    // dal punto si cammina all'INDIETRO lungo la normale lisciata e si cerca
    // la superficie opposta, cioè un cluster vicino la cui normale guarda
    // dalla parte contraria. La distanza a cui la si trova è lo spessore lì.
    // Il guscio prende `min(width, SHELL_OF_THICKNESS · spessore)`: su un masso
    // non cambia nulla (la parete opposta è lontanissima), su una lamina il
    // guscio si assottiglia con lei e resta un contorno invece di diventare
    // l'oggetto.
    //
    // Costo: una griglia a hash sui cluster, celle larghe quanto il raggio di
    // ricerca, ventisette celle guardate per vertice. È lavoro di COTTURA, una
    // volta per master, non per frame.
    const SHELL_OF_THICKNESS = 0.45;
    const cellSize = Math.max(width * 2, 1e-4);
    const cx3 = new Float64Array(clusterKeys.length);
    const cy3 = new Float64Array(clusterKeys.length);
    const cz3 = new Float64Array(clusterKeys.length);
    const nx3 = new Float64Array(clusterKeys.length);
    const ny3 = new Float64Array(clusterKeys.length);
    const nz3 = new Float64Array(clusterKeys.length);
    clusterKeys.forEach((k, i) => {
        const parts = k.split(',');
        cx3[i] = Number(parts[0]) / 1e4;
        cy3[i] = Number(parts[1]) / 1e4;
        cz3[i] = Number(parts[2]) / 1e4;
        const n = clusters.get(k) ?? [0, 1, 0];
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        nx3[i] = n[0] / len; ny3[i] = n[1] / len; nz3[i] = n[2] / len;
    });
    const grid = new Map<string, number[]>();
    const cellKey = (x: number, y: number, z: number): string =>
        `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
    for (let i = 0; i < clusterKeys.length; i++) {
        const k = cellKey(cx3[i] ?? 0, cy3[i] ?? 0, cz3[i] ?? 0);
        const bucket = grid.get(k);
        if (bucket) bucket.push(i); else grid.set(k, [i]);
    }
    /** Larghezza del guscio in questo cluster: piena, o quanto lo spessore
     *  locale concede. */
    const hullWidthAt = new Float64Array(clusterKeys.length).fill(width);
    const reach = cellSize;
    for (let i = 0; i < clusterKeys.length; i++) {
        const px = cx3[i] ?? 0, py = cy3[i] ?? 0, pz = cz3[i] ?? 0;
        const ni = nx3[i] ?? 0, nj = ny3[i] ?? 0, nk = nz3[i] ?? 0;
        // Una normale degenere (lamina a due facce coincidenti) non dà una
        // direzione in cui cercare: quel cluster tiene la larghezza piena, e
        // se sono tanti la mesh è già stata scartata dalla guardia sopra.
        if (ni * ni + nj * nj + nk * nk < 0.25) continue;
        let best = Infinity;
        const gx = Math.floor(px / cellSize), gy = Math.floor(py / cellSize), gz = Math.floor(pz / cellSize);
        for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) for (let az = -1; az <= 1; az++) {
            const bucket = grid.get(`${gx + ax},${gy + ay},${gz + az}`);
            if (!bucket) continue;
            for (const j of bucket) {
                if (j === i) continue;
                // La superficie OPPOSTA guarda dalla parte contraria.
                if ((nx3[j] ?? 0) * ni + (ny3[j] ?? 0) * nj + (nz3[j] ?? 0) * nk > -0.3) continue;
                const dx = (cx3[j] ?? 0) - px, dy = (cy3[j] ?? 0) - py, dz = (cz3[j] ?? 0) - pz;
                // …e sta DIETRO, cioè nel verso in cui il pezzo ha spessore.
                const along = dx * ni + dy * nj + dz * nk;
                if (along >= 0) continue;
                const t = -along;
                if (t > reach) continue;
                // Dev'essere la faccia di fronte, non una vicina di traverso:
                // lo scarto perpendicolare resta dentro mezza larghezza.
                const ox = dx - along * ni, oy = dy - along * nj, oz = dz - along * nk;
                if (ox * ox + oy * oy + oz * oz > width * width * 0.25) continue;
                if (t < best) best = t;
            }
        }
        if (best < Infinity) hullWidthAt[i] = Math.min(width, best * SHELL_OF_THICKNESS);
    }

    const newPos = new Float32Array(count * 6);
    newPos.set(positions, 0);
    const newNor = new Float32Array(count * 6);
    newNor.set(normals, 0);
    const newCol = new Float32Array(count * 8);
    if (colors) newCol.set(colors, 0);
    else for (let v = 0; v < count; v++) { newCol[v * 4] = 1; newCol[v * 4 + 1] = 1; newCol[v * 4 + 2] = 1; newCol[v * 4 + 3] = 1; }
    const newUv = uvs ? new Float32Array(count * 4) : null;
    if (newUv && uvs) {
        newUv.set(uvs);
        newUv.copyWithin(uvs.length, 0, uvs.length);
    }

    for (let v = 0; v < count; v++) {
        const k = `${Math.round((positions[v * 3] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 1] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 2] ?? 0) * 1e4)}`;
        const n = clusters.get(k) ?? [0, 1, 0];
        const ci = clusterIndex.get(k) ?? 0;
        const w = (hullWidthAt[ci] ?? width) * extrudeSign(find(ci));
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        const o = (count + v) * 3;
        newPos[o] = (positions[v * 3] ?? 0) + (n[0] / len) * w;
        newPos[o + 1] = (positions[v * 3 + 1] ?? 0) + (n[1] / len) * w;
        newPos[o + 2] = (positions[v * 3 + 2] ?? 0) + (n[2] / len) * w;
        // Normale invertita: il guscio guarda in dentro, e sotto il cel la sua
        // banda esce comunque scura — l'inchiostro sta nei colori.
        newNor[o] = -(normals[v * 3] ?? 0); newNor[o + 1] = -(normals[v * 3 + 1] ?? 0); newNor[o + 2] = -(normals[v * 3 + 2] ?? 0);
        const c = (count + v) * 4;
        newCol[c] = color.r; newCol[c + 1] = color.g; newCol[c + 2] = color.b; newCol[c + 3] = 1;
    }

    // Indici: corpo per intero, guscio SOLO sulle facce delle componenti
    // chiuse (v. sopra).
    const hullIdx: number[] = [];
    const bodyIdx = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i += 3) {
        const i0 = indices[i] ?? 0, i1 = indices[i + 1] ?? 0, i2 = indices[i + 2] ?? 0;
        const flip = flipFace(i / 3);
        if (flip) { bodyIdx[i] = i0; bodyIdx[i + 1] = i2; bodyIdx[i + 2] = i1; }
        else { bodyIdx[i] = i0; bodyIdx[i + 1] = i1; bodyIdx[i + 2] = i2; }
        if (!faceClosed(i / 3)) continue;
        // Guscio SEMPRE in orientamento positivo (v. `facePositive`): il
        // culling ne tiene solo ciò che sporge oltre la silhouette.
        if (facePositive(i / 3)) hullIdx.push(count + i0, count + i1, count + i2);
        else hullIdx.push(count + i0, count + i2, count + i1);
    }
    const newIdx = new Uint32Array(bodyIdx.length + hullIdx.length);
    newIdx.set(bodyIdx, 0);
    newIdx.set(hullIdx, bodyIdx.length);

    // Il materiale PRIMA della geometria: se la variante non si può costruire
    // la mesh resta com'era, senza guscio — mai una cottura a metà.
    const variant = mesh.material && !mesh.material.backFaceCulling
        ? cullingOnVariant(mesh.material)
        : mesh.material;
    if (!variant) return false;

    // La misura del corpo si prende ORA, che è l'ultimo istante in cui la
    // geometria è ancora soltanto il modello: `newPos` contiene già la copia
    // gonfiata, e dopo `applyToMesh` la scatola della mesh non distingue più le
    // due metà.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let v = 0; v < count; v++) {
        const x = positions[v * 3] ?? 0, y = positions[v * 3 + 1] ?? 0, z = positions[v * 3 + 2] ?? 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    bodyBoxes.set(mesh, { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });

    const data = new VertexData();
    data.positions = newPos;
    data.indices = newIdx;
    data.normals = newNor;
    data.colors = newCol;
    if (newUv) data.uvs = newUv;
    data.applyToMesh(mesh, false);
    // ⚠️ IL nero delle mesh unite, trovato col repro isolato (2026-08-08).
    // `mergeFaceted` passa da `convertToFlatShadedMesh`, che in Babylon è
    // `_convertToUnIndexedMesh(true)`: la mesh esce marcata UNINDEXED e il
    // draw IGNORA gli indici — disegna l'array dei vertici in ordine. Con i
    // vertici raddoppiati dalla cottura l'array contiene anche la copia
    // d'inchiostro, che così viene disegnata come facce FRONTALI sopra il
    // corpo: è il «scena interamente inchiostrata», ed è il motivo per cui rimuovere
    // gli indici del guscio non cambiava nulla (nessuno li leggeva) mentre
    // ri-applicare buffer identici era perfetto (l'array grezzo era il
    // modello). Da qui in poi la mesh disegna DAGLI INDICI: per una mesh
    // flat-shaded i vertici sono già tutti unici, quindi il passaggio a
    // indicizzato non cambia un pixel del corpo — accende solo il guscio.
    if (mesh.isUnIndexed) mesh.isUnIndexed = false;
    mesh.material = variant;
    return true;
}
