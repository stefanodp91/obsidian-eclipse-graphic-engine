export const CHUNK_WIDTH = 24;

export interface GateSpec {
  readonly x: number;
  readonly openingY: number;
  readonly openingHeight: number;
  readonly kind: 'reef' | 'rock';
}

export interface PreySpec {
  readonly x: number;
  readonly y: number;
  readonly species: 'sardine' | 'squid';
  readonly phase: number;
}

export interface ChunkSpec {
  readonly index: number;
  readonly gate: GateSpec | null;
  readonly prey: readonly PreySpec[];
}

function noise(index: number, salt: number): number {
  let value = Math.imul(index + 17, 0x45d9f3b) ^ Math.imul(salt + 31, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}

export function createChunkSpec(index: number): ChunkSpec {
  const schoolY = -1.9 + noise(index, 1) * 4.1;
  const sardines = Array.from({ length: 10 }, (_, fish) => ({
    x: index === 0 && fish === 0 ? 6 : 5 + (fish % 5) * 0.76 + noise(index, 20 + fish) * 0.16,
    y: index === 0 && fish === 0 ? -1.8 : schoolY + (Math.floor(fish / 5) - 0.5) * 0.46 + (noise(index, 60 + fish) - 0.5) * 0.12,
    species: 'sardine' as const,
    phase: index === 0 && fish === 0 ? 4.7 : noise(index, 40 + fish) * Math.PI * 2,
  }));
  const prey: PreySpec[] = [...sardines];
  if (index > 0 && noise(index, 7) > 0.48) {
    prey.push({ x: 18, y: -0.6 + noise(index, 8) * 2.8, species: 'squid', phase: noise(index, 9) * Math.PI * 2 });
  }
  if (index < 2) return { index, gate: null, prey };

  const openingY = -1.2 + noise(index, 2) * 3.5;
  return {
    index,
    gate: {
      x: 12 + noise(index, 3) * 3.5,
      openingY,
      openingHeight: 4.4 + noise(index, 4) * 0.9,
      kind: noise(index, 5) > 0.5 ? 'reef' : 'rock',
    },
    prey,
  };
}
