// Grass (GRAS): plants the engine scatters over the landscape, by land texture (LTEX GNAM),
// in loaded cells. Placement follows each grass type's density, slope range and distance to
// water, with random offsets, sizes and shades. Platform-independent.
// Layout and rules: docs/formats/esm.md ("Grass").

import { view } from '../formats/esm/fields.ts';
import { CELL_SIZE, LAND_GRID, LAND_SPACING, QUADRANT_GRID, type LandData } from './land.ts';
import type { GameRecord } from './record-db.ts';

/** GRAS DATA flags. */
export const GrassFlag = {
  vertexLighting: 0x1,
  uniformScaling: 0x2,
  fitToSlope: 0x4,
} as const;

/** How GRAS "units from water" is applied. */
export const WaterRule = {
  aboveAtLeast: 1,
  aboveAtMost: 2,
  belowAtLeast: 3,
  belowAtMost: 4,
  eitherAtLeast: 5,
  eitherAtMost: 6,
  eitherAtMostAbove: 7,
  eitherAtMostBelow: 8,
} as const;

export interface GrassType {
  readonly formId: number;
  readonly editorId: string;
  /** meshes\... */
  readonly model: string;
  /** Percent of the candidate points that get a plant. */
  readonly density: number;
  /** Degrees from flat. */
  readonly minSlope: number;
  readonly maxSlope: number;
  readonly waterDistance: number;
  /** WaterRule; 0: water does not matter. */
  readonly waterRule: number;
  /** Random offset from the grid point (units). */
  readonly positionRange: number;
  /** Random size change (fraction). */
  readonly heightRange: number;
  /** Random darkening (fraction). */
  readonly colorRange: number;
  /** Seconds per sway in the wind. */
  readonly wavePeriod: number;
  readonly flags: number;
}

export function parseGrass(record: Pick<GameRecord, 'formId' | 'editorId' | 'fields'>): GrassType {
  const data = record.fields.first('DATA') ?? new Uint8Array(32);
  const d = view(data);
  const f32 = (offset: number): number =>
    offset + 4 <= data.length ? d.getFloat32(offset, true) : 0;
  const model = (record.fields.zstring('MODL') ?? '').replaceAll('/', '\\').toLowerCase();
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    model: model === '' ? '' : model.startsWith('meshes\\') ? model : `meshes\\${model}`,
    density: data[0] ?? 0,
    minSlope: data[1] ?? 0,
    maxSlope: data[2] ?? 90,
    waterDistance: data.length >= 6 ? d.getUint16(4, true) : 0,
    waterRule: data.length >= 12 ? d.getUint32(8, true) : 0,
    positionRange: f32(12),
    heightRange: f32(16),
    colorRange: f32(20),
    wavePeriod: f32(24),
    flags: data[28] ?? 0,
  };
}

/** iMinGrassSize: spacing (units) of the points where grass may grow. */
export const GRASS_SPACING = 20;

export interface GrassInstance {
  readonly position: readonly [number, number, number];
  /** Terrain normal (fit to slope). */
  readonly normal: readonly [number, number, number];
  /** Z rotation (radians). */
  readonly rotation: number;
  /** Size across and up (they differ without uniform scaling). */
  readonly scaleXY: number;
  readonly scaleZ: number;
  /** Brightness factor (1 − up to colorRange). */
  readonly shade: number;
}

/** Deterministic hash of grid point and grass type to [0, 1). */
function random(x: number, y: number, salt: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Bilinear sample of a 33×33 land grid at cell-local position (units). */
function sampleGrid(
  grid: Float32Array,
  stride: number,
  component: number,
  x: number,
  y: number,
): number {
  const gx = Math.min(LAND_GRID - 1.001, Math.max(0, x / LAND_SPACING));
  const gy = Math.min(LAND_GRID - 1.001, Math.max(0, y / LAND_SPACING));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = gx - x0;
  const ty = gy - y0;
  const at = (ix: number, iy: number): number =>
    grid[(iy * LAND_GRID + ix) * stride + component] ?? 0;
  return (
    at(x0, y0) * (1 - tx) * (1 - ty) +
    at(x0 + 1, y0) * tx * (1 - ty) +
    at(x0, y0 + 1) * (1 - tx) * ty +
    at(x0 + 1, y0 + 1) * tx * ty
  );
}

/**
 * How much of each land texture covers a cell-local position (the quadrant's base and its
 * layers, each layer covering those below by its opacity). Undefined LTEX: the default.
 */
export function textureWeightsAt(
  land: LandData,
  x: number,
  y: number,
): Map<number | undefined, number> {
  const half = CELL_SIZE / 2;
  const quadrant = (x >= half ? 1 : 0) + (y >= half ? 2 : 0);
  const q = land.quadrants[quadrant];
  const weights = new Map<number | undefined, number>();
  if (!q) return weights;
  const qx = ((x - (quadrant & 1) * half) / half) * (QUADRANT_GRID - 1);
  const qy = ((y - (quadrant >> 1) * half) / half) * (QUADRANT_GRID - 1);
  const x0 = Math.min(QUADRANT_GRID - 2, Math.max(0, Math.floor(qx)));
  const y0 = Math.min(QUADRANT_GRID - 2, Math.max(0, Math.floor(qy)));
  const tx = Math.min(1, Math.max(0, qx - x0));
  const ty = Math.min(1, Math.max(0, qy - y0));
  weights.set(q.base, 1);
  for (const layer of q.layers) {
    const a = (ix: number, iy: number): number => layer.alpha[iy * QUADRANT_GRID + ix] ?? 0;
    const opacity = Math.min(
      1,
      Math.max(
        0,
        a(x0, y0) * (1 - tx) * (1 - ty) +
          a(x0 + 1, y0) * tx * (1 - ty) +
          a(x0, y0 + 1) * (1 - tx) * ty +
          a(x0 + 1, y0 + 1) * tx * ty,
      ),
    );
    if (opacity <= 0) continue;
    for (const [texture, weight] of weights) weights.set(texture, weight * (1 - opacity));
    weights.set(layer.texture, (weights.get(layer.texture) ?? 0) + opacity);
  }
  return weights;
}

function waterAllows(type: GrassType, height: number, water: number | undefined): boolean {
  if (type.waterRule === 0) return true;
  // No water in the cell: the plant is far above any.
  const above = water === undefined ? Infinity : height - water;
  const d = type.waterDistance;
  switch (type.waterRule) {
    case WaterRule.aboveAtLeast:
      return above >= d;
    case WaterRule.aboveAtMost:
      return above >= 0 && above <= d;
    case WaterRule.belowAtLeast:
      return -above >= d;
    case WaterRule.belowAtMost:
      return above <= 0 && -above <= d;
    case WaterRule.eitherAtLeast:
      return Math.abs(above) >= d;
    case WaterRule.eitherAtMost:
      return Math.abs(above) <= d;
    case WaterRule.eitherAtMostAbove:
      return above <= d;
    case WaterRule.eitherAtMostBelow:
      return -above <= d;
    default:
      return true;
  }
}

/**
 * Grass of a cell, by grass type: every type listed by the land textures present grows on
 * its own grid of candidate points, where its textures cover the ground, with probability
 * density × coverage.
 */
export function placeGrass(
  land: LandData,
  cellX: number,
  cellY: number,
  grassOf: (ltex: number | undefined) => readonly GrassType[],
  waterHeight: number | undefined,
  spacing = GRASS_SPACING,
): Map<GrassType, GrassInstance[]> {
  const placed = new Map<GrassType, GrassInstance[]>();
  const types = new Set<GrassType>();
  for (const quadrant of land.quadrants) {
    for (const texture of [quadrant.base, ...quadrant.layers.map((l) => l.texture)]) {
      for (const type of grassOf(texture)) types.add(type);
    }
  }
  if (types.size === 0) return placed;
  const steps = Math.floor(CELL_SIZE / spacing);
  const normals = land.normals;
  for (const type of types) {
    if (type.density <= 0 || type.model === '') continue;
    const list: GrassInstance[] = [];
    const salt = type.formId;
    const minCos = Math.cos((Math.min(90, type.maxSlope) * Math.PI) / 180);
    const maxCos = Math.cos((Math.max(0, type.minSlope) * Math.PI) / 180);
    for (let iy = 0; iy < steps; iy++) {
      for (let ix = 0; ix < steps; ix++) {
        const gx = cellX * steps + ix;
        const gy = cellY * steps + iy;
        const chance = random(gx, gy, salt);
        if (chance >= type.density / 100) continue;
        const ox = (random(gx, gy, salt + 1) * 2 - 1) * type.positionRange;
        const oy = (random(gx, gy, salt + 2) * 2 - 1) * type.positionRange;
        const x = Math.min(CELL_SIZE - 1, Math.max(0, (ix + 0.5) * spacing + ox));
        const y = Math.min(CELL_SIZE - 1, Math.max(0, (iy + 0.5) * spacing + oy));
        let coverage = 0;
        for (const [texture, weight] of textureWeightsAt(land, x, y)) {
          if (grassOf(texture).includes(type)) coverage += weight;
        }
        if (chance >= (type.density / 100) * coverage) continue;
        const normal: [number, number, number] = normals
          ? [
              sampleGrid(normals, 3, 0, x, y),
              sampleGrid(normals, 3, 1, x, y),
              sampleGrid(normals, 3, 2, x, y),
            ]
          : [0, 0, 1];
        const length = Math.hypot(...normal) || 1;
        const up = normal[2] / length;
        if (up < minCos - 1e-6 || up > maxCos + 1e-6) continue;
        const height = sampleGrid(land.heights, 1, 0, x, y);
        if (!waterAllows(type, height, waterHeight)) continue;
        const size = 1 + (random(gx, gy, salt + 3) * 2 - 1) * type.heightRange;
        const uniform = (type.flags & GrassFlag.uniformScaling) !== 0;
        list.push({
          position: [cellX * CELL_SIZE + x, cellY * CELL_SIZE + y, height],
          normal:
            (type.flags & GrassFlag.fitToSlope) !== 0
              ? [normal[0] / length, normal[1] / length, normal[2] / length]
              : [0, 0, 1],
          rotation: random(gx, gy, salt + 4) * Math.PI * 2,
          scaleXY: uniform ? size : 1,
          scaleZ: size,
          shade: 1 - random(gx, gy, salt + 5) * type.colorRange,
        });
      }
    }
    if (list.length > 0) placed.set(type, list);
  }
  return placed;
}
