import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateTube } from '@babylonjs/core/Meshes/Builders/tubeBuilder';
import { createAnatomicalLoft, createMembrane } from '../../_lib/geometry';
import { createPbr, createSkinMaterial } from '../../_lib/materials';
import type { GreatWhiteModel, GreatWhiteOptions } from './great-white.types';

export interface GreatWhiteDetail { readonly bodySteps: number; readonly radialSegments: number; readonly toothCount: number; readonly poreCount: number }

const DORSAL = Color3.FromHexString('#25353a');
const FLANK = Color3.FromHexString('#6d7c7d');
const VENTRAL = Color3.FromHexString('#d8ddd8');
const FIN = Color3.FromHexString('#3c4e52');
const CREASE = Color3.FromHexString('#152326');
const MOUTH = Color3.FromHexString('#2a1113');
const IVORY = Color3.FromHexString('#ddd5bd');
const EYE = Color3.FromHexString('#020607');

function fin(scene: GreatWhiteOptions['scene'], root: TransformNode, name: string, points: readonly Vector3[], skin: ReturnType<typeof createSkinMaterial>): void {
  const near = createMembrane(scene, `${name}-near`, points.map((p) => new Vector3(p.x, p.y, p.z - 0.018)), FIN);
  const far = createMembrane(scene, `${name}-far`, [...points].reverse().map((p) => new Vector3(p.x, p.y, p.z + 0.018)), FIN);
  near.parent = root; far.parent = root; near.material = skin; far.material = skin;
}

function tooth(parent: TransformNode, name: string, x: number, y: number, rotation: number, scene: GreatWhiteOptions['scene']): void {
  const mesh = CreateCylinder(name, { height: 0.085, diameterTop: 0.008, diameterBottom: 0.052, tessellation: 3 }, scene);
  mesh.parent = parent; mesh.position.set(x, y, -0.395); mesh.rotation.z = rotation;
  mesh.material = createPbr(scene, `${name}-ivory`, IVORY, 0.48);
}

export function buildGreatWhiteDetailed(options: GreatWhiteOptions, detail: GreatWhiteDetail): GreatWhiteModel {
  const { scene } = options;
  const name = options.name ?? 'great-white';
  const root = new TransformNode(name, scene);
  root.scaling.setAll(options.scale ?? 1);
  const skin = createSkinMaterial(scene, `${name}-skin`);
  const body = createAnatomicalLoft(scene, `${name}-body`, [
    { x: -2.34, centerY: 0, halfHeight: 0.13, halfWidth: 0.10 },
    { x: -2.08, centerY: 0, halfHeight: 0.20, halfWidth: 0.16 },
    { x: -1.70, centerY: 0.01, halfHeight: 0.37, halfWidth: 0.31 },
    { x: -1.12, centerY: 0.03, halfHeight: 0.56, halfWidth: 0.47 },
    { x: -0.42, centerY: 0.04, halfHeight: 0.72, halfWidth: 0.60 },
    { x: 0.30, centerY: 0.03, halfHeight: 0.69, halfWidth: 0.62 },
    { x: 0.92, centerY: 0.01, halfHeight: 0.58, halfWidth: 0.57 },
    { x: 1.42, centerY: -0.01, halfHeight: 0.46, halfWidth: 0.49 },
    { x: 1.82, centerY: -0.03, halfHeight: 0.33, halfWidth: 0.38 },
    { x: 2.12, centerY: -0.05, halfHeight: 0.19, halfWidth: 0.24 },
    { x: 2.28, centerY: -0.06, halfHeight: 0.07, halfWidth: 0.11 },
  ], detail.radialSegments, DORSAL, FLANK, VENTRAL);
  body.parent = root; body.material = skin;

  fin(scene, root, `${name}-first-dorsal`, [new Vector3(0.32, 0.63, 0), new Vector3(-0.10, 1.43, 0), new Vector3(-0.34, 1.58, 0), new Vector3(-0.56, 0.62, 0)], skin);
  fin(scene, root, `${name}-second-dorsal`, [new Vector3(-1.31, 0.31, 0), new Vector3(-1.55, 0.60, 0), new Vector3(-1.72, 0.28, 0)], skin);
  fin(scene, root, `${name}-near-pectoral`, [new Vector3(0.50, -0.19, -0.44), new Vector3(-0.08, -0.64, -0.56), new Vector3(-0.76, -1.03, -0.37), new Vector3(-0.54, -0.25, -0.38)], skin);
  fin(scene, root, `${name}-far-pectoral`, [new Vector3(0.44, -0.13, 0.42), new Vector3(-0.30, -0.51, 1.22), new Vector3(-0.61, -0.22, 0.45)], skin);
  fin(scene, root, `${name}-pelvic`, [new Vector3(-1.05, -0.31, -0.20), new Vector3(-1.40, -0.60, -0.24), new Vector3(-1.52, -0.27, -0.18)], skin);
  fin(scene, root, `${name}-anal`, [new Vector3(-1.43, -0.25, 0), new Vector3(-1.65, -0.54, 0), new Vector3(-1.82, -0.22, 0)], skin);

  const tail = new TransformNode(`${name}-tail`, scene); tail.parent = root; tail.position.x = -2.28;
  const peduncle = createAnatomicalLoft(scene, `${name}-peduncle`, [
    { x: 0, centerY: 0, halfHeight: 0.14, halfWidth: 0.11 },
    { x: -0.38, centerY: 0, halfHeight: 0.12, halfWidth: 0.08 },
    { x: -0.64, centerY: 0, halfHeight: 0.18, halfWidth: 0.10 },
  ], Math.max(10, detail.radialSegments / 2), DORSAL, FLANK, VENTRAL);
  peduncle.parent = tail; peduncle.material = skin;
  for (const side of [-1, 1] as const) fin(scene, tail, `${name}-keel-${side}`, [new Vector3(-0.18, 0, side * 0.07), new Vector3(-0.58, 0, side * 0.28), new Vector3(-0.67, 0, side * 0.08)], skin);
  fin(scene, tail, `${name}-caudal`, [
    new Vector3(-0.56, 0, 0), new Vector3(-0.72, 0.78, 0), new Vector3(-1.03, 1.36, 0), new Vector3(-1.16, 1.42, 0), new Vector3(-1.06, 0.30, 0), new Vector3(-0.86, 0, 0),
    new Vector3(-1.07, -0.30, 0), new Vector3(-1.14, -1.24, 0), new Vector3(-1.00, -1.20, 0), new Vector3(-0.70, -0.67, 0),
  ], skin);

  const eye = CreateSphere(`${name}-eye`, { diameter: 0.135, segments: 14 }, scene);
  eye.parent = root; eye.position.set(1.48, 0.20, -0.445); eye.scaling.z = 0.34; eye.material = createPbr(scene, `${name}-eye-material`, EYE, 0.16);
  const glint = CreateSphere(`${name}-eye-glint`, { diameter: 0.025, segments: 8 }, scene);
  glint.parent = root; glint.position.set(1.50, 0.225, -0.468); glint.material = createPbr(scene, `${name}-eye-glint-material`, Color3.FromHexString('#b9d9d6'), 0.08);

  const crease = createPbr(scene, `${name}-crease`, CREASE, 0.76);
  for (let index = 0; index < 5; index += 1) {
    const x = 0.84 - index * 0.12;
    const slit = CreateTube(`${name}-gill-${index}`, { path: [new Vector3(x + 0.02, 0.30, -0.54), new Vector3(x, 0.02, -0.61), new Vector3(x - 0.035, -0.28, -0.52)], radius: 0.012 + index * 0.001, tessellation: 6 }, scene);
    slit.parent = root; slit.material = crease;
  }
  const mouthLine = CreateTube(`${name}-mouth-line`, { path: [new Vector3(1.22, -0.28, -0.45), new Vector3(1.58, -0.39, -0.42), new Vector3(1.98, -0.30, -0.30)], radius: 0.022, tessellation: 7 }, scene);
  mouthLine.parent = root; mouthLine.material = createPbr(scene, `${name}-mouth`, MOUTH, 0.74);
  const jaw = new TransformNode(`${name}-jaw`, scene); jaw.parent = root; jaw.position.set(1.20, -0.28, 0);
  const mandible = CreateTube(`${name}-mandible`, { path: [new Vector3(0, 0, -0.40), new Vector3(0.38, -0.12, -0.37), new Vector3(0.75, -0.02, -0.27)], radius: 0.045, tessellation: 8 }, scene);
  mandible.parent = jaw; mandible.material = createPbr(scene, `${name}-mandible-skin`, VENTRAL, 0.62);
  for (let index = 0; index < detail.toothCount; index += 1) {
    const t = index / Math.max(1, detail.toothCount - 1);
    tooth(root, `${name}-upper-tooth-${index}`, 1.30 + t * 0.57, -0.30 - Math.sin(t * Math.PI) * 0.045, Math.PI, scene);
    tooth(jaw, `${name}-lower-tooth-${index}`, 0.10 + t * 0.52, -0.015, 0, scene);
  }
  const poreMaterial = createPbr(scene, `${name}-pore-material`, CREASE, 0.82);
  for (let index = 0; index < detail.poreCount; index += 1) {
    const pore = CreateSphere(`${name}-snout-pore-${index}`, { diameter: 0.018, segments: 5 }, scene);
    pore.parent = root; pore.position.set(1.72 + (index % 4) * 0.09, 0.06 - Math.floor(index / 4) * 0.07, -0.36 - (index % 2) * 0.018); pore.material = poreMaterial;
  }
  return { root, tail, jaw, dispose: () => root.dispose(false, false) };
}
