// Cel-shading — la matematica, come chunk GLSL condivisi.
//
// PERCHÉ STRINGHE E NON FILE .glsl: né il webpack del gioco né il Vite di
// storybook hanno un loader per shader, e aggiungerne uno significherebbe
// toccare due build config per un prototipo. Le stringhe attraversano entrambe
// le pipeline senza configurazione.
//
// PERCHÉ UN CHUNK SEPARATO DAL MATERIALE: il prototipo consuma questa matematica
// via ShaderMaterial (controllo totale, che è quello che serve per GIUDICARE il
// look). Se il look passa, la stessa identica stringa va iniettata in un
// MaterialPluginBase e le ~40 spec materiali del gioco ereditano il cel senza
// essere riscritte. Il chunk è il pezzo che rende economica quella migrazione:
// non va duplicato, va importato.
//
// Contratto: `CEL_FRAGMENT_FUNCTIONS` dichiara solo funzioni pure (nessuna
// uniform, nessuna varying). Chi lo include deve aver già dichiarato le uniform
// elencate in `CEL_FRAGMENT_UNIFORMS`.

/** Uniform richieste da `CEL_FRAGMENT_FUNCTIONS` + dal corpo del fragment.
 *  Dichiarate qui una volta sola così il materiale e il futuro plugin non
 *  divergono sui nomi. */
export const CEL_FRAGMENT_UNIFORMS = /* glsl */ `
uniform vec3  celBaseColor;
uniform vec3  celLightDirection;   // direzione DI PROPAGAZIONE della luce (dalla sorgente verso la scena)
uniform vec3  celLightColor;
uniform vec3  celAmbientSky;
uniform vec3  celAmbientGround;
uniform vec3  celInkColor;
uniform vec3  celSpecColor;
uniform vec3  celFogColor;
uniform vec3  celCameraPosition;
uniform float celRimStrength;
uniform float celRimWidth;
uniform float celSpecStrength;
uniform float celSpecPower;
uniform float celHatchStrength;
uniform float celHatchScale;
uniform float celRampBands;   // gradini della ramp: dice al retino dove finisce la banda d'ombra
uniform float celFogDensity;
uniform float celAlpha;
uniform sampler2D celRampSampler;
uniform sampler2D celHatchSampler;
`;

/** I termini del cel, uno per funzione.
 *
 *  VINCOLO WEBGPU — i sampler NON sono parametri di funzione ma riferimenti
 *  diretti alle uniform dichiarate sopra. Sotto WebGPU Babylon scompone
 *  `uniform sampler2D x` in una texture e un sampler separati e li ricombina
 *  nel punto d'uso; passare il combinato a una funzione fa fallire la
 *  compilazione in SPIR-V con «sampler constructor must appear at point of use»,
 *  mentre in WebGL2 lo stesso codice compila senza un fiato. Il gioco forza
 *  WebGL2 e lo storybook gira in WebGPU: entrambi devono compilare, quindi la
 *  regola vale sempre, anche dove sembra funzionare.
 *
 *  Il resto degli input resta esplicito, così la migrazione a MaterialPluginBase
 *  potrà chiamare gli stessi termini nello stesso ordine dentro un contesto
 *  shader diverso. */
export const CEL_FRAGMENT_FUNCTIONS = /* glsl */ `
// ── Banda di luce ────────────────────────────────────────────────────────────
// Il cuore del cel. NdotL non modula il colore in modo continuo: sceglie una
// BANDA in una ramp texture. La ramp porta sia il numero di gradini sia la loro
// tinta (l'ombra di Borderlands non è il diffuse scurito, è più fredda e più
// satura), quindi tutta l'art-direction dello shading vive in una texture 256x1
// tarabile a runtime invece che in costanti sparse nello shader.
//
// half-lambert (ndl*0.5+0.5) invece di max(ndl,0): il lato in ombra riceve
// comunque una banda propria invece di collassare a nero piatto. È la stessa
// scelta di Valve su Team Fortress 2 ed è ciò che tiene leggibile la silhouette
// quando la chiave è dura.
vec3 celLightBand(vec3 normalW, vec3 lightDir) {
    float ndl = dot(normalW, -normalize(lightDir));
    float t   = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
    return texture2D(celRampSampler, vec2(t, 0.5)).rgb;
}

// La COORDINATA di rampa, cioè dove questo pixel cade sull'asse 0..1 prima che
// la ramp lo quantizzi. Serve al retino, che non deve sapere di che TINTA è la
// banda ma in QUALE banda si trova: le tinte sono art-direction e cambiano per
// livello, l'indice no.
float celRampCoord(vec3 normalW, vec3 lightDir) {
    float ndl = dot(normalW, -normalize(lightDir));
    return clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
}

// ── Fill emisferico ──────────────────────────────────────────────────────────
// Il riempimento resta PIATTO (non bandizzato) di proposito: se anche l'ambient
// viene quantizzato, le due quantizzazioni battono l'una contro l'altra e
// compaiono gradini spuri sulle superfici quasi perpendicolari alla chiave.
vec3 celAmbient(vec3 normalW, vec3 sky, vec3 ground) {
    float up = normalW.y * 0.5 + 0.5;
    return mix(ground, sky, up);
}

// ── Specular a blob ──────────────────────────────────────────────────────────
// Anche la luce speculare va quantizzata, altrimenti è l'unico termine
// fotorealistico rimasto e tradisce il resto: un gradino netto produce la
// "macchia" di luce dei fumetti invece di un highlight morbido.
vec3 celSpecular(vec3 normalW, vec3 viewDir, vec3 lightDir, vec3 specColor, float strength, float power) {
    if (strength <= 0.0) return vec3(0.0);
    vec3  h    = normalize(-normalize(lightDir) + viewDir);
    float spec = pow(clamp(dot(normalW, h), 0.0, 1.0), power);
    return specColor * strength * step(0.5, spec);
}

// ── Rim d'inchiostro ─────────────────────────────────────────────────────────
// Non è il rim-light luminoso del PBR: qui il bordo va SCURITO verso il colore
// d'inchiostro. È il contorno "interno" — funziona sulle superfici curve dove
// un edge-detect di profondità non trova discontinuità e quindi non disegna
// nulla. I due meccanismi sono complementari, non alternativi.
float celInkRim(vec3 normalW, vec3 viewDir, float width, float strength) {
    if (strength <= 0.0) return 0.0;
    float fres = 1.0 - clamp(dot(normalW, viewDir), 0.0, 1.0);
    return smoothstep(1.0 - width, 1.0, fres) * strength;
}

// ── Tratteggio ───────────────────────────────────────────────────────────────
// Il pezzo che di solito viene dimenticato quando si imita Borderlands: senza
// tratteggio si ottiene un cel-shading pulito da cartone animato, non un
// disegno a penna. Campionato in SCREEN SPACE (come un retino da stampa) e
// applicato solo dove la luce è bassa: il tratto vive sulla carta, non sul
// modello, ed è esattamente questa incoerenza che lo fa leggere come disegnato.
// IL RETINO VIVE NELLA BANDA PIÙ SCURA, E SOLO LÌ.
//
// La finestra precedente (1 - smoothstep(0.30, 0.95, luminanza di banda))
// prendeva la banda scura piena, la media per circa un terzo e lasciava pulita
// solo la chiara — e sotto l'impianto luci di un gioco vero metà del mondo cade
// nella zona intermedia, quindi il tratteggio compariva su superfici che
// l'occhio legge come illuminate. Era una finestra tarata su una scena da
// laboratorio, dove la luce arriva da uniform a intensità 1.
//
// Ora il confine è la banda, non una soglia di luminanza: rampU è la
// coordinata 0..1 PRIMA della quantizzazione, e la prima banda finisce a
// 1/bands. Sotto quel confine il retino è pieno, sopra è zero, con una
// dissolvenza corta sull'ultimo 15% della banda che serve solo a non far
// scattare il bordo di un pixel.
//
// ⚠️ La coordinata e non la luminanza della banda: la tinta d'ombra è
// art-direction e cambia per livello (un consumer può dichiararne una per
// livello), quindi una soglia in luminanza si sposterebbe da un livello all'altro
// mentre l'indice di banda resta lo stesso ovunque.
//
// ⚠️ bands = 0 è la rampa CONTINUA del laboratorio, dove una «banda più
// scura» non esiste: lì vale il terzo inferiore dell'asse, che è la stessa
// frazione che una rampa a tre gradini darebbe.
float celHatchMask(float rampU, float bands) {
    float edge = bands > 0.5 ? 1.0 / bands : 0.34;
    return 1.0 - smoothstep(edge * 0.85, edge, rampU);
}

float celHatch(vec2 fragCoord, float rampU, float bands, float scale, float strength) {
    if (strength <= 0.0) return 1.0;
    float h    = texture2D(celHatchSampler, fragCoord / max(scale, 1.0)).r;
    return 1.0 - (1.0 - h) * celHatchMask(rampU, bands) * strength;
}

// ── Nebbia ───────────────────────────────────────────────────────────────────
// Fog proprio invece di quello di Babylon: ShaderMaterial non lega le uniform
// di scena vFogInfos/vFogColor, e legarle a mano richiederebbe un observer di
// bind per un termine che qui sono tre righe.
vec3 celFog(vec3 color, vec3 fogColor, float density, float dist) {
    if (density <= 0.0) return color;
    float f = 1.0 - clamp(exp(-density * density * dist * dist), 0.0, 1.0);
    return mix(color, fogColor, f);
}
`;

/** Corpo del fragment: compone i termini nell'ordine canonico. Estratto come
 *  costante separata perché è la parte che il plugin di migrazione dovrà
 *  ADATTARE (lì il colore base arriva dal materiale ospite, non da una uniform),
 *  mentre le funzioni sopra restano identiche. */
export const CEL_FRAGMENT_BODY = /* glsl */ `
    vec3 normalW = normalize(vNormalW);
    vec3 viewDir = normalize(celCameraPosition - vPositionW);

    vec3 albedo = celBaseColor;
#ifdef VERTEXCOLOR
    albedo *= vColor.rgb;
#endif

    vec3  band   = celLightBand(normalW, celLightDirection);
    vec3  fill   = celAmbient(normalW, celAmbientSky, celAmbientGround);
    vec3  spec   = celSpecular(normalW, viewDir, celLightDirection, celSpecColor, celSpecStrength, celSpecPower);
    float rampU  = celRampCoord(normalW, celLightDirection);
    float hatch  = celHatch(gl_FragCoord.xy, rampU, celRampBands, celHatchScale, celHatchStrength);
    float rim    = celInkRim(normalW, viewDir, celRimWidth, celRimStrength);

    vec3 color = albedo * (band * celLightColor + fill);
    color += spec;
    color *= hatch;
    color  = mix(color, celInkColor, rim);
    color  = celFog(color, celFogColor, celFogDensity, length(celCameraPosition - vPositionW));

    gl_FragColor = vec4(color, celAlpha);
`;

/** Vertex shader completo. `#include<instancesDeclaration>` / `<instancesVertex>`
 *  sono chunk di Babylon: passano dall'ShaderProcessor anche in uno
 *  ShaderMaterial, quindi l'hardware instancing continua a funzionare senza
 *  che il prototipo debba riscrivere il path di skinning delle istanze. */
export const CEL_VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
#ifdef UV1
attribute vec2 uv;
#endif
#ifdef VERTEXCOLOR
attribute vec4 color;
#endif

#include<instancesDeclaration>

uniform mat4 viewProjection;

varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;
#ifdef VERTEXCOLOR
varying vec4 vColor;
#endif

void main(void) {
    #include<instancesVertex>

    vec4 worldPos = finalWorld * vec4(position, 1.0);
    vPositionW = worldPos.xyz;
    // Inversa-trasposta omessa: gli asset del prototipo usano scale uniformi.
    // Con scale non uniformi le normali andrebbero storte — vincolo dichiarato,
    // non dimenticato.
    vNormalW = normalize(mat3(finalWorld) * normal);
#ifdef UV1
    vUV = uv;
#else
    vUV = vec2(0.0);
#endif
#ifdef VERTEXCOLOR
    vColor = color;
#endif
    gl_Position = viewProjection * worldPos;
}
`;

/** Fragment shader completo = uniform + funzioni + corpo. */
export const CEL_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;
#ifdef VERTEXCOLOR
varying vec4 vColor;
#endif

${CEL_FRAGMENT_UNIFORMS}
${CEL_FRAGMENT_FUNCTIONS}

void main(void) {
${CEL_FRAGMENT_BODY}
}
`;

/** Vertex shader del guscio invertito (candidato outline B). Estrude lungo la
 *  normale in spazio mondo. Vive qui e non nel file dell'outline perché
 *  condivide con il cel la stessa convenzione di instancing: se le due
 *  divergessero, il guscio scivolerebbe rispetto alla mesh sulle istanze. */
export const CEL_HULL_VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec3 normal;

#include<instancesDeclaration>

uniform mat4 viewProjection;
uniform float hullThickness;

void main(void) {
    #include<instancesVertex>

    vec3 nW = normalize(mat3(finalWorld) * normal);
    vec4 worldPos = finalWorld * vec4(position, 1.0);
    worldPos.xyz += nW * hullThickness;
    gl_Position = viewProjection * worldPos;
}
`;

/** Fragment del guscio: tinta unita, nessuna illuminazione. */
export const CEL_HULL_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform vec3 hullColor;
void main(void) {
    gl_FragColor = vec4(hullColor, 1.0);
}
`;
