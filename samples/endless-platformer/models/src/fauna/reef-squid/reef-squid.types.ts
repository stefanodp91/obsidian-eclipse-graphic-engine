import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';

export interface ReefSquidOptions {
  readonly scene: Scene;
  readonly name?: string;
  readonly scale?: number;
  readonly phase?: number;
}

export interface ReefSquidModel {
  readonly root: TransformNode;
  readonly arms: readonly TransformNode[];
  readonly phase: number;
  readonly dispose: () => void;
}
