import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';

export interface GreatWhiteOptions {
  readonly scene: Scene;
  readonly name?: string;
  readonly scale?: number;
}

export interface GreatWhiteModel {
  readonly root: TransformNode;
  readonly tail: TransformNode;
  readonly jaw: TransformNode;
  readonly dispose: () => void;
}

export interface GreatWhitePose {
  readonly phase: 'cruise' | 'strike' | 'recover';
  readonly tailYaw: number;
  readonly bodyRoll: number;
  readonly jawOpen: number;
  readonly thrust: number;
}
