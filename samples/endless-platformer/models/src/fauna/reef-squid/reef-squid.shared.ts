import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateTube } from '@babylonjs/core/Meshes/Builders/tubeBuilder';
import { createAnatomicalLoft, createMembrane } from '../../_lib/geometry';
import { createPbr } from '../../_lib/materials';
import type { ReefSquidModel, ReefSquidOptions } from './reef-squid.types';

const MANTLE_DARK = Color3.FromHexString('#68413f');
const MANTLE_MID = Color3.FromHexString('#a87369');
const MANTLE_LIGHT = Color3.FromHexString('#d0aaa0');
const CHROMATOPHORE = Color3.FromHexString('#572f3d');

export function buildReefSquidDetailed(options: ReefSquidOptions, segments: number, armCount: number): ReefSquidModel {
  const { scene } = options;
  const name = options.name ?? 'common-squid';
  const root = new TransformNode(name, scene);
  root.scaling.setAll(options.scale ?? 1);
  const mantleMaterial = createPbr(scene, `${name}-mantle-tissue`, Color3.White(), 0.48);
  mantleMaterial.metallic = 0;
  mantleMaterial.environmentIntensity = 0.82;

  const mantle = createAnatomicalLoft(scene, `${name}-cylindrical-mantle`, [
    { x: -0.68, centerY: 0, halfHeight: 0.025, halfWidth: 0.02 },
    { x: -0.58, centerY: 0, halfHeight: 0.12, halfWidth: 0.105 },
    { x: -0.34, centerY: 0.005, halfHeight: 0.20, halfWidth: 0.17 },
    { x: -0.02, centerY: 0, halfHeight: 0.22, halfWidth: 0.19 },
    { x: 0.24, centerY: -0.005, halfHeight: 0.19, halfWidth: 0.17 },
  ], Math.max(10, segments), MANTLE_DARK, MANTLE_MID, MANTLE_LIGHT);
  mantle.parent = root; mantle.material = mantleMaterial;

  // Loligo vulgaris: paired fins form a long rhomboidal outline around the
  // posterior three quarters of the mantle rather than two small triangles.
  for (const direction of [-1, 1] as const) {
    const fin = createMembrane(scene, `${name}-rhomboidal-fin-${direction}`, [
      new Vector3(0.02, direction * 0.16, 0), new Vector3(-0.30, direction * 0.36, 0),
      new Vector3(-0.61, direction * 0.22, 0), new Vector3(-0.67, 0, 0),
      new Vector3(-0.28, direction * 0.16, 0),
    ], MANTLE_MID);
    fin.parent = root; fin.material = mantleMaterial;
  }

  const head = createAnatomicalLoft(scene, `${name}-head`, [
    { x: 0.20, centerY: 0, halfHeight: 0.17, halfWidth: 0.16 },
    { x: 0.38, centerY: -0.01, halfHeight: 0.18, halfWidth: 0.19 },
    { x: 0.49, centerY: -0.025, halfHeight: 0.11, halfWidth: 0.13 },
  ], Math.max(10, segments), MANTLE_DARK, MANTLE_MID, MANTLE_LIGHT);
  head.parent = root; head.material = mantleMaterial;

  const dark = createPbr(scene, `${name}-chromatophores`, CHROMATOPHORE, 0.66);
  for (let stripe = 0; stripe < Math.max(3, Math.floor(segments / 4)); stripe += 1) {
    const x = -0.42 + stripe * 0.13;
    const mark = CreateTube(`${name}-chromatophore-flame-${stripe}`, {
      path: [new Vector3(x - 0.07, 0.10, -0.165), new Vector3(x, 0.04, -0.195), new Vector3(x + 0.08, 0.09, -0.16)],
      radius: 0.008,
      tessellation: 6,
    }, scene);
    mark.parent = root; mark.material = dark;
  }

  const eyeWhite = createPbr(scene, `${name}-eye-sclera`, Color3.FromHexString('#c9c1ae'), 0.3);
  const pupilMaterial = createPbr(scene, `${name}-pupil`, Color3.FromHexString('#05070a'), 0.12);
  const eye = CreateSphere(`${name}-eye`, { diameter: 0.12, segments: 12 }, scene);
  eye.parent = root; eye.position.set(0.36, 0.075, -0.17); eye.scaling.z = 0.42; eye.material = eyeWhite;
  const pupil = CreateSphere(`${name}-pupil`, { diameter: 0.065, segments: 10 }, scene);
  pupil.parent = root; pupil.position.set(0.38, 0.078, -0.193); pupil.scaling.set(0.55, 1, 0.3); pupil.material = pupilMaterial;

  const arms: TransformNode[] = [];
  for (let index = 0; index < armCount; index += 1) {
    const pivot = new TransformNode(`${name}-arm-pivot-${index}`, scene);
    pivot.parent = root;
    const longTentacle = index >= armCount - 2 && armCount >= 8;
    const spread = (index - (armCount - 1) / 2) / Math.max(1, armCount - 1);
    pivot.position.set(0.46, -0.04 + spread * 0.18, spread * 0.10);
    const length = longTentacle ? 0.68 : 0.40 + (index % 3) * 0.035;
    const arm = CreateTube(`${name}-${longTentacle ? 'feeding-tentacle' : 'arm'}-${index}`, {
      path: [new Vector3(0, 0, 0), new Vector3(length * 0.48, spread * 0.08, spread * 0.025), new Vector3(length, spread * 0.14, 0)],
      radius: longTentacle ? 0.018 : 0.024,
      tessellation: 7,
      cap: 3,
    }, scene);
    arm.parent = pivot; arm.material = mantleMaterial;
    if (longTentacle) {
      const club = CreateSphere(`${name}-tentacular-club-${index}`, { diameter: 0.075, segments: 8 }, scene);
      club.parent = pivot; club.position.set(length, spread * 0.14, 0); club.scaling.x = 1.8; club.material = mantleMaterial;
    }
    arms.push(pivot);
  }
  return { root, arms, phase: options.phase ?? 0, dispose: () => root.dispose(false, false) };
}
