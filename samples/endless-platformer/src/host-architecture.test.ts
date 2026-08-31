import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hostSource = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
const gameSource = readFileSync(new URL('./game.ts', import.meta.url), 'utf8');

describe('Reactylon host architecture', () => {
  it('gives Reactylon ownership of the Babylon engine, scene and render loop', () => {
    expect(hostSource).toContain("import { Scene } from 'reactylon'");
    expect(hostSource).toContain("import { Engine } from 'reactylon/web'");
    expect(hostSource).toContain(
      "import { ReactylonSceneBridge } from 'obsidian-eclipse-graphic-engine/reactylon'",
    );
    expect(hostSource).toContain('<Engine');
    expect(hostSource).toContain('<Scene>');
    expect(gameSource).toContain('scene.getEngine()');
    expect(gameSource).not.toContain('new Engine(');
    expect(gameSource).not.toContain('.runRenderLoop(');
  });

  it('mounts procedural gameplay through a React effect cleanup', () => {
    expect(hostSource).toContain('<ReactylonSceneBridge mount={mountEndlessPlatformer} />');
    expect(gameSource).toContain('export function mountEndlessPlatformer');
    expect(gameSource).toContain('return () => {');
  });
});
