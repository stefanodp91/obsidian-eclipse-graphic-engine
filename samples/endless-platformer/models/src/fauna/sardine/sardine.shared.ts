import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateTube } from '@babylonjs/core/Meshes/Builders/tubeBuilder';
import { createAnatomicalLoft, createMembrane } from '../../_lib/geometry';
import { createPbr } from '../../_lib/materials';
import type { SardineModel, SardineOptions } from './sardine.types';

const BACK = Color3.FromHexString('#244c59');
const FLANK = Color3.FromHexString('#b8cbc8');
const BELLY = Color3.FromHexString('#eef0e6');
const FIN = Color3.FromHexString('#738f91');

export function buildSardineDetailed(options: SardineOptions, segments: number): SardineModel {
  const { scene } = options;
  const name = options.name ?? 'european-sardine';
  const root = new TransformNode(name, scene);
  root.scaling.setAll(options.scale ?? 1);
  const silver = createPbr(scene, `${name}-guanine-scales`, Color3.White(), 0.2);
  silver.metallic = 0;
  silver.environmentIntensity = 1.28;

  const body = createAnatomicalLoft(scene, `${name}-body`, [
    { x: -0.39, centerY: 0, halfHeight: 0.035, halfWidth: 0.025 },
    { x: -0.28, centerY: 0.005, halfHeight: 0.105, halfWidth: 0.045 },
    { x: -0.05, centerY: 0.012, halfHeight: 0.155, halfWidth: 0.065 },
    { x: 0.18, centerY: 0.005, halfHeight: 0.145, halfWidth: 0.062 },
    { x: 0.35, centerY: -0.005, halfHeight: 0.105, halfWidth: 0.052 },
    { x: 0.43, centerY: -0.008, halfHeight: 0.045, halfWidth: 0.032 },
  ], Math.max(10, segments), BACK, FLANK, BELLY);
  body.parent = root;
  body.material = silver;

  const stripe = CreateTube(`${name}-lateral-iridophore-band`, {
    path: [new Vector3(-0.25, 0.025, -0.048), new Vector3(0.02, 0.025, -0.068), new Vector3(0.31, 0.018, -0.052)],
    radius: 0.009,
    tessellation: 7,
  }, scene);
  stripe.parent = root;
  stripe.material = createPbr(scene, `${name}-iridescent-band`, Color3.FromHexString('#d7e4df'), 0.12);

  const tail = new TransformNode(`${name}-tail`, scene);
  tail.parent = root;
  tail.position.x = -0.38;
  for (const direction of [-1, 1] as const) {
    const lobe = createMembrane(scene, `${name}-caudal-${direction}`, [
      new Vector3(0, 0, 0), new Vector3(-0.16, direction * 0.19, 0),
      new Vector3(-0.25, direction * 0.22, 0), new Vector3(-0.18, direction * 0.025, 0),
    ], FIN);
    lobe.parent = tail;
    lobe.material = silver;
  }
  const dorsal = createMembrane(scene, `${name}-dorsal-soft-fin`, [
    new Vector3(0.06, 0.135, 0), new Vector3(-0.06, 0.285, 0),
    new Vector3(-0.19, 0.145, 0), new Vector3(-0.24, 0.115, 0),
  ], FIN);
  dorsal.parent = root; dorsal.material = silver;
  const anal = createMembrane(scene, `${name}-anal-soft-fin`, [
    new Vector3(-0.08, -0.125, 0), new Vector3(-0.20, -0.205, 0), new Vector3(-0.31, -0.105, 0),
  ], FIN);
  anal.parent = root; anal.material = silver;
  const pectoral = createMembrane(scene, `${name}-pectoral-fin`, [
    new Vector3(0.22, -0.005, -0.055), new Vector3(0.06, -0.12, -0.09), new Vector3(0.02, -0.015, -0.06),
  ], FIN);
  pectoral.parent = root; pectoral.material = silver;

  const operculum = CreateTube(`${name}-operculum`, {
    path: [new Vector3(0.25, 0.09, -0.057), new Vector3(0.22, 0, -0.07), new Vector3(0.24, -0.085, -0.055)],
    radius: 0.009,
    tessellation: 6,
  }, scene);
  operculum.parent = root;
  operculum.material = createPbr(scene, `${name}-operculum-shadow`, Color3.FromHexString('#526f72'), 0.46);
  for (let line = 0; line < 3; line += 1) {
    const stria = CreateTube(`${name}-opercular-stria-${line}`, {
      path: [new Vector3(0.255 - line * 0.013, 0.025, -0.071), new Vector3(0.225 - line * 0.011, -0.045 - line * 0.008, -0.066)],
      radius: 0.0035,
      tessellation: 5,
    }, scene);
    stria.parent = root; stria.material = operculum.material;
  }
  const eye = CreateSphere(`${name}-eye`, { diameter: 0.055, segments: 10 }, scene);
  eye.parent = root; eye.position.set(0.34, 0.052, -0.055); eye.scaling.z = 0.45;
  eye.material = createPbr(scene, `${name}-eye-material`, Color3.FromHexString('#061013'), 0.16);
  const glint = CreateSphere(`${name}-eye-glint`, { diameter: 0.012, segments: 6 }, scene);
  glint.parent = root; glint.position.set(0.348, 0.064, -0.076);
  glint.material = createPbr(scene, `${name}-eye-glint`, Color3.FromHexString('#e8f3e9'), 0.08);

  return { root, tail, phase: options.phase ?? 0, dispose: () => root.dispose(false, false) };
}
