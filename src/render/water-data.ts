// Geometry for water planes (a cell's water, an interior's water level). Platform-independent.

import { identity } from './math.ts';
import type { ModelData } from './model-data.ts';

/** BSWaterShaderProperty-like material for engine-made water planes. */
const PLANE_MATERIAL = {
  kind: 'water',
  flags1: 0,
  flags2: 0,
  uvOffset: [0, 0],
  uvScale: [1, 1],
  waterFlags: 0,
} as const;

/** A flat water plane over a rectangle (world units) at a height. */
export function waterPlane(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  height: number,
): ModelData {
  const vertices = new Float32Array([
    minX,
    minY,
    height,
    maxX,
    minY,
    height,
    maxX,
    maxY,
    height,
    minX,
    maxY,
    height,
  ]);
  const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, height];
  const radius = Math.hypot(maxX - minX, maxY - minY) / 2;
  return {
    parts: [
      {
        name: 'water plane',
        block: -1,
        shader: -1,
        alphaProperty: -1,
        world: identity(),
        layout: { stride: 12, attributes: 0x1, uv: -1, normal: -1, tangent: -1, color: -1 },
        vertices: new Uint8Array(vertices.buffer),
        vertexCount: 4,
        // Counter-clockwise seen from above.
        indices: Uint16Array.from([0, 1, 2, 0, 2, 3]),
        material: PLANE_MATERIAL,
        alpha: undefined,
        center,
        radius,
      },
    ],
    center,
    radius,
    skipped: [],
    editorMarker: false,
  };
}
