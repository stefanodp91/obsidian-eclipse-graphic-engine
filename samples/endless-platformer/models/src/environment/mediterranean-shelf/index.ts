import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateIcoSphere } from '@babylonjs/core/Meshes/Builders/icoSphereBuilder';
import type { Scene } from '@babylonjs/core/scene';
import { createMembrane } from '../../_lib/geometry';
import { createPbr } from '../../_lib/materials';

export interface MediterraneanShelfOptions {
  readonly scene: Scene;
  readonly name?: string;
  readonly seed?: number;
  readonly width?: number;
  readonly height?: number;
  readonly pointsUp?: boolean;
}

export interface MediterraneanShelfModel {
  readonly root: TransformNode;
  readonly fronds: readonly TransformNode[];
  readonly dispose: () => void;
}

function random(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildLimestoneGate(options: MediterraneanShelfOptions): MediterraneanShelfModel {
  const { scene } = options;
  const name = options.name ?? 'mediterranean-limestone';
  const root = new TransformNode(name, scene);
  const rng = random(options.seed ?? 1);
  const width = options.width ?? 2.2;
  const height = options.height ?? 4;
  const up = options.pointsUp ?? true;
  const limestone = createPbr(scene, `${name}-limestone`, Color3.FromHexString('#77766a'), 0.92);
  const algae = createPbr(scene, `${name}-algae`, Color3.FromHexString('#344b39'), 0.88);
  const count = height < 1 ? 2 : Math.max(5, Math.ceil(height / 0.65));
  for (let index = 0; index < count; index += 1) {
    const rock = CreateIcoSphere(`${name}-rock-${index}`, { radius: 1, subdivisions: 2 }, scene);
    rock.parent = root;
    const y = (index + 0.25) / count * height;
    rock.position.set((rng() - 0.5) * width * 0.38, up ? y : -y, (rng() - 0.5) * 0.6);
    rock.scaling.set(width * (0.42 + rng() * 0.26), height / count * (0.68 + rng() * 0.55), 1.15 + rng() * 0.8);
    rock.rotation.set(rng() * 0.45, rng() * 0.8, rng() * 0.35);
    rock.material = index % 4 === 0 ? algae : limestone;
  }
  return { root, fronds: [], dispose: () => root.dispose(false, false) };
}

export function buildPosidoniaPatch(options: MediterraneanShelfOptions): MediterraneanShelfModel {
  const { scene } = options;
  const name = options.name ?? 'posidonia-oceanica';
  const root = new TransformNode(name, scene);
  const rng = random(options.seed ?? 1);
  const leaf = createPbr(scene, `${name}-leaf`, Color3.FromHexString('#355f38'), 0.84);
  const oldLeaf = createPbr(scene, `${name}-old-leaf`, Color3.FromHexString('#62713c'), 0.9);
  const fronds: TransformNode[] = [];
  const shoots = Math.max(6, Math.round((options.width ?? 4) * 5));
  for (let shoot = 0; shoot < shoots; shoot += 1) {
    const pivot = new TransformNode(`${name}-shoot-${shoot}`, scene);
    pivot.parent = root;
    pivot.position.set((rng() - 0.5) * (options.width ?? 4), 0, (rng() - 0.5) * 1.5);
    pivot.rotation.y = rng() * Math.PI;
    const bladeCount = 3 + Math.floor(rng() * 3);
    for (let blade = 0; blade < bladeCount; blade += 1) {
      const h = 0.72 + rng() * 0.85;
      const lean = (rng() - 0.5) * 0.42;
      const strip = createMembrane(scene, `${name}-blade-${shoot}-${blade}`, [
        new Vector3(-0.035, 0, 0), new Vector3(0.035, 0, 0),
        new Vector3(0.045 + lean * 0.45, h * 0.56, 0), new Vector3(lean, h, 0),
      ], Color3.FromHexString('#355f38'));
      strip.parent = pivot;
      strip.rotation.y = blade / bladeCount * Math.PI * 2;
      strip.material = rng() > 0.16 ? leaf : oldLeaf;
    }
    fronds.push(pivot);
  }
  return { root, fronds, dispose: () => root.dispose(false, false) };
}

export function applyPosidoniaPose(model: MediterraneanShelfModel, timeSeconds: number): void {
  model.fronds.forEach((frond, index) => {
    frond.rotation.z = Math.sin(timeSeconds * 0.58 + index * 0.47) * 0.055;
  });
}
