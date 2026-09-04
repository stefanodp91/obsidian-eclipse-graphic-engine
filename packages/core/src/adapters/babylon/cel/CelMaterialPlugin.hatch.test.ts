// Il retino segue la LUCE, non il colore — l'invariante che la 0.1.1 non aveva.
//
// Perché un test sul TESTO dello shader e non su un pixel: il difetto non era
// un valore sbagliato ma un ARGOMENTO sbagliato — la maschera riceveva
// `dot(color.rgb, ...)`, cioè la banda già moltiplicata per l'albedo, invece
// della banda. A schermo non somigliava a un bug: somigliava a un retino un po'
// invadente, e su un mondo a tinte scure copriva tutto restando plausibile.
// Nessuna soglia su un'immagine lo avrebbe distinto da una scelta d'autore,
// mentre il testo iniettato dice esattamente cosa entra nella maschera.
//
// ⚠️ La coppia di asserzioni è volutamente doppia: quella positiva pinna la
// forma giusta, quella negativa vieta il ritorno alla vecchia — riscrivere
// l'espressione in un altro modo corretto fa fallire solo la prima, e chi la
// aggiorna deve guardare anche la seconda.
import { NullEngine, Scene, StandardMaterial } from '@babylonjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { registerCelPlugin } from './CelMaterialPlugin';

const owned: Scene[] = [];

afterEach(() => {
    for (const scene of owned.splice(0)) scene.getEngine().dispose();
});

function fragmentCode(): Record<string, string> {
    registerCelPlugin();
    const scene = new Scene(new NullEngine());
    owned.push(scene);
    const material = new StandardMaterial('cel-hatch-probe', scene);
    const plugin = material.pluginManager?.getPlugin('Cel');
    expect(plugin, 'il plugin cel non si è agganciato allo StandardMaterial').toBeTruthy();
    const code = (plugin as unknown as {
        getCustomCode(shaderType: string): Record<string, string> | null;
    }).getCustomCode('fragment');
    expect(code).toBeTruthy();
    return code as Record<string, string>;
}

describe('maschera del retino', () => {
    it('riceve la coordinata di rampa della luce, non il colore finito', () => {
        const beforeFog = fragmentCode().CUSTOM_FRAGMENT_BEFORE_FOG ?? '';

        expect(beforeFog).toContain('dot(diffuseBase + emissiveColor, vec3(0.299, 0.587, 0.114)) * celRampScale');
        expect(beforeFog).toContain('celPluginHatch(gl_FragCoord.xy, celRampU)');
        expect(beforeFog).not.toContain('dot(color.rgb');
    });

    it('conta la luce PROPRIA come luce: una cosa che brilla non è in ombra', () => {
        // Senza l'emissivo un oggetto autoilluminato riceve zero luce, cade
        // nella prima banda e si prende il retino pieno. È successo davvero:
        // i pickup autoilluminati sono usciti tratteggiati.
        const beforeFog = fragmentCode().CUSTOM_FRAGMENT_BEFORE_FOG ?? '';

        expect(beforeFog).toContain('diffuseBase + emissiveColor');
    });

    it('confina il retino alla prima banda, invece di sfumare fino alla luce piena', () => {
        // La finestra 0.30-0.95 prendeva la banda media per circa un terzo, e
        // sotto l'impianto luci di un gioco vero metà del mondo ci cade dentro:
        // il tratteggio compariva su superfici che l'occhio legge come
        // illuminate. Il confine ora è la banda, non una soglia di luminanza.
        const definizioni = fragmentCode().CUSTOM_FRAGMENT_DEFINITIONS ?? '';

        expect(definizioni).toContain('1.0 / celRampBands');
        expect(definizioni).not.toContain('smoothstep(0.30, 0.95');
    });

    it('quantizza la luce con la stessa funzione che compone finalDiffuse', () => {
        // Se le due sostituzioni di `finalDiffuse` smettessero di passare per
        // `celQuantizeLight`, la maschera userebbe una banda che quel pixel non
        // usa: stessa funzione, stesso argomento, o non è la sua banda.
        const code = fragmentCode();
        const substitutions = Object.entries(code)
            .filter(([key]) => key.startsWith('!'))
            .map(([, value]) => value);

        expect(substitutions.length).toBeGreaterThan(0);
        for (const substitution of substitutions) {
            expect(substitution).toContain('celQuantizeLight(diffuseBase)');
        }
    });
});
