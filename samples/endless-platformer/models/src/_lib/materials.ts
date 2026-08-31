import { Color3 } from '@babylonjs/core/Maths/math.color';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { Scene } from '@babylonjs/core/scene';

const pbrByScene = new WeakMap<Scene, Map<string, PBRMaterial>>();

function sceneMaterials(scene: Scene): Map<string, PBRMaterial> {
  const existing = pbrByScene.get(scene);
  if (existing) return existing;
  const created = new Map<string, PBRMaterial>();
  pbrByScene.set(scene, created);
  scene.onDisposeObservable.addOnce(() => created.clear());
  return created;
}

export function createSkinMaterial(scene: Scene, name: string): PBRMaterial {
  const materials = sceneMaterials(scene);
  const cached = materials.get('great-white-skin');
  if (cached) return cached;
  const material = new PBRMaterial(name, scene);
  material.albedoColor = Color3.White();
  material.metallic = 0;
  // Wet biological tissue is dielectric. Denticle-scale relief broadens the
  // highlight without turning the skin into metal or polished plastic.
  material.roughness = 0.64;
  material.environmentIntensity = 0.72;
  material.backFaceCulling = false;
  const denticles = new DynamicTexture(`${name}-denticles`, { width: 128, height: 128 }, scene, false);
  const context = denticles.getContext();
  context.fillStyle = '#808080';
  context.fillRect(0, 0, 128, 128);
  context.strokeStyle = '#989898';
  context.lineWidth = 1;
  for (let y = 2; y < 128; y += 6) {
    for (let x = 2; x < 128; x += 6) {
      context.beginPath();
      context.moveTo(x - 2, y - 2);
      context.lineTo(x, y + 2);
      context.lineTo(x + 2, y - 2);
      context.stroke();
    }
  }
  denticles.update();
  material.bumpTexture = denticles;
  material.bumpTexture.level = 0.18;
  materials.set('great-white-skin', material);
  return material;
}

export function createPbr(scene: Scene, name: string, color: Color3, roughness = 0.5): PBRMaterial {
  const materials = sceneMaterials(scene);
  const key = `${color.toHexString()}-${roughness.toFixed(3)}`;
  const cached = materials.get(key);
  if (cached) return cached;
  const material = new PBRMaterial(name, scene);
  material.albedoColor = color;
  material.metallic = 0;
  material.roughness = roughness;
  material.environmentIntensity = 0.78;
  material.backFaceCulling = false;
  materials.set(key, material);
  return material;
}
