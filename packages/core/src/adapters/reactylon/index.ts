import type { Scene } from '@babylonjs/core/scene';
import { useEffect, useRef } from 'react';
import { useScene } from 'reactylon';

export type ReactylonSceneMount = (scene: Scene) => void | (() => void);

export interface ReactylonSceneBridgeProps {
  /** Mount engine-backed behavior into the scene owned by the nearest Reactylon Scene. */
  readonly mount: ReactylonSceneMount;
}

/**
 * Connects a Reactylon-owned Babylon scene to an imperative engine integration.
 *
 * Reactylon retains ownership of the Babylon engine, scene, canvas, render loop,
 * and disposal. The supplied mount function owns only the resources that it adds
 * to that scene and must return their cleanup function.
 */
export function ReactylonSceneBridge({ mount }: ReactylonSceneBridgeProps) {
  const scene = useScene();
  const mountRef = useRef(mount);
  mountRef.current = mount;

  useEffect(() => mountRef.current(scene), [scene]);

  return null;
}
