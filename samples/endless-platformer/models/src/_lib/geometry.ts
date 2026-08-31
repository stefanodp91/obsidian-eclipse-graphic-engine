import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Scene } from '@babylonjs/core/scene';

export function createMembrane(scene: Scene, name: string, points: readonly Vector3[], color: Color3): Mesh {
  const mesh = new Mesh(name, scene);
  const positions = points.flatMap((point) => [point.x, point.y, point.z]);
  const indices: number[] = [];
  for (let index = 1; index < points.length - 1; index += 1) indices.push(0, index, index + 1);
  const normals = new Array<number>(positions.length).fill(0);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = points.flatMap(() => [color.r, color.g, color.b, 1]);
  data.applyToMesh(mesh);
  return mesh;
}

export interface LoftStation {
  readonly x: number;
  readonly centerY: number;
  readonly halfHeight: number;
  readonly halfWidth: number;
}

/** Elliptical anatomical loft with independent vertical and lateral profiles. */
export function createAnatomicalLoft(
  scene: Scene,
  name: string,
  stations: readonly LoftStation[],
  radialSegments: number,
  dorsal: Color3,
  flank: Color3,
  ventral: Color3,
): Mesh {
  const mesh = new Mesh(name, scene);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const rings = Math.max(8, radialSegments);

  for (const station of stations) {
    for (let ring = 0; ring < rings; ring += 1) {
      const angle = ring / rings * Math.PI * 2;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      positions.push(
        station.x,
        station.centerY + cos * station.halfHeight,
        sin * station.halfWidth,
      );
      const vertical01 = (cos + 1) * 0.5;
      const color = vertical01 > 0.48
        ? Color3.Lerp(flank, dorsal, (vertical01 - 0.48) / 0.52)
        : Color3.Lerp(ventral, flank, vertical01 / 0.48);
      colors.push(color.r, color.g, color.b, 1);
    }
  }
  for (let station = 0; station < stations.length - 1; station += 1) {
    for (let ring = 0; ring < rings; ring += 1) {
      const next = (ring + 1) % rings;
      const a = station * rings + ring;
      const b = station * rings + next;
      const c = (station + 1) * rings + ring;
      const d = (station + 1) * rings + next;
      indices.push(a, c, b, b, c, d);
    }
  }
  const normals = new Array<number>(positions.length).fill(0);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;
  data.applyToMesh(mesh);
  return mesh;
}

export function paintCountershade(mesh: Mesh, back: Color3, flank: Color3, belly: Color3): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;
  const colors: number[] = [];
  for (let offset = 0; offset < positions.length; offset += 3) {
    const y = positions[offset + 1] ?? 0;
    const upper = Math.max(0, Math.min(1, 0.5 + y * 0.82));
    const color = upper > 0.53
      ? Color3.Lerp(flank, back, (upper - 0.53) / 0.47)
      : Color3.Lerp(belly, flank, upper / 0.53);
    colors.push(color.r, color.g, color.b, 1);
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, false, 4);
}
