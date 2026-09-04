// Il cel-shading dentro uno StandardMaterial, come plugin.
//
// PERCHÉ ESISTE, dato che c'è già `CelMaterial`: il prototipo poteva permettersi
// uno ShaderMaterial perché costruiva la propria scena da zero. Il gioco no —
// `acquireMaterial` e `acquireTieredMaterial` restituiscono
// `StandardMaterial`/`PBRMaterial` e 132 file ci contano. Un plugin inietta la
// stessa matematica nello StandardMaterial esistente **senza toccare un solo
// call site**: è ciò che rende la migrazione una questione di giorni invece che
// di mesi.
//
// ── Dove si innesta, e perché proprio lì ────────────────────────────────────
//
// Non basta scurire il colore finale: le bande devono cadere sulla LUCE, prima
// che nebbia e grade la tocchino. Nello StandardMaterial di Babylon il punto
// giusto è dove l'illuminazione accumulata (`diffuseBase`) viene composta in
// `finalDiffuse`. Non esiste un hook lì, ma i plugin possono sostituire codice
// per espressione regolare (chiavi che iniziano con `!`), e questo è
// esattamente il caso d'uso.
//
// Le tre varianti di quella riga (EMISSIVEASILLUMINATION, LINKEMISSIVEWITHDIFFUSE,
// standard) sono tutte presenti nel sorgente prima del preprocessore, quindi
// vanno coperte tutte e tre: due pattern bastano, e nessuno dei due tocca gli
// altri usi di `diffuseBase` (dichiarazione e accumulo delle luci).
//
// ── Come si quantizza senza conoscere le luci ───────────────────────────────
//
// `CelMaterial` ricava la banda da NdotL, che gli è noto perché la chiave è una
// sua uniform. Qui le luci sono quelle della scena, in numero variabile, e NdotL
// non è recuperabile. Si quantizza allora la LUMINANZA di `diffuseBase`, che è
// la somma dei contributi diffusi: stessa curva, stessa lettura a bande, e
// funziona con una luce come con quattro. `rampScale` mappa l'intervallo utile
// della scena su 0..1.
//
// ── L'unica differenza strutturale, e come si compensa ──────────────────────
//
// Verificata a schermo in `cel/CelPluginParity` (2026-08-04): i due percorsi
// danno la STESSA struttura a bande, ma non lo stesso livello. La ragione è
// nell'ordine delle operazioni:
//
//   CelMaterial :  albedo * (banda(NdotL) * luce + fill)   ← fill FUORI
//   plugin      :  albedo *  banda(chiave + fill)          ← fill DENTRO
//
// Nel prototipo il riempimento emisferico è additivo e non quantizzato (scelta
// deliberata: quantizzare anche l'ambient fa battere due quantizzazioni l'una
// contro l'altra e compaiono gradini spuri). Nello StandardMaterial l'ambient è
// una LUCE, quindi è già dentro `diffuseBase` e viene quantizzato con la chiave:
// la banda d'ombra perde il pavimento additivo e chiude più scura.
//
// Si compensa alzando il gradino d'ombra della ramp — è la stessa leva
// `ramp.shadow`, tarata su un input diverso. Va da sé che i valori NON si
// travasano dal prototipo: vanno ritarati contro l'impianto luci vero della
// scena, e sono l'unica cosa che cambia fra i due percorsi.

import type { AbstractEngine, AbstractMesh, Nullable, Scene, SubMesh, UniformBuffer } from '@babylonjs/core';
import { Color3, Material, MaterialDefines, MaterialPluginBase, RegisterMaterialPlugin } from '@babylonjs/core';
import { getCelRamp, DEFAULT_CEL_RAMP, type CelRampSpec } from './celRamp';
import { getCelHatch, NO_HATCH, type CelHatchSpec } from './celHatching';
import { shouldFreezeUnderCel } from '../MaterialLibrary';

export interface CelPluginSettings {
    ramp: CelRampSpec;
    hatch: CelHatchSpec;
    /** Mappa la luminanza di `diffuseBase` sull'asse della ramp. Va alzata se la
     *  scena è buia (le bande alte non verrebbero mai raggiunte) e abbassata se
     *  è chiara (tutto si schiaccia sull'ultima banda). */
    rampScale: number;
    inkColor: Color3;
    /** Rim d'inchiostro interno: scurisce il bordo delle superfici curve, dove
     *  un edge-detect di profondità non trova discontinuità e non disegna. */
    rimStrength: number;
    rimWidth: number;
    hatchStrength: number;
    hatchScale: number;
}

export const DEFAULT_CEL_PLUGIN: CelPluginSettings = {
    ramp: DEFAULT_CEL_RAMP,
    hatch: NO_HATCH,
    rampScale: 1.15,
    inkColor: new Color3(0.05, 0.04, 0.07),
    rimStrength: 0,
    rimWidth: 0.35,
    hatchStrength: 0,
    hatchScale: 256,
};

/** Il VENTO di un materiale: quanto e come si piega la sua geometria.
 *
 *  ── Perché sta nel materiale e non in un tick ──────────────────────────────
 *
 *  Lo scenario cel è fatto di THIN INSTANCE: centinaia di copie di pochi master,
 *  le cui matrici vengono riscritte a 10 Hz solo per riavvolgere la finestra
 *  (v. `tickDecor` nel gioco). Muoverle dalla CPU vorrebbe dire ricomporre ogni
 *  matrice a ogni frame — cioè pagare per il moto quello che l'istanziamento
 *  serve a non pagare. Nel vertex shader il costo è di due seni per vertice e
 *  non passa dal main thread, che su A25 è la valuta scarsa.
 *
 *  ── Perché la quota è al quadrato ──────────────────────────────────────────
 *
 *  Una pianta è incastrata a terra e libera in cima: il piede non si muove, la
 *  punta sì. `h²` è l'approssimazione di quel vincolo che costa meno di tutte
 *  (una moltiplicazione), e senza di lei l'intera mesh scivolerebbe di lato —
 *  che non legge come vento, legge come un errore di posa.
 *
 *  ⚠️ IL CONTORNO NON SI PIEGA. Il tratto d'inchiostro è un post-process sul
 *  G-buffer, che viene disegnato dai suoi shader (depth/geometry) e non da
 *  questo: quello che si sposta qui è la superficie, non la sua profondità. È
 *  la ragione per cui le ampiezze di serie sono in CENTIMETRI e non in decimetri
 *  — oltre, il contorno si stacca visibilmente dalla sagoma. */
export interface CelWindSpec {
    /** Spostamento in METRI alla quota `height`. Sopra i ~8 cm il tratto
     *  d'inchiostro comincia a staccarsi (v. sopra). */
    amplitude: number;
    /** Quota, in metri sopra la BASE dell'istanza, a cui vale `amplitude`. */
    height: number;
    /** Cicli al secondo dell'oscillazione lenta. */
    hz: number;
    /** Direzione del vento nel piano; viene normalizzata. Una sola per tutta la
     *  scena è ciò che rende il moto «vento» invece di «ognuno per conto suo». */
    dirX: number;
    dirZ: number;
}

/** Un vento di serie: una brezza. Tarato su piante alte due
 *  metri — cinque centimetri in punta, un ciclo ogni
 *  quattro secondi e mezzo, con le raffiche che il pattern si porta dietro. */
export const DEFAULT_CEL_WIND: CelWindSpec = {
    amplitude: 0.05, height: 2, hz: 0.22, dirX: 1, dirZ: 0.35,
};

/** LA MAREGGIATA — lo spostamento SINCRONO, gemello opposto del vento.
 *
 *  Il vento (`CelWindSpec`) sfasa ogni istanza sulla propria posizione: un
 *  campo in fase sarebbe un metronomo. Questo canale fa il contrario, ed è la
 *  ragione per cui esiste separatamente invece di essere un vento con la fase
 *  azzerata: **tutte le istanze si muovono insieme**, perché ci sono cose che
 *  in natura sono un corpo solo. Un'onda che arriva a pezzi non è un'onda.
 *
 *  ⚠️ La FASE la scrive il chiamante, ogni frame, mutando questo stesso
 *  oggetto: il plugin lo TIENE (non lo copia) e lo rilegge a ogni bind. È la
 *  stessa convenzione delle zone di corrente del gioco, e la ragione è la
 *  stessa — una fase che il motore calcolasse per conto suo sarebbe un secondo
 *  orologio, e due orologi divergono. Chi ha già una fase (una risacca, un
 *  respiro, una pulsazione) la passa e basta.
 *
 *  ⚠️ Lo spostamento NON è pesato sulla quota, a differenza del vento: una
 *  lingua di schiuma è piatta, e un peso quadratico sull'altezza la lascerebbe
 *  ferma. Qui si muove tutto il corpo, che è ciò che fa una risacca. */
export interface CelSurgeSpec {
    /** Ampiezza in metri, al colmo della fase. */
    amplitude: number;
    /** Direzione nel piano. Normalizzata dal plugin. */
    dirX: number;
    dirZ: number;
    /** Fase in RADIANTI. La scrive il chiamante a ogni frame. */
    phase: number;
}

/** IL NOME DELL'ATTRIBUTO DELLA BATTUTA D'ALI, che il consumer deve scrivere sui
 *  vertici del master: `x` = quanto quel vertice è lontano dall'asse del proprio
 *  corpo, normalizzato a [0,1]; `y` = la fase di QUELL'individuo, in [0,1).
 *
 *  ⚠️ Un attributo e non una uniform, perché un master di stormo contiene sette
 *  uccelli fusi in una mesh sola e ognuno deve battere per conto suo: la sola
 *  cosa che nel vertex shader distingue un uccello dall'altro è ciò che sta
 *  scritto nei suoi vertici. E un attributo e non le UV, perché le UV su un
 *  materiale senza texture non vengono nemmeno dichiarate (`UV1` è spento) e
 *  forzarle trascina dentro i varying della catena texture.
 *
 *  ⚠️ Un attributo assente non è un errore: WebGL lo legge come `(0,0,0,1)`,
 *  quindi peso zero, quindi nessuna battuta. È il motivo per cui questo canale
 *  può stare sullo stesso materiale di specie che non sanno nulla di ali. */
export const CEL_FLAP_ATTRIBUTE = 'celFlapData';

/** Il dato per-vertice del BECCHEGGIO: `x` marca il corpo e ne dice il posto
 *  lungo l'asse, `y` è la fase di quel corpo.
 *
 *  ⚠️ La marcatura e il posto stanno nello STESSO numero, e non è avarizia: un
 *  vertice che non porta l'attributo legge **zero**, e zero dev'essere «non
 *  galleggia». Se `x` fosse il solo posto lungo l'asse, zero sarebbe «a metà
 *  nave» — cioè tutta la scena beccheggerebbe, roccia e faro compresi. Quindi
 *  `x = 0` significa fermo e `x ∈ [1,2]` significa galleggiante, con
 *  `s = (x − 1,5)·2` in [−1,1] da poppa a prua. */
export const CEL_BOB_ATTRIBUTE = 'celBobData';

/** LA BATTUTA D'ALI — il moto attorno all'asse di un CORPO, non attorno a terra.
 *
 *  Il vento piega ciò che è piantato: pesa lo spostamento sulla quota sopra la
 *  BASE dell'istanza, perché il piede resta fermo. Un uccello non ha piede, e a
 *  undici metri d'altezza quella legge quadratica gli darebbe due metri di
 *  deriva laterale invece di una battuta.
 *
 *  Qui il peso è la distanza dall'**asse del corpo** e lo spostamento è
 *  VERTICALE: alla radice l'ala non si muove, in punta prende tutto. La fase è
 *  per individuo, e sta nei vertici (v. `CEL_FLAP_ATTRIBUTE`) perché uno stormo
 *  in fase è sette copie della stessa cosa.
 *
 *  ⚠️ Come il lampo, questo canale non chiede un materiale suo: chi non ha
 *  l'attributo ha peso zero. Il materiale separato serve semmai per togliere il
 *  VENTO, che su un uccello è il difetto. */
export interface CelFlapSpec {
    /** Spostamento verticale in metri all'estremità dell'ala. */
    amplitude: number;
    /** Battute al secondo. Un gabbiano che plana sta sotto 1; una sterna sopra. */
    hz: number;
}

/** IL BECCHEGGIO — il moto di ciò che GALLEGGIA, che è sussulto più beccheggio.
 *
 *  Vale per una nave, una boa, una barca ormeggiata: tutto ciò che sta sull'acqua
 *  e non è ancorato al fondo. Il vento non può descriverlo — pesa lo spostamento
 *  sulla quota sopra la base, quindi su un fumaiolo a nove metri piega la nave
 *  come un cespuglio (misurato sul faro: 9,9 m di traslazione) — e la battuta
 *  d'ali nemmeno, perché la sua legge è il quadrato della distanza dall'asse.
 *
 *  ⚠️ Come il lampo e la battuta, non chiede un materiale suo: chi non porta
 *  `CEL_BOB_ATTRIBUTE` sta fermo. È la ragione per cui una scena intera ha tre
 *  materiali e non dieci.
 *
 *  ⚠️ Le frequenze vere sono BASSE. Un traghetto di centoquaranta metri ha un
 *  periodo di sei-otto secondi, cioè attorno a **0,15 Hz**: sopra il mezzo hertz
 *  qualunque scafo diventa un tappo di sughero. */
export interface CelBobSpec {
    /** Sussulto: metri di sali-scendi di tutto il corpo. */
    amplitude: number;
    /** Oscillazioni al secondo. Un traghetto sta sotto 0,2; una boa più su. */
    hz: number;
    /** Beccheggio: metri di scarto alle estremità, in quadratura col sussulto.
     *  A zero il corpo fa l'ascensore. */
    pitch: number;
}

/** IL LAMPO — l'unico canale che NON muove geometria.
 *
 *  Ci sono oggetti la cui animazione non è un movimento: un faro non ondeggia,
 *  **si accende**. Vento e mareggiata non possono descriverlo, perché entrambi
 *  spostano vertici, e spostare un faro è esattamente il difetto da togliere.
 *
 *  ⚠️ LA MASCHERA È UN COLORE RISERVATO, e la strada che sembrava ovvia non
 *  esiste. L'alfa del colore per vertice pareva il canale perfetto — già
 *  trasportato, già fuso da `MergeMeshes`, gratis — ma **Babylon la butta via**:
 *  il suo vertex shader fa `vColor = vec4(1.0); vColor.rgb *= color.rgb;`, e
 *  l'alfa entra solo sotto `VERTEXALPHA`, che accende la trasparenza e
 *  trasformerebbe la lampada in un buco. Misurato leggendo il sorgente generato,
 *  2026-08-17.
 *
 *  Resta l'unico canale che arriva davvero al fragment: `vColor.rgb`. Un vertice
 *  il cui colore è ESATTAMENTE `key` è una lampada. Funziona senza epsilon
 *  larghi perché queste sono mesh flat-shaded e non indicizzate: i tre vertici
 *  di una faccia hanno lo stesso colore, quindi l'interpolatore non ha nulla da
 *  interpolare e il valore arriva intatto. Il prezzo è che quel colore è
 *  RISERVATO: chi lo usa per decorare accende una lampada per sbaglio.
 *
 *  ⚠️ Il RITMO è la firma. Un faro non respira con un seno: sta buio a lungo e
 *  poi lampeggia — «il ritmo dei lampi è la firma ottica del singolo faro». Per
 *  questo c'è `duty`: la frazione di ciclo in cui la luce è accesa. A `duty` 1
 *  questo canale diventa una pulsazione, che è un altro oggetto. */
export interface CelGlintSpec {
    /** Il colore della luce ACCESA. Il colore spento è quello del modello. */
    color: Color3;
    /** Il colore per vertice RISERVATO che marca una lampada (v. sopra). */
    key: Color3;
    /** Cicli al secondo. Un faro costiero sta fra 0,1 e 0,3. */
    hz: number;
    /** Frazione del ciclo in cui la luce è accesa, in [0,1]. Sotto ~0,25 legge
     *  come lampo; sopra ~0,6 come respiro. */
    duty: number;
    /** Quanto la luce accesa copre il colore del modello, in [0,1]. */
    strength: number;
}

/** Impostazioni condivise da TUTTE le istanze del plugin.
 *
 *  Sono globali perché il cel è una direzione artistica di scena, non una
 *  proprietà del singolo oggetto: con centinaia di materiali decor, una
 *  ritaratura per-materiale sarebbe un ciclo su centinaia di oggetti invece di
 *  una scrittura sola. Il per-materiale, se servirà, si aggiunge dopo. */
const settings: CelPluginSettings = { ...DEFAULT_CEL_PLUGIN };

/** Registrate qui e non lette da `settings` a ogni bind: cambiano di rado e
 *  ricostruirle a ogni frame significherebbe un lookup in cache per materiale
 *  per frame. */
let rampDirty = true;
let hatchDirty = true;

export function configureCelPlugin(patch: Partial<CelPluginSettings>): void {
    Object.assign(settings, patch);
    if (patch.ramp) rampDirty = true;
    if (patch.hatch) hatchDirty = true;
}

export function getCelPluginSettings(): Readonly<CelPluginSettings> {
    return settings;
}

// ── Codice GLSL iniettato ────────────────────────────────────────────────────
// Non riusa `CEL_FRAGMENT_FUNCTIONS` alla lettera: quelle funzioni partono da
// NdotL e da uniform proprie, qui si parte dalla luce già accumulata e dalle
// uniform dello StandardMaterial. La MATEMATICA è la stessa — ramp lookup, rim
// di fresnel, retino screen-space — ed è per questo che il look coincide.

// ⚠️ Le DEFINIZIONI non stanno dentro `#ifdef CEL`, e non è una svista.
//
// La sostituzione di `finalDiffuse` (sotto) è TESTUALE e incondizionata: una
// volta che il plugin è entrato nella catena di un materiale, quel testo resta
// nello shader per sempre. Babylon non toglie un plugin già attivato — spegnere
// `isEnabled` abbassa solo il define. Se anche le definizioni fossero dietro
// `#ifdef CEL`, un materiale acceso e poi SPENTO (cambio mondo cel→legacy,
// materiale che si tira fuori dal cel, hot quality-change) si ritroverebbe una
// chiamata a una funzione che non esiste più:
//
//   FRAGMENT SHADER ERROR: 'celQuantizeLight': no matching overloaded function
//
// e il materiale sparirebbe dalla scena. Definendola SEMPRE, e facendole
// restituire la luce intatta quando il cel è spento, il ramo spento è
// bit-identico a Babylon di serie e la transizione è sicura in entrambi i versi.
// ⚠️ I SAMPLER SI DICHIARANO QUI, e non fra le uniform del plugin. È misurato,
// non dedotto (2026-08-07): la stringa `fragment` di `getUniforms()` viene
// emessa dal manager al marcatore `ADDITIONAL_FRAGMENT_DECLARATION`, che esiste
// SOLO nell'include `defaultFragmentDeclaration` — il percorso SENZA uniform
// buffer. Dove gli UBO ci sono, Babylon include `defaultUboDeclaration`, che
// quel marcatore non lo ha: la stringa intera viene buttata via in silenzio.
//
// Le scalari sopravvivono perché stanno anche nella lista `ubo` (e da lì
// finiscono dentro `uniform Material { … }`); un sampler in un uniform buffer
// non ci può stare, quindi resterebbe non dichiarato — e uno shader che
// referenzia un identificatore inesistente non compila:
//
//   'celRampSampler' : undeclared identifier
//   'texture' : no matching overloaded function found
//   'rgb' : field selection requires structure, vector, ...
//
// cioè gli errori visti su A25, dove gli UBO sono attivi. Sul desktop non si
// riproducevano per un motivo che non ha nulla a che vedere col cel: lì Babylon
// mette `disableUniformBuffers = true`, quindi il percorso rotto non veniva mai
// preso. Riprodotto forzando `disableUniformBuffers = false` su Chrome.
//
// `CUSTOM_FRAGMENT_DEFINITIONS` invece vive in `default.fragment.fx` e non
// dipende dagli UBO: è l'unico posto che vale su entrambi i percorsi. Sta in
// testa a questo blocco perché le funzioni qui sotto lo usano.
const CEL_DEFINITIONS = /* glsl */ `
#ifdef CEL
uniform sampler2D celRampSampler;
uniform sampler2D celHatchSampler;
#endif

vec3 celQuantizeLight(vec3 lit) {
#ifdef CEL
    // Luminanza percettiva, non media aritmetica: con una chiave calda la media
    // sposterebbe la banda a seconda della TINTA della luce invece che della
    // sua intensità, e due superfici ugualmente illuminate cadrebbero in bande
    // diverse solo perché una è più rossa.
    float lum = dot(lit, vec3(0.299, 0.587, 0.114));
    return texture2D(celRampSampler, vec2(clamp(lum * celRampScale, 0.0, 1.0), 0.5)).rgb;
#else
    return lit;
#endif
}

#ifdef CEL
// IL RETINO VIVE NELLA BANDA PIÙ SCURA, E SOLO LÌ — v. celHatch nel percorso
// ShaderMaterial, dove la regola è la stessa riga per riga. rampU è la
// coordinata 0..1 PRIMA della quantizzazione; la prima banda finisce a
// 1/celRampBands, e la dissolvenza sull'ultimo 15% serve solo a non far
// scattare il confine di un pixel.
float celPluginHatch(vec2 fragCoord, float rampU) {
    if (celHatchStrength <= 0.0) return 1.0;
    float h = texture2D(celHatchSampler, fragCoord / max(celHatchScale, 1.0)).r;
    float edge = celRampBands > 0.5 ? 1.0 / celRampBands : 0.34;
    float mask = 1.0 - smoothstep(edge * 0.85, edge, rampU);
    return 1.0 - (1.0 - h) * mask * celHatchStrength;
}

float celPluginRim(vec3 n, vec3 v) {
    if (celRimStrength <= 0.0) return 0.0;
    float fres = 1.0 - clamp(dot(n, v), 0.0, 1.0);
    return smoothstep(1.0 - celRimWidth, 1.0, fres) * celRimStrength;
}
#endif
`;

/** Retino e rim: applicati al colore composto, ma PRIMA di nebbia e grade.
 *  Dopo la nebbia il retino comparirebbe anche sugli oggetti lontani già
 *  dissolti, e dopo il grade cambierebbe intensità con la saturazione.
 *
 *  ⚠️ IL RETINO GUARDA LA LUCE, NON IL COLORE — e fino alla 0.1.1 guardava il
 *  colore. La maschera riceveva `dot(color.rgb, ...)`, cioè la banda già
 *  moltiplicata per l'albedo, quindi il tratteggio seguiva la TINTA
 *  dell'oggetto invece della sua illuminazione: una pietra grigia in pieno sole
 *  veniva tratteggiata perché è grigia, una superficie bianca in ombra restava
 *  pulita perché è bianca, e una scena a tinte scure veniva tratteggiata da
 *  bordo a bordo. La prova che non era la luce: con la ramp forzata tutta
 *  bianca — nessuna ombra da nessuna parte — il retino restava.
 *
 *  Ora entra `celRampU`, la coordinata 0..1 sull'asse della rampa PRIMA della
 *  quantizzazione: la stessa che `celQuantizeLight` usa per scegliere la banda,
 *  ricalcolata qui con una moltiplicazione invece che con un secondo lookup in
 *  texture. È anche la ragione per cui il confine sta sulla COORDINATA e non
 *  sulla luminanza della banda: la tinta d'ombra è art-direction e cambia per
 *  livello, mentre l'indice di banda è lo stesso ovunque.
 *
 *  ⚠️ L'EMISSIVO ENTRA NELLA MASCHERA, e non è un dettaglio: **una cosa che
 *  emette luce non è in ombra**. La luce ricevuta e la luce propria sono due
 *  cose diverse solo per il calcolo del colore; per il retino sono la stessa,
 *  perché la domanda che deve porsi è «questa superficie è al buio?». Senza
 *  questo termine un oggetto autoilluminato riceve zero, cade nella prima banda
 *  e si prende il tratteggio pieno: misurato su un'app consumer, le bolle da
 *  raccogliere — che brillano — sono uscite tratteggiate, mentre nella 0.1.1
 *  erano pulite, perché lì la maschera guardava il colore finito e un oggetto
 *  luminoso usciva chiaro. La regola nuova ha risolto un difetto e ne ha creato
 *  un altro finché l'emissivo non è stato sommato qui.
 *
 *  Nelle varianti `EMISSIVEASILLUMINATION` e `LINKEMISSIVEWITHDIFFUSE`
 *  l'emissivo è già dentro `diffuseBase` e viene contato due volte: sposta la
 *  maschera solo verso «più illuminato», cioè verso meno retino, che è il verso
 *  in cui sbagliare non rovina niente.
 *
 *  ⚠️ `diffuseBase` ed `emissiveColor` sono dichiarate SENZA guardia in
 *  `default.fragment.fx`, prima del marcatore su cui si innesta questo blocco,
 *  quindi sono sempre in scope. */
const CEL_BEFORE_FOG = /* glsl */ `
#ifdef CEL
{
    float celRampU = clamp(dot(diffuseBase + emissiveColor, vec3(0.299, 0.587, 0.114)) * celRampScale, 0.0, 1.0);
    color.rgb *= celPluginHatch(gl_FragCoord.xy, celRampU);
    color.rgb = mix(color.rgb, celInkColor, celPluginRim(normalW, viewDirectionW));
}
#endif
`;

// IL LAMPO, DOPO retino e rim e non prima: una sorgente di luce non si tratteggia
// e non prende il tratto d'inchiostro sul bordo. Applicarlo prima significherebbe
// disegnare l'ombreggiatura di una lampada accesa.
//
// La maschera vive nell'ALFA del colore per vertice (v. `CelGlintSpec`): alfa 0
// = lampada, alfa 1 = tutto il resto. Serve `VERTEXCOLOR`, perché senza colore
// per vertice non c'è nessuna alfa da leggere — e senza quella guardia lo shader
// non compilerebbe sui materiali a tinta unita.
const CEL_GLINT_BEFORE_FOG = /* glsl */ `
#if defined(CELGLINT) && defined(VERTEXCOLOR)
{
    // Soglia stretta di proposito: su mesh flat-shaded non indicizzate il colore
    // di una faccia arriva identico a com'è stato scritto, quindi una soglia
    // larga servirebbe solo ad accendere per sbaglio qualcosa di simile.
    float celGlintM = step(distance(vColor.rgb, celGlintKey), 0.004);
    color.rgb = mix(color.rgb, celGlint.rgb, celGlintM * celGlint.w);
}
#endif
`;

// ── Il vento, nel vertex shader ──────────────────────────────────────────────
//
// Si aggancia a `CUSTOM_VERTEX_UPDATE_WORLDPOS`, che è l'unico punto giusto: lì
// `worldPos` è già stato calcolato e `finalWorld` è in scope, quindi si può
// piegare la geometria negli assi del MONDO — tutte le istanze nella stessa
// direzione, che è ciò che distingue il vento dal tremolio — e prendere la base
// dell'istanza da `finalWorld[3]` senza sapere se si è sotto istanziamento
// hardware, thin instance o mesh piena. Un piano prima (`UPDATE_POSITION`) si
// avrebbe solo lo spazio locale, e un campo di piante ruotate a caso si
// piegherebbe a raggiera.
//
// La FASE viene dalla posizione dell'istanza, non da quella del vertice: così
// ogni pianta oscilla per conto suo (un campo in fase è un metronomo) ma resta
// RIGIDA in sé, senza deformarsi al proprio interno.
const CEL_WIND_WORLDPOS = /* glsl */ `
#ifdef CELWIND
{
    vec3 celWindBase = finalWorld[3].xyz;
    float celWindH = max(worldPos.y - celWindBase.y, 0.0);
    // Peso quadratico sulla quota, normalizzato alla quota di riferimento: il
    // piede resta inchiodato, la punta prende tutto.
    float celWindW = celWindH * celWindH * celWind.w;
    float celWindPh = celWindTime * celWind.z + celWindBase.x * 0.37 + celWindBase.z * 0.23;
    // Le RAFFICHE: un secondo seno lentissimo che apre e chiude l'ampiezza. Senza
    // di lui il campo respira all'infinito allo stesso ritmo, che a schermo è
    // più finto dell'immobilità.
    float celWindG = 0.55 + 0.45 * sin(celWindPh * 0.31);
    worldPos.xz += celWind.xy * (sin(celWindPh) * celWindG * celWindW);
}
#endif
`;

// LA MAREGGIATA, nello stesso punto d'iniezione del vento e per la stessa
// ragione: `UPDATE_WORLDPOS` è dopo la trasformata di mondo, quindi vale per
// qualunque cosa — mesh piena, istanza hardware, thin instance.
//
// ⚠️ Nessun termine di posizione nella fase, ed è tutta la differenza con il
// vento: la fase arriva dall'uniform e basta, quindi ogni istanza si sposta
// nello stesso verso e nello stesso istante. Aggiungere qui un termine da
// `finalWorld` significherebbe riscrivere il vento con un altro nome.
const CEL_SURGE_WORLDPOS = /* glsl */ `
#ifdef CELSURGE
{
    worldPos.xz += celSurge.xy * sin(celSurge.z);
}
#endif
`;

// LA BATTUTA, nello stesso punto d'iniezione del vento e per la stessa ragione:
// `UPDATE_WORLDPOS` vale per qualunque cosa — mesh piena, istanza hardware, thin
// instance. Ma la LEGGE è opposta a quella del vento, ed è tutto il punto: il
// peso non viene dalla quota sopra la base dell'istanza, viene da un attributo
// che dice quanto quel vertice è lontano dall'asse del proprio corpo.
//
// Peso al QUADRATO come nel vento, e per la stessa ragione fisica: un'ala è
// incernierata alla spalla, quindi la radice non si muove e la punta prende
// tutto. Lineare, l'ala sembrerebbe un pezzo di gomma tirato.
const CEL_FLAP_WORLDPOS = /* glsl */ `
#ifdef CELFLAP
{
    float celFlapW = celFlapData.x * celFlapData.x;
    worldPos.y += celFlapArgs.x * celFlapW
        * sin(celFlapTime * celFlapArgs.y + celFlapData.y * 6.2831853);
}
#endif
`;

// IL BECCHEGGIO — non è una battuta lenta: sono DUE moti in quadratura.
//
// Un corpo che galleggia fa due cose insieme, e sono l'una il ritardo dell'altra:
// **sussulta** (tutto il corpo sale e scende, in fase con l'onda) e **beccheggia**
// (la prua sale mentre la poppa scende, cioè un moto proporzionale alla posizione
// lungo l'asse, in quadratura col primo). Sfasati di un quarto di periodo, i due
// insieme fanno il movimento circolare che l'occhio riconosce come «in mare».
//
// Con il solo sussulto una nave è un ascensore; col solo beccheggio è un'altalena
// inchiodata. È anche la ragione per cui questo non poteva essere `flap` con
// un'altra frequenza: là il peso è |distanza dall'asse| ed è al quadrato, qui è
// la posizione SEGNATA lungo l'asse e serve un secondo termine sfasato.
//
// Solo verticale, di proposito: un beccheggio vero ruota anche in z, ma su una
// sagoma d'orizzonte quella componente non si vede e costerebbe il doppio.
const CEL_BOB_WORLDPOS = /* glsl */ `
#ifdef CELBOB
{
    float celBobMark = step(0.5, celBobData.x);
    float celBobS = (celBobData.x - 1.5) * 2.0;
    float celBobPh = celBobTime * celBobArgs.y + celBobData.y * 6.2831853;
    worldPos.y += celBobMark * (celBobArgs.x * sin(celBobPh)
        + celBobArgs.z * celBobS * cos(celBobPh));
}
#endif
`;

/** Il tempo del vento, per scena.
 *
 *  ⚠️ Avanza una volta per FRAME e non a ogni bind: `bindForSubMesh` viene
 *  chiamata una volta per sub-mesh, quindi accumulando lì il delta il tempo
 *  scorrerebbe tanto più in fretta quanti più oggetti ci sono a schermo — cioè
 *  il vento diventerebbe una funzione della complessità della scena.
 *
 *  Il delta è cappato a 50 ms: dopo un blocco (cambio di livello, GC) un
 *  fotogramma da mezzo secondo farebbe SCATTARE tutto il campo di lato. */
const windClocks = new WeakMap<Scene, { frame: number; t: number }>();

function celWindTimeFor(scene: Scene): number {
    const frame = scene.getFrameId();
    let clock = windClocks.get(scene);
    if (!clock) { clock = { frame, t: 0 }; windClocks.set(scene, clock); }
    if (clock.frame !== frame) {
        clock.frame = frame;
        // Il modulo tiene il tempo dentro la precisione utile di un float a 32
        // bit: un'ora di partita porterebbe la fase a qualche migliaio di
        // radianti, e da lì in poi il seno si muove a scatti.
        clock.t = (clock.t + Math.min(scene.getEngine().getDeltaTime(), 50) / 1000) % 3600;
    }
    return clock.t;
}

class CelMaterialPlugin extends MaterialPluginBase {
    private _isEnabled = false;
    private _wind: CelWindSpec | null = null;
    private _surge: CelSurgeSpec | null = null;
    private _glint: CelGlintSpec | null = null;
    private _flap: CelFlapSpec | null = null;
    private _bob: CelBobSpec | null = null;

    constructor(material: Material) {
        // Priorità 200: dopo i plugin di Babylon (che stanno sotto 100), così
        // il cel vede il colore già composto da eventuali altri innesti.
        // ⚠️ I define vanno DICHIARATI qui, tutti. `prepareDefines` può solo
        // cambiare il valore di una chiave che esiste già: scriverne una non
        // dichiarata non produce nessun `#define`, e il blocco di shader che la
        // aspetta resta spento per sempre — senza un errore, senza un avviso, e
        // con il plugin che a ispezione sembra a posto (misurato il 2026-08-08:
        // il vento c'era nel plugin, non nello shader).
        super(material, 'Cel', 200, {
            CEL: false, CELWIND: false, CELSURGE: false, CELGLINT: false, CELFLAP: false,
            CELBOB: false,
        });
    }

    get isEnabled(): boolean {
        return this._isEnabled;
    }

    set isEnabled(enabled: boolean) {
        if (this._isEnabled === enabled) return;
        this._isEnabled = enabled;
        // Il define cambia la forma dello shader: senza questo, il materiale
        // continuerebbe a usare il programma compilato prima.
        this.markAllDefinesAsDirty();
        this._enable(enabled);
    }

    get wind(): CelWindSpec | null {
        return this._wind;
    }

    /** ⚠️ Il vento vive DENTRO il cel: senza il plugin acceso non c'è nessuno
     *  shader in cui iniettarlo. È coerente con ciò che serve — il vento è del
     *  look cel, non una funzione generica di Babylon — e tiene fuori la
     *  variante di shader da ogni materiale che non la usa. */
    set wind(spec: CelWindSpec | null) {
        this._wind = spec;
        this.markAllDefinesAsDirty();
    }

    get surge(): CelSurgeSpec | null {
        return this._surge;
    }

    /** ⚠️ L'oggetto viene TENUTO, non copiato: chi lo passa ne muta `phase` a
     *  ogni frame e il bind la rilegge. Copiarlo qui renderebbe la fase
     *  scrivibile una volta sola — cioè un'onda ferma. */
    set surge(spec: CelSurgeSpec | null) {
        this._surge = spec;
        this.markAllDefinesAsDirty();
    }

    get glint(): CelGlintSpec | null {
        return this._glint;
    }

    set glint(spec: CelGlintSpec | null) {
        const had = this._glint !== null;
        this._glint = spec;
        if (had !== (spec !== null)) this.markAllDefinesAsDirty();
    }

    get flap(): CelFlapSpec | null {
        return this._flap;
    }

    set flap(spec: CelFlapSpec | null) {
        const had = this._flap !== null;
        this._flap = spec;
        if (had !== (spec !== null)) this.markAllDefinesAsDirty();
    }

    get bob(): CelBobSpec | null {
        return this._bob;
    }

    set bob(spec: CelBobSpec | null) {
        const had = this._bob !== null;
        this._bob = spec;
        if (had !== (spec !== null)) this.markAllDefinesAsDirty();
    }

    override getClassName(): string {
        return 'CelMaterialPlugin';
    }

    override prepareDefines(defines: MaterialDefines): void {
        defines['CEL'] = this._isEnabled;
        defines['CELWIND'] = this._isEnabled && this._wind !== null;
        defines['CELSURGE'] = this._isEnabled && this._surge !== null;
        defines['CELGLINT'] = this._isEnabled && this._glint !== null;
        defines['CELFLAP'] = this._isEnabled && this._flap !== null;
        defines['CELBOB'] = this._isEnabled && this._bob !== null;
    }

    override getUniforms(): {
        ubo: { name: string; size: number; type: string }[]; vertex: string; fragment: string;
    } {
        return {
            ubo: [
                // Il vento sta nella lista `ubo` e non solo nella stringa vertex
                // per la stessa ragione delle altre: dove gli uniform buffer ci
                // sono, il blocco `Material` è LO STESSO nei due stadi, quindi
                // una dichiarazione sola serve vertex e fragment.
                { name: 'celWind', size: 4, type: 'vec4' },
                { name: 'celWindTime', size: 1, type: 'float' },
                { name: 'celSurge', size: 4, type: 'vec4' },
                // rgb = colore acceso, w = quanto è acceso ORA: il lampo si
                // calcola su CPU una volta per bind invece che per fragment.
                { name: 'celGlint', size: 4, type: 'vec4' },
                { name: 'celGlintKey', size: 3, type: 'vec3' },
                { name: 'celFlapArgs', size: 2, type: 'vec2' },
                { name: 'celFlapTime', size: 1, type: 'float' },
                { name: 'celBobArgs', size: 3, type: 'vec3' },
                { name: 'celBobTime', size: 1, type: 'float' },
                { name: 'celRampScale', size: 1, type: 'float' },
                { name: 'celRimStrength', size: 1, type: 'float' },
                { name: 'celRimWidth', size: 1, type: 'float' },
                { name: 'celHatchStrength', size: 1, type: 'float' },
                { name: 'celHatchScale', size: 1, type: 'float' },
                { name: 'celRampBands', size: 1, type: 'float' },
                { name: 'celInkColor', size: 3, type: 'vec3' },
            ],
            // Le uniform SCALARI compaiono sia qui sia nella `ubo` sopra, e le
            // due copie non si pestano i piedi perché Babylon ne emette
            // esattamente una: dove gli uniform buffer ci sono vale la lista
            // `ubo` (dentro `uniform Material { … }`) e questa stringa viene
            // scartata; dove non ci sono vale questa.
            //
            // ⚠️ I SAMPLER NON VANNO QUI — proprio perché questa stringa sparisce
            // sul percorso UBO, e un sampler non ha la lista `ubo` a fargli da
            // rete. Stanno in `CEL_DEFINITIONS`; il perché, per esteso, è nel
            // commento sopra quel blocco.
            // Il percorso SENZA uniform buffer: qui il vertex ha bisogno della
            // propria dichiarazione, e senza questa riga lo shader non compila
            // esattamente sui device che non hanno gli UBO — cioè si romperebbe
            // dove non si guarda mai.
            vertex: `#ifdef CELWIND
                uniform vec4 celWind;
                uniform float celWindTime;
            #endif
            #ifdef CELSURGE
                uniform vec4 celSurge;
            #endif
            #ifdef CELFLAP
                uniform vec2 celFlapArgs;
                uniform float celFlapTime;
            #endif
            #ifdef CELBOB
                uniform vec3 celBobArgs;
                uniform float celBobTime;
            #endif`,
            fragment: `#ifdef CELGLINT
                uniform vec4 celGlint;
                uniform vec3 celGlintKey;
            #endif
            #ifdef CEL
                uniform float celRampScale;
                uniform float celRimStrength;
                uniform float celRimWidth;
                uniform float celHatchStrength;
                uniform float celHatchScale;
                uniform float celRampBands;
                uniform vec3 celInkColor;
            #endif`,
        };
    }

    /** ⚠️ Sempre, non solo col canale acceso: Babylon raccoglie gli attributi
     *  quando compila, e una mesh che non ha questo buffer semplicemente legge
     *  zero. Chiederlo condizionatamente vorrebbe dire ricompilare il programma
     *  la prima volta che qualcuno accende la battuta. */
    override getAttributes(attributes: string[]): void {
        attributes.push(CEL_FLAP_ATTRIBUTE, CEL_BOB_ATTRIBUTE);
    }

    override getSamplers(samplers: string[]): void {
        samplers.push('celRampSampler', 'celHatchSampler');
    }

    override bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene): void {
        if (!this._isEnabled) return;
        const w = this._wind;
        if (w) {
            const len = Math.hypot(w.dirX, w.dirZ) || 1;
            const h = Math.max(w.height, 0.01);
            uniformBuffer.updateFloat4('celWind',
                (w.dirX / len) * w.amplitude, (w.dirZ / len) * w.amplitude,
                w.hz * Math.PI * 2, 1 / (h * h));
            uniformBuffer.updateFloat('celWindTime', celWindTimeFor(scene));
        }
        const sg = this._surge;
        if (sg) {
            const slen = Math.hypot(sg.dirX, sg.dirZ) || 1;
            uniformBuffer.updateFloat4('celSurge',
                (sg.dirX / slen) * sg.amplitude, (sg.dirZ / slen) * sg.amplitude,
                sg.phase, 0);
        }
        const gl = this._glint;
        if (gl) {
            // Il lampo si calcola QUI e non nel fragment: è una funzione del solo
            // tempo, quindi calcolarla per pixel vorrebbe dire ricavare lo stesso
            // numero un milione di volte per fotogramma.
            //
            // Dentro la finestra accesa è un seno intero, non un gradino: una
            // lente che ruota porta il fascio dentro e fuori dallo sguardo, e uno
            // stacco netto legge come un interruttore. Fuori dalla finestra è
            // zero PIENO, ed è quello a fare il lampo invece del respiro.
            const duty = Math.min(0.95, Math.max(0.02, gl.duty));
            const ph = (celWindTimeFor(scene) * gl.hz) % 1;
            const lit = ph < duty ? Math.sin((ph / duty) * Math.PI) : 0;
            uniformBuffer.updateFloat4('celGlint',
                gl.color.r, gl.color.g, gl.color.b,
                lit * Math.min(1, Math.max(0, gl.strength)));
            uniformBuffer.updateColor3('celGlintKey', gl.key);
        }
        const fl = this._flap;
        if (fl) {
            uniformBuffer.updateFloat2('celFlapArgs', fl.amplitude, fl.hz * Math.PI * 2);
            uniformBuffer.updateFloat('celFlapTime', celWindTimeFor(scene));
        }
        const bo = this._bob;
        if (bo) {
            uniformBuffer.updateFloat3('celBobArgs',
                bo.amplitude, bo.hz * Math.PI * 2, bo.pitch);
            // Lo stesso orologio di scena degli altri canali: un mare che sale
            // con un tempo suo e una schiuma che avanza con un altro sono due
            // mari, e si vede al primo fotogramma in cui divergono.
            uniformBuffer.updateFloat('celBobTime', celWindTimeFor(scene));
        }
        uniformBuffer.updateFloat('celRampScale', settings.rampScale);
        uniformBuffer.updateFloat('celRimStrength', settings.rimStrength);
        uniformBuffer.updateFloat('celRimWidth', settings.rimWidth);
        uniformBuffer.updateFloat('celHatchStrength', settings.hatchStrength);
        uniformBuffer.updateFloat('celHatchScale', settings.hatchScale);
        // I gradini viaggiano anche come scalare: dentro la texture della ramp
        // sono già cotti, e il retino ha bisogno di sapere DOVE finisce la banda
        // d'ombra, non di che colore è.
        uniformBuffer.updateFloat('celRampBands', settings.ramp.bands);
        uniformBuffer.updateColor3('celInkColor', settings.inkColor);
        // Le texture vanno legate a ogni bind (il sampler è per-effect), ma il
        // lookup in cache è O(1) e le due `getCel*` non ricostruiscono nulla se
        // la combinazione di parametri è già stata generata.
        uniformBuffer.setTexture('celRampSampler', getCelRamp(scene, settings.ramp));
        uniformBuffer.setTexture('celHatchSampler', getCelHatch(scene, settings.hatch));
    }

    override getCustomCode(shaderType: string): Nullable<{ [name: string]: string }> {
        // ⚠️ SEMPRE, anche senza vento — è il define a decidere, non questo
        // ritorno. Babylon raccoglie i punti d'iniezione UNA VOLTA, quando il
        // plugin viene agganciato al materiale (`_addPlugin`), e il plugin nasce
        // insieme al materiale, cioè prima che qualcuno gli dia un vento:
        // ritornare `null` qui vorrebbe dire che `CUSTOM_VERTEX_UPDATE_WORLDPOS`
        // non viene mai registrato, e il vento acceso dopo non comparirebbe MAI.
        // Costa una `#ifdef` spenta in un blocco di testo che il preprocessore
        // butta via.
        if (shaderType === 'vertex') {
            // I due blocchi nello STESSO punto d'iniezione: Babylon ne accetta
            // uno solo per chiave, quindi si concatenano. I due `#ifdef` li
            // tengono indipendenti — un materiale può avere vento, mareggiata,
            // entrambi o nessuno.
            return {
                CUSTOM_VERTEX_DEFINITIONS: `#ifdef CELFLAP
                    attribute vec2 ${CEL_FLAP_ATTRIBUTE};
                #endif
                #ifdef CELBOB
                    attribute vec2 ${CEL_BOB_ATTRIBUTE};
                #endif`,
                CUSTOM_VERTEX_UPDATE_WORLDPOS: CEL_WIND_WORLDPOS + CEL_SURGE_WORLDPOS
                    + CEL_FLAP_WORLDPOS + CEL_BOB_WORLDPOS,
            };
        }
        if (shaderType !== 'fragment') return null;
        return {
            CUSTOM_FRAGMENT_DEFINITIONS: CEL_DEFINITIONS,
            // Due blocchi nello stesso punto d'iniezione, concatenati per la
            // stessa ragione dei due del vertex: Babylon ne accetta uno solo
            // per chiave, e i rispettivi `#ifdef` li tengono indipendenti.
            CUSTOM_FRAGMENT_BEFORE_FOG: CEL_BEFORE_FOG + CEL_GLINT_BEFORE_FOG,
            // Le due sostituzioni che portano le bande sulla LUCE. Coprono tutte
            // e tre le varianti di `finalDiffuse` presenti nel sorgente, e
            // nessun altro uso di `diffuseBase` (dichiarazione, accumulo luci,
            // fresnel diffuso) corrisponde a questi pattern.
            '!diffuseBase\\*diffuseColor': 'celQuantizeLight(diffuseBase)*diffuseColor',
            '!\\(diffuseBase\\+emissiveColor\\)': '(celQuantizeLight(diffuseBase)+emissiveColor)',
        };
    }
}

// ── Registrazione globale ────────────────────────────────────────────────────

const PLUGIN_NAME = 'Cel';

/** SOLO StandardMaterial.
 *
 *  I punti d'innesto sono specifici del suo shader: `diffuseBase` e le tre
 *  varianti di `finalDiffuse`. Il PBR compone la luce in tutt'altro modo, quindi
 *  lì i pattern non trovano nulla — il codice viene iniettato senza agganciarsi
 *  e la compilazione fallisce, spegnendo il materiale. Succede in silenzio fino
 *  al primo oggetto PBR a schermo.
 *
 *  Non è una rinuncia: il decoro, cioè i 103 call site che questa migrazione
 *  converte per primi, è tutto StandardMaterial. Gli oggetti PBR — ostacoli,
 *  bolla, skin — sono lavoro degli sprint successivi e vanno convertiti con
 *  scelte proprie, non travolti da una registrazione globale.
 *
 *  Riconosciuto per nome di classe e non con `instanceof` per non trascinare
 *  `StandardMaterial` in un import di valore: questo modulo si carica al boot. */
function isCelTarget(material: Material): boolean {
    return material.getClassName() === 'StandardMaterial';
}

let globallyEnabled = false;

/** Materiali che si sono tirati FUORI dal cel per scelta d'autore.
 *
 *  ⚠️ Serve perché l'accensione globale è RIPETUTA, non una tantum: chi decide
 *  il linguaggio del mondo la richiama a ogni ingresso di scena e a ogni
 *  ri-render del componente che la ospita, e ogni passata itera tutti i
 *  materiali vivi rimettendoli su `enabled`. Un materiale escluso una volta si
 *  ritrovava il cel riacceso al primo re-render successivo — e il sintomo era
 *  il più insidioso possibile: l'esclusione FUNZIONAVA, per qualche frame.
 *
 *  Con questo insieme l'esclusione è una proprietà del materiale e non un
 *  evento nel tempo, quindi sopravvive a tutte le riaccensioni. */
const optedOut = new WeakSet<Material>();

/** Aggancia il plugin a OGNI materiale creato da qui in avanti (e a quelli già
 *  esistenti). Il plugin nasce spento: accenderlo è `setCelPluginEnabled`.
 *
 *  Va chiamata prima che i materiali vengano costruiti — `RegisterMaterialPlugin`
 *  non retrofitta quelli già istanziati — e di nuovo dopo la sostituzione di un
 *  engine, perché Babylon azzera allora le registrazioni globali. */
export function registerCelPlugin(): void {
    // Babylon svuota TUTTE le registrazioni globali quando viene disposto
    // l'ultimo engine (`EngineStore.OnEnginesDisposedObservable`). Storybook
    // ricrea l'engine a ogni cambio storia: tenere qui un nostro booleano
    // `registered` lasciava quindi il modulo convinto che il plugin esistesse
    // ancora, mentre Babylon l'aveva già rimosso. Dal secondo banco in poi i
    // nuovi StandardMaterial nascevano senza plugin e apparivano molto scuri.
    //
    // `RegisterMaterialPlugin` è già idempotente per nome: se la registrazione
    // esiste ne aggiorna la factory, altrimenti la ricrea. Richiamarlo è dunque
    // sia sicuro nel gioco sia necessario dopo il dispose di un engine.
    RegisterMaterialPlugin(PLUGIN_NAME, (material) => {
        // Solo Standard e PBR. La registrazione globale di Babylon offre il
        // plugin a OGNI materiale, ma altrove è fuori posto o rotto:
        //  · su uno ShaderMaterial (il CelMaterial del prototipo, il cielo a
        //    fasce) il cel è già dentro lo shader, e Babylon rifiuta comunque
        //    l'innesto con un'eccezione sulla lingua dello shader;
        //  · su un materiale di sistema (guscio, post-process) non ha senso.
        // Filtrare qui è più sicuro che ricordarsene a ogni chiamante.
        if (!isCelTarget(material)) return null;
        const plugin = new CelMaterialPlugin(material);
        plugin.isEnabled = globallyEnabled;
        return plugin;
    });
}

/** Accende/spegne il cel su tutti i materiali di una scena.
 *
 *  Serve la scena perché l'accensione deve raggiungere i materiali GIÀ creati:
 *  il valore globale copre solo quelli futuri. Il costo è una ricompilazione
 *  degli shader toccati — accettabile a un cambio di mondo, non per frame. */
/** Sottoscrizione che tiene scongelati i materiali cel creati DOPO
 *  l'accensione.
 *
 *  Una passata sola non basta: il cel si accende all'ingresso del mondo, mentre
 *  i master del decoro nascono più tardi nello stesso frame e si congelano
 *  subito dopo la costruzione. Senza questa sottoscrizione resterebbero
 *  congelati — e un materiale congelato non carica le uniform del cel.
 *
 *  Lo scongelamento è rimandato al frame successivo di proposito: `freeze()`
 *  viene chiamato dalle factory SUBITO dopo la creazione, quindi agire
 *  nell'observable di creazione verrebbe annullato un'istruzione dopo. */
let unfreezeSub: Nullable<() => void> = null;

function keepCelMaterialsThawed(scene: Scene): () => void {
    const pending: Material[] = [];
    const onNew = scene.onNewMaterialAddedObservable.add((material) => {
        if (isCelTarget(material)) pending.push(material);
    });
    const onFrame = scene.onBeforeRenderObservable.add(() => {
        if (pending.length === 0) return;
        // Sotto la leva di misura `celFreezeMaterials` lo scongelamento va
        // saltato, o annullerebbe esattamente ciò che la leva vuole misurare.
        if (!shouldFreezeUnderCel()) {
            for (const m of pending) m.unfreeze();
        }
        pending.length = 0;
    });
    return () => {
        scene.onNewMaterialAddedObservable.remove(onNew);
        scene.onBeforeRenderObservable.remove(onFrame);
    };
}

export function setCelPluginEnabled(scene: Nullable<Scene>, enabled: boolean): void {
    globallyEnabled = enabled;
    if (!scene) return;

    unfreezeSub?.();
    unfreezeSub = enabled ? keepCelMaterialsThawed(scene) : null;

    for (const material of scene.materials) {
        const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
        if (!plugin) continue;
        // Chi si è escluso resta escluso: l'accensione globale non lo tocca.
        if (enabled && optedOut.has(material)) continue;
        // Scongelare è OBBLIGATORIO, non un'ottimizzazione mancata.
        //
        // Un materiale congelato non ricarica le uniform, e le uniform del cel
        // si caricano in `bindForSubMesh`: restano a zero, la ramp viene
        // campionata a t=0 e ogni superficie esce nella banda più scura. Il
        // sintomo è una scena uniformemente buia che non reagisce a NESSUNA
        // taratura — somiglia a un errore di calibrazione e non lo è.
        //
        // Va fatto QUI e non nei singoli costruttori: il congelamento arriva da
        // una dozzina di factory di modelli sparse, e inseguirle una per una
        // sarebbe esattamente il lavoro per-call-site che il plugin esiste per
        // evitare. Il costo (niente re-bind saltato) è una delle voci che il
        // gate perf deve misurare.
        if (enabled && !shouldFreezeUnderCel()) material.unfreeze();
        plugin.isEnabled = enabled;
    }
}

/** Il plugin è attivo su questo materiale? Diagnostico per il lab. */
export function isCelPluginEnabledOn(material: Material): boolean {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    return plugin?.isEnabled ?? false;
}

/** Accende il cel su UN materiale soltanto. È la leva che serve al lab per
 *  affiancare cel e non-cel nello stesso fotogramma.
 *
 *  ⚠️ È TRANSITORIA: la prossima accensione globale la sovrascrive. Per tenere
 *  un materiale fuori dal cel in modo stabile serve `excludeFromCel`. */
export function setCelPluginOn(material: Material, enabled: boolean): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.isEnabled = enabled;
}

/** Dà (o toglie) il VENTO a un materiale.
 *
 *  Va chiamata sui materiali dello SCENARIO — la vegetazione, i props,
 *  le fasce di fondo — e non su terreno o geometria che collide:
 *   · le superfici di terreno sono continue, e piegarne i vertici
 *     aprirebbe fessure ai giunti fra un tile e l'altro;
 *   · la geometria che collide ha di solito un moto proprio calcolato dalla CPU
 *     (`celIdleMotion` nel gioco), che è dove deve stare — quello è legato al
 *     collider, questo no.
 *
 *  ⚠️ Il vento sposta la SUPERFICIE, non il collider e non il G-buffer: quello
 *  che si muove non cambia dove si muore (ed è giusto: è decoro) e non porta con
 *  sé il tratto d'inchiostro (v. la nota su `CelWindSpec`). */
export function setCelWind(material: Material, spec: CelWindSpec | null): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.wind = spec;
}

/** Accende la MAREGGIATA su un materiale. L'oggetto passato resta del
 *  chiamante, che ne muta `phase` a ogni frame (v. `CelSurgeSpec`). */
export function setCelSurge(material: Material, spec: CelSurgeSpec | null): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.surge = spec;
}

/** Tira un materiale FUORI dal cel in modo permanente.
 *
 *  È la forma da usare per le scelte d'autore — un personaggio che
 *  deve restare fotografica, o il cielo, che è disegno e non superficie
 *  illuminata. A differenza di `setCelPluginOn` sopravvive alle accensioni
 *  globali successive. */
/** Accende il canale del LAMPO su questo materiale, o lo spegne con `null`.
 *
 *  Il ritmo lo tiene il plugin, sull'orologio di scena del vento: un faro non ha
 *  bisogno che qualcuno gli scriva la fase ogni frame, e un secondo orologio
 *  divergerebbe dal primo. Chi invece HA già una fase propria usa la mareggiata.
 *
 *  ⚠️ Non fa nulla di visibile finché qualche vertice non è marcato con **alfa 0**
 *  (v. `CelGlintSpec`): il materiale può disegnare cento specie e accenderne una
 *  sola, che è il motivo per cui questo canale non chiede un materiale a parte. */
export function setCelGlint(material: Material, spec: CelGlintSpec | null): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.glint = spec;
}

/** Accende la BATTUTA D'ALI su questo materiale, o la spegne con `null`.
 *
 *  Non fa nulla di visibile finché i vertici non portano `CEL_FLAP_ATTRIBUTE`
 *  (peso dall'asse del corpo e fase dell'individuo): il materiale può disegnare
 *  cento specie e far battere solo quella marcata. */
export function setCelFlap(material: Material, spec: CelFlapSpec | null): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.flap = spec;
}

/** Accende il BECCHEGGIO su questo materiale, o lo spegne con `null`.
 *
 *  Non fa nulla di visibile finché i vertici non portano `CEL_BOB_ATTRIBUTE`
 *  (marcatura+posto lungo l'asse, e fase del corpo): il materiale può disegnare
 *  cento specie e far galleggiare solo quella marcata. */
export function setCelBob(material: Material, spec: CelBobSpec | null): void {
    const plugin = material.pluginManager?.getPlugin(PLUGIN_NAME) as CelMaterialPlugin | null;
    if (plugin) plugin.bob = spec;
}

export function excludeFromCel(material: Material): void {
    optedOut.add(material);
    setCelPluginOn(material, false);
}

/** Segnala se ramp o retino sono cambiati dall'ultima lettura — il chiamante
 *  può usarlo per evitare ricostruzioni inutili. */
export function consumeCelTextureDirty(): { ramp: boolean; hatch: boolean } {
    const out = { ramp: rampDirty, hatch: hatchDirty };
    rampDirty = false;
    hatchDirty = false;
    return out;
}

/** Il tipo è esportato solo per i test/lab: il gioco non deve istanziarlo a
 *  mano, ci pensa `registerCelPlugin`. */
export type { CelMaterialPlugin };

// `AbstractEngine`, `AbstractMesh` e `SubMesh` restano importati come tipo per
// documentare le firme sovrascritte anche dove non le usiamo tutte.
export type CelPluginBindArgs = [UniformBuffer, Scene, AbstractEngine, SubMesh, AbstractMesh];
