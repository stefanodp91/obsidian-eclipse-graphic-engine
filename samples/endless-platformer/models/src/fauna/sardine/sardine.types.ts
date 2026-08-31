import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';

export interface SardineOptions {
  readonly scene: Scene;
  readonly name?: string;
  readonly scale?: number;
  readonly phase?: number;
}

export interface SardineModel {
  readonly root: TransformNode;
  readonly tail: TransformNode;
  readonly phase: number;
  readonly dispose: () => void;
}
