import type { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import {
  ModelTier,
  applyGreatWhitePose,
  applyReefSquidPose,
  applySardinePose,
  applyPosidoniaPose,
  buildGreatWhite,
  buildLimestoneGate,
  buildPosidoniaPatch,
  buildReefSquid,
  buildSardine,
  type GreatWhiteModel,
  type ReefSquidModel,
  type SardineModel,
  type MediterraneanShelfModel,
} from '@obsidian-eclipse/endless-shark-models';
import {
  EnginePhase,
  createGraphicEngine,
  type InputSource,
  type QualityPreset,
} from 'obsidian-eclipse-graphic-engine';
import { AssetCache } from 'obsidian-eclipse-graphic-engine/cache';
import { CHUNK_WIDTH, createChunkSpec, type PreySpec } from './level';
import { oceanPoseAt } from './ocean';
import { cameraLeadForAspect, verticalFovForAspect } from './responsive-camera';
import { advanceVerticalSwim } from './swim-control';

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

export function mountEndlessPlatformer(scene: Scene): () => void {
  const canvas = requiredElement<HTMLCanvasElement>('#game');
  const distanceOutput = requiredElement<HTMLOutputElement>('#distance');
  const preyOutput = requiredElement<HTMLOutputElement>('#prey');
  const speedOutput = requiredElement<HTMLOutputElement>('#speed');
  const stateOutput = requiredElement<HTMLOutputElement>('#state');
  const startButton = requiredElement<HTMLButtonElement>('#start');

  const renderer = scene.getEngine() as Engine;
  canvas.dataset.sceneOwner = 'reactylon';
  canvas.dataset.sample = 'endless-platformer';
  canvas.setAttribute('aria-label', 'A shark swimming through an endless side-scrolling ocean');
  canvas.dataset.webglVersion = renderer.webGLVersion.toString();
  renderer.setHardwareScalingLevel(Math.max(1, window.devicePixelRatio / 1.5));
  scene.clearColor = Color4.FromHexString('#073c48ff');
  scene.ambientColor = Color3.FromHexString('#7eb8ad');
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogColor = Color3.FromHexString('#0b4c57');
  scene.fogStart = 16;
  scene.fogEnd = 39;
  scene.imageProcessingConfiguration.contrast = 1.16;
  scene.imageProcessingConfiguration.exposure = 0.92;

  const camera = new FreeCamera('side-camera', new Vector3(7.5, 0.6, -19), scene);
  let cameraLead = 8.1;
  let cameraAnchorX = 3;
  const updateCameraFraming = (): void => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    camera.fov = verticalFovForAspect(width / height);
    cameraLead = cameraLeadForAspect(width / height);
    camera.setTarget(new Vector3(cameraAnchorX + cameraLead, 0.15, 0));
    canvas.dataset.orientation = width >= height ? 'landscape' : 'portrait';
  };
  updateCameraFraming();
  const cameraResizeObserver = new ResizeObserver(updateCameraFraming);
  cameraResizeObserver.observe(canvas);
  new HemisphericLight('water-fill', new Vector3(0, 1, -0.2), scene).intensity = 0.68;
  const sun = new DirectionalLight('surface-light', new Vector3(-0.3, -1, 0.25), scene);
  sun.intensity = 1.15;

  function material(name: string, hex: string, roughness: number, alpha = 1): PBRMaterial {
    const mat = new PBRMaterial(name, scene);
    mat.albedoColor = Color3.FromHexString(hex);
    mat.metallic = 0;
    mat.roughness = roughness;
    mat.alpha = alpha;
    mat.environmentIntensity = 0.72;
    return mat;
  }

  const cache = new AssetCache(64);
  const deepWater = cache.set('deep-water', material('deep water', '#052d38', 0.72), 'global');
  const surface = cache.set('surface', material('seawater interface · ior 1.339', '#5caea9', 0.12, 0.42), 'global');
  surface.indexOfRefraction = 1.339;
  surface.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  const foam = cache.set('foam', material('suspended particulate', '#d5e6dc', 0.65), 'global');
  const sand = cache.set('sand', material('carbonate sand', '#a49269', 0.96), 'global');

  const waterBackdrop = CreateBox('continuous-water-volume', { width: 72, height: 15, depth: 2 }, scene);
  waterBackdrop.position.set(18, 0.5, 3.4);
  waterBackdrop.material = deepWater;
  const seaFloor = CreateBox('continuous-seabed', { width: 82, height: 2.4, depth: 5 }, scene);
  seaFloor.position.set(20, -6.5, 0.6);
  seaFloor.material = sand;

  const surfaceBoundary = CreateBox('continuous-air-water-interface', { width: 96, height: 0.18, depth: 4.5 }, scene);
  surfaceBoundary.position.set(18, 6.15, 0.4);
  surfaceBoundary.material = surface;

  const softLightTexture = new DynamicTexture(
    'soft-underwater-light-texture',
    { width: 128, height: 128 },
    scene,
    false,
  );
  softLightTexture.hasAlpha = true;
  const softLightContext = softLightTexture.getContext();
  const softLightGradient = softLightContext.createRadialGradient(64, 64, 0, 64, 64, 64);
  softLightGradient.addColorStop(0, 'rgba(225, 255, 239, 0.72)');
  softLightGradient.addColorStop(0.2, 'rgba(183, 236, 219, 0.34)');
  softLightGradient.addColorStop(0.58, 'rgba(111, 199, 184, 0.10)');
  softLightGradient.addColorStop(1, 'rgba(72, 160, 154, 0)');
  softLightContext.fillStyle = softLightGradient;
  softLightContext.fillRect(0, 0, 128, 128);
  softLightTexture.update(false, true);

  const softLightEmitter = new Vector3(camera.position.x + 8, 0.2, -0.8);
  const softLightParticles = new ParticleSystem('soft-underwater-light-particles', 180, scene);
  softLightParticles.particleTexture = softLightTexture;
  softLightParticles.emitter = softLightEmitter;
  // The emitter follows the endless route, but emitted photons remain in world
  // space and therefore cross the camera with depth/parallax instead of sticking
  // to the viewport.
  softLightParticles.isLocal = false;
  softLightParticles.createBoxEmitter(
    new Vector3(-0.12, 0.025, -0.015),
    new Vector3(0.035, 0.16, 0.015),
    new Vector3(-23, -4.7, -3.4),
    new Vector3(27, 5.2, 3.2),
  );
  softLightParticles.color1 = new Color4(0.70, 0.94, 0.86, 0.12);
  softLightParticles.color2 = new Color4(0.88, 1, 0.91, 0.2);
  softLightParticles.colorDead = new Color4(0.38, 0.72, 0.69, 0);
  softLightParticles.minSize = 0.16;
  softLightParticles.maxSize = 0.82;
  softLightParticles.minLifeTime = 5.5;
  softLightParticles.maxLifeTime = 9.5;
  softLightParticles.minEmitPower = 0.18;
  softLightParticles.maxEmitPower = 0.52;
  softLightParticles.minAngularSpeed = -0.08;
  softLightParticles.maxAngularSpeed = 0.08;
  softLightParticles.emitRate = 20;
  softLightParticles.blendMode = ParticleSystem.BLENDMODE_ADD;
  softLightParticles.preWarmCycles = 90;
  softLightParticles.preWarmStepOffset = 1;
  softLightParticles.start();
  canvas.dataset.lightFx = 'soft-world-particles';

  const motes = Array.from({ length: 20 }, (_, index) => {
    const mesh = CreateSphere(`mote-${index}`, { diameter: 0.07 + (index % 3) * 0.025, segments: 5 }, scene);
    mesh.material = foam;
    mesh.position.set(index * 3.7, -4.5 + ((index * 37) % 90) / 10, 1.5 + (index % 4) * 0.2);
    return mesh;
  });

  interface Hazard { readonly left: number; readonly right: number; readonly bottom: number; readonly top: number }
  type PreyModel = SardineModel | ReefSquidModel;
  interface PreyEntity {
    readonly model: PreyModel;
    readonly species: PreySpec['species'];
    readonly localX: number;
    readonly baseY: number;
    readonly worldX: number;
    readonly phase: number;
    eaten: boolean;
  }
  interface ChunkView { readonly index: number; readonly root: TransformNode; readonly hazards: Hazard[]; readonly prey: PreyEntity[]; readonly habitat: MediterraneanShelfModel[] }

  const chunks: ChunkView[] = [];
  const hazards: Hazard[] = [];
  const preyEntities: PreyEntity[] = [];

  function addHazard(root: TransformNode, name: string, localX: number, y: number, width: number, height: number): Hazard {
    const mesh = CreateBox(name, { width, height, depth: 3.2 }, scene);
    mesh.parent = root;
    mesh.position.set(localX, y, 0);
    mesh.isVisible = false;
    const worldX = root.position.x + localX;
    const hazard = { left: worldX - width / 2, right: worldX + width / 2, bottom: y - height / 2, top: y + height / 2 };
    hazards.push(hazard);
    return hazard;
  }

  function buildPrey(root: TransformNode, chunkIndex: number, spec: PreySpec, index: number): PreyEntity {
    const common = { scene, name: `${spec.species}-${chunkIndex}-${index}`, phase: spec.phase };
    const model: PreyModel = spec.species === 'sardine'
      ? buildSardine(ModelTier.High, { ...common, scale: 0.62 })
      : buildReefSquid(ModelTier.High, { ...common, scale: 0.72 });
    model.root.parent = root;
    model.root.position.set(spec.x, spec.y, 0);
    const entity = {
      model,
      species: spec.species,
      localX: spec.x,
      baseY: spec.y,
      worldX: root.position.x + spec.x,
      phase: spec.phase,
      eaten: false,
    };
    preyEntities.push(entity);
    return entity;
  }

  function buildChunk(index: number): ChunkView {
    const spec = createChunkSpec(index);
    const root = new TransformNode(`reef-section-${index}`, scene);
    root.position.x = index * CHUNK_WIDTH;
    const chunkHazards: Hazard[] = [];
    const habitat: MediterraneanShelfModel[] = [];
    const meadow = buildPosidoniaPatch({ scene, name: `posidonia-${index}`, seed: index * 97 + 11, width: 8 });
    meadow.root.parent = root;
    meadow.root.position.set(8 + (index % 2) * 7, -5.22, 0.8);
    habitat.push(meadow);
    for (let rockIndex = 0; rockIndex < 2; rockIndex += 1) {
      const rubble = buildLimestoneGate({ scene, name: `seabed-rubble-${index}-${rockIndex}`, seed: index * 53 + rockIndex * 7, width: 0.75 + rockIndex * 0.3, height: 0.42 + rockIndex * 0.16, pointsUp: true });
      rubble.root.parent = root;
      rubble.root.position.set(3 + rockIndex * 11 + (index % 3), -5.35, 0.55);
      habitat.push(rubble);
    }
    if (spec.gate) {
      const { x, openingY, openingHeight, kind } = spec.gate;
      const openingBottom = openingY - openingHeight / 2;
      const openingTop = openingY + openingHeight / 2;
      const lowerHeight = Math.max(0.6, openingBottom + 5.35);
      const upperHeight = Math.max(0.6, 6.0 - openingTop);
      chunkHazards.push(addHazard(root, `lower-${index}`, x, -5.35 + lowerHeight / 2, 2.1, lowerHeight));
      chunkHazards.push(addHazard(root, `upper-${index}`, x, 6.0 - upperHeight / 2, 2.1, upperHeight));
      const lowerRock = buildLimestoneGate({ scene, name: `${kind}-lower-${index}`, seed: index * 31, width: 2.25, height: lowerHeight, pointsUp: true });
      lowerRock.root.parent = root; lowerRock.root.position.set(x, -5.35, 0); habitat.push(lowerRock);
      const upperRock = buildLimestoneGate({ scene, name: `${kind}-upper-${index}`, seed: index * 31 + 3, width: 2.25, height: upperHeight, pointsUp: false });
      upperRock.root.parent = root; upperRock.root.position.set(x, 6.0, 0); habitat.push(upperRock);
    }
    const chunkPrey = spec.prey.map((prey, preyIndex) => buildPrey(root, index, prey, preyIndex));
    return { index, root, hazards: chunkHazards, prey: chunkPrey, habitat };
  }

  const shark: GreatWhiteModel = buildGreatWhite(ModelTier.High, { scene, name: 'player-great-white', scale: 0.62 });
  shark.root.position.set(3, -0.8, 0);

  let jumpQueued = false;
  let swimUpHeld = false;
  const input: InputSource = {
    attach(target) {
      const element = target as HTMLElement;
      const press = (event: Event): void => {
        event.preventDefault();
        jumpQueued = true;
        swimUpHeld = true;
      };
      const release = (): void => { swimUpHeld = false; };
      element.addEventListener('pointerdown', press);
      window.addEventListener('pointerup', release);
      window.addEventListener('pointercancel', release);
      return () => {
        element.removeEventListener('pointerdown', press);
        window.removeEventListener('pointerup', release);
        window.removeEventListener('pointercancel', release);
      };
    },
    get lateral() {
      return 0;
    },
    consumeJump() {
      const queued = jumpQueued;
      jumpQueued = false;
      return queued;
    },
  };

  const frameCallbacks: Array<() => void> = [];
  let quality: QualityPreset = 'mobile-mid';
  const graphicEngine = createGraphicEngine({
    keyPrefix: 'endless-shark', rendering: { scene },
    quality: { get: () => quality, update: (next) => { quality = next; return true; }, subscribe: () => () => {} },
    frame: { add(callback) { frameCallbacks.push(callback); return () => { const index = frameCallbacks.indexOf(callback); if (index >= 0) frameCallbacks.splice(index, 1); }; } },
    assets: cache,
    input,
    phase: (phase) => { renderer.renderEvenInBackground = phase !== EnginePhase.Halted; },
    onDispose: () => cache.disposeAll(),
  });

  const detachInput = graphicEngine.input.attach(canvas);
  let running = false;
  let velocityX = 0;
  let velocityY = 0;
  let distance = 0;
  let eatenCount = 0;
  let elapsed = 0;
  let biteTimer = 0;
  let jumpCooldown = 0;

  function rebuildRoute(): void {
    for (const chunk of chunks) chunk.root.dispose(false, false);
    chunks.length = 0;
    hazards.length = 0;
    preyEntities.length = 0;
    for (let index = 0; index < 7; index += 1) chunks.push(buildChunk(index));
  }

  function reset(): void {
    rebuildRoute();
    shark.root.position.set(3, -0.8, 0);
    shark.root.scaling.x = 0.62;
    velocityX = 5.25;
    velocityY = 0;
    jumpQueued = false;
    swimUpHeld = false;
    jumpCooldown = 0;
    distance = 0;
    eatenCount = 0;
    biteTimer = 0;
    camera.position.x = 7.5;
    cameraAnchorX = 3;
    distanceOutput.value = '0000';
    preyOutput.value = '00';
    speedOutput.value = '5.25';
    stateOutput.value = 'CURRENT: HUNTING';
    document.body.classList.add('is-running');
    running = true;
    startButton.hidden = true;
    graphicEngine.phase.transition(EnginePhase.Active);
  }

  function crash(): void {
    if (!running) return;
    running = false;
    document.body.classList.remove('is-running');
    stateOutput.value = 'CURRENT: INTERRUPTED';
    startButton.textContent = 'Hunt again';
    startButton.hidden = false;
    graphicEngine.phase.transition(EnginePhase.Reduced);
  }

  function recycleChunks(): void {
    const leftEdge = camera.position.x - CHUNK_WIDTH * 1.5;
    let nextIndex = Math.max(...chunks.map((chunk) => chunk.index)) + 1;
    for (const old of [...chunks]) {
      if ((old.index + 1) * CHUNK_WIDTH >= leftEdge || old.index < 1) continue;
      old.root.dispose(false, false);
      for (const hazard of old.hazards) hazards.splice(hazards.indexOf(hazard), 1);
      for (const prey of old.prey) preyEntities.splice(preyEntities.indexOf(prey), 1);
      chunks.splice(chunks.indexOf(old), 1);
      chunks.push(buildChunk(nextIndex));
      nextIndex += 1;
    }
  }

  function updateOcean(dt: number): void {
    elapsed += dt;
    waterBackdrop.position.x = camera.position.x + 10;
    seaFloor.position.x = camera.position.x + 10;
    surfaceBoundary.position.x = camera.position.x + 10;
    surfaceBoundary.position.y = oceanPoseAt(elapsed, camera.position.x).surfaceY;
    softLightEmitter.x = camera.position.x + 8;
    softLightEmitter.y = 0.15 + Math.sin(elapsed * 0.11) * 0.25;
    canvas.dataset.lightParticles = softLightParticles.getActiveCount().toString();
    for (const [index, mote] of motes.entries()) {
      const pose = oceanPoseAt(elapsed, mote.position.x);
      mote.position.x += pose.driftX * dt;
      mote.position.y += (0.08 + pose.liftY) * dt;
      if (mote.position.x < camera.position.x - 14 || mote.position.x > camera.position.x + 35) mote.position.x = camera.position.x - 12 + (index % 5);
      if (mote.position.y > 5.6) mote.position.y = -4.8;
    }
  }

  function updatePrey(): void {
    for (const prey of preyEntities) {
      if (prey.eaten) continue;
      const dx = prey.worldX - shark.root.position.x;
      const dy = prey.baseY - shark.root.position.y;
      const distanceToShark = Math.hypot(dx, dy);
      const panic = Math.max(0, Math.min(1, 1 - distanceToShark / 5.5));
      const escapeY = (Math.sin(prey.phase) >= 0 ? 1 : -1) * panic * 1.15;
      prey.model.root.position.x = prey.localX + Math.sin(elapsed * 1.8 + prey.phase) * 0.12 + panic * 0.8;
      prey.model.root.position.y = prey.baseY + Math.sin(elapsed * 2.1 + prey.phase) * 0.18 + escapeY;
      if (prey.species === 'sardine') applySardinePose(prey.model as SardineModel, elapsed, panic);
      else applyReefSquidPose(prey.model as ReefSquidModel, elapsed, panic);
      const actualX = prey.worldX + (prey.model.root.position.x - prey.localX);
      if (Math.abs(actualX - shark.root.position.x) < 1.15
        && Math.abs(prey.model.root.position.y - shark.root.position.y) < 0.7) {
        prey.eaten = true;
        prey.model.root.setEnabled(false);
        eatenCount += 1;
        biteTimer = 1;
        preyOutput.value = eatenCount.toString().padStart(2, '0');
      }
    }
  }

  graphicEngine.frame.add(() => {
    const dt = Math.min(renderer.getDeltaTime() / 1000, 1 / 30);
    updateOcean(dt);
    biteTimer = Math.max(0, biteTimer - dt * 2.5);
    applyGreatWhitePose(shark, elapsed, biteTimer);
    for (const chunk of chunks) for (const habitat of chunk.habitat) applyPosidoniaPose(habitat, elapsed);
    updatePrey();
    if (!running) return;

    const targetCruiseSpeed = 5.25 + Math.min(2.25, eatenCount * 0.16);
    velocityX += (targetCruiseSpeed - velocityX) * Math.min(1, dt * 2.2);
    const verticalSwim = advanceVerticalSwim(
      { velocityY, cooldown: jumpCooldown },
      { pressed: graphicEngine.input.consumeJump(), held: swimUpHeld },
      dt,
    );
    velocityY = verticalSwim.velocityY;
    jumpCooldown = verticalSwim.cooldown;
    velocityY += oceanPoseAt(elapsed, shark.root.position.x).liftY;
    shark.root.position.x = Math.max(1.5, shark.root.position.x + velocityX * dt);
    shark.root.position.y += velocityY * dt;
    shark.root.rotation.z += ((velocityY * 0.045) - shark.root.rotation.z) * Math.min(1, dt * 6);

    const left = shark.root.position.x - 1.12;
    const right = shark.root.position.x + 1.12;
    const bottom = shark.root.position.y - 0.48;
    const top = shark.root.position.y + 0.48;
    if (bottom < -5.25 || top > oceanPoseAt(elapsed, shark.root.position.x).surfaceY - 0.2) crash();
    for (const hazard of hazards) {
      if (right > hazard.left && left < hazard.right && top > hazard.bottom && bottom < hazard.top) crash();
    }

    camera.position.x += (shark.root.position.x + 5.8 - camera.position.x) * Math.min(1, dt * 5);
    cameraAnchorX = shark.root.position.x;
    camera.setTarget(new Vector3(shark.root.position.x + cameraLead, 0.1, 0));
    distance = Math.max(0, shark.root.position.x - 3);
    distanceOutput.value = Math.floor(distance).toString().padStart(4, '0');
    speedOutput.value = velocityX.toFixed(2);
    canvas.dataset.playerX = shark.root.position.x.toFixed(3);
    canvas.dataset.playerY = shark.root.position.y.toFixed(3);
    canvas.dataset.velocityX = velocityX.toFixed(3);
    canvas.dataset.lateral = '0';
    canvas.dataset.controlMode = 'auto-space';
    canvas.dataset.activePrey = preyEntities.filter((prey) => !prey.eaten).length.toString();
    recycleChunks();
  });

  function keyDown(event: KeyboardEvent): void {
    canvas.dataset.lastKeyDown = event.code;
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat) jumpQueued = true;
      swimUpHeld = true;
    }
    if (event.code === 'KeyR') reset();
  }

  function keyUp(event: KeyboardEvent): void {
    if (event.code !== 'Space') return;
    event.preventDefault();
    swimUpHeld = false;
  }

  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  const clearHeldInput = (): void => { swimUpHeld = false; };
  window.addEventListener('blur', clearHeldInput);
  startButton.addEventListener('click', reset);
  const frameObserver = scene.onBeforeRenderObservable.add(() => {
    for (const callback of frameCallbacks) callback();
  });

  return () => {
    cameraResizeObserver.disconnect();
    scene.onBeforeRenderObservable.remove(frameObserver);
    window.removeEventListener('keydown', keyDown);
    window.removeEventListener('keyup', keyUp);
    window.removeEventListener('blur', clearHeldInput);
    startButton.removeEventListener('click', reset);
    detachInput();
    softLightParticles.dispose(true);
    shark.dispose();
    graphicEngine.dispose();
    document.body.classList.remove('is-running');
  };
}
