// The hatching follows the LIGHT, not the color — the invariant 0.1.1 lacked.
//
// Why a test on the shader's TEXT and not on a pixel: the defect was not a wrong
// value but a wrong ARGUMENT — the mask received `dot(color.rgb, ...)`, i.e. the
// band already multiplied by the albedo, instead of the band. On screen it did
// not look like a bug: it looked like slightly overbearing hatching, and on a
// dark-toned world it covered everything while staying plausible. No threshold on
// an image would have told it apart from an authoring choice, whereas the
// injected text says exactly what enters the mask.
//
// ⚠️ The pair of assertions is deliberately double: the positive one pins the
// right form, the negative one forbids a return to the old one — rewriting the
// expression in another correct way fails only the first, and whoever updates it
// has to look at the second too.
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
    expect(plugin, 'the cel plugin did not attach to the StandardMaterial').toBeTruthy();
    const code = (plugin as unknown as {
        getCustomCode(shaderType: string): Record<string, string> | null;
    }).getCustomCode('fragment');
    expect(code).toBeTruthy();
    return code as Record<string, string>;
}

describe('hatching mask', () => {
    it('receives the light ramp coordinate, not the finished color', () => {
        const beforeFog = fragmentCode().CUSTOM_FRAGMENT_BEFORE_FOG ?? '';

        expect(beforeFog).toContain('dot(diffuseBase + emissiveColor, vec3(0.299, 0.587, 0.114)) * celRampScale');
        expect(beforeFog).toContain('celPluginHatch(gl_FragCoord.xy, celRampU)');
        expect(beforeFog).not.toContain('dot(color.rgb');
    });

    it('counts OWN light as light: something that glows is not in shadow', () => {
        // Without the emissive, a self-lit object receives zero light, falls into
        // the first band and takes the full hatching. It actually happened:
        // self-illuminated pickups came out hatched.
        const beforeFog = fragmentCode().CUSTOM_FRAGMENT_BEFORE_FOG ?? '';

        expect(beforeFog).toContain('diffuseBase + emissiveColor');
    });

    it('confines the hatching to the first band, instead of fading up to full light', () => {
        // The 0.30-0.95 window took the middle band for roughly a third, and
        // under a real game's lighting rig half the world falls inside it: the
        // hatching showed up on surfaces the eye reads as lit. The boundary is now
        // the band, not a luminance threshold.
        const definitions = fragmentCode().CUSTOM_FRAGMENT_DEFINITIONS ?? '';

        expect(definitions).toContain('1.0 / celRampBands');
        expect(definitions).not.toContain('smoothstep(0.30, 0.95');
    });

    it('quantizes the light with the same function that composes finalDiffuse', () => {
        // If the two `finalDiffuse` substitutions stopped going through
        // `celQuantizeLight`, the mask would use a band that pixel does not use:
        // same function, same argument, or it is not its band.
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
