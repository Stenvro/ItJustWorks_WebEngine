// Converts a cell's lighting (XCLL / lighting template, placed lights) into what the
// renderer uses.

import type { Vec3 } from '../render/math.ts';
import { flatAmbient, type SceneLighting } from '../render/scene-renderer.ts';
import type { CellData } from './cell-loader.ts';

const DEGREES = Math.PI / 180;

/** Direction towards the cell's directional light (rotation XY = elevation, Z = heading). */
function directionalLightDirection(rotationXY: number, rotationZ: number): Vec3 {
  const elevation = rotationXY * DEGREES;
  const heading = rotationZ * DEGREES;
  return [
    Math.cos(elevation) * Math.sin(heading),
    Math.cos(elevation) * Math.cos(heading),
    Math.sin(elevation),
  ];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * Lighting for an interior cell. The ambient term is the cell's ambient colour plus its
 * directional ambient per axis; the directional light and fog come straight from XCLL.
 * TODO(M4): exterior cells (sun and weather), light fade distances, shadows.
 */
export function cellSceneLighting(data: CellData): SceneLighting {
  const lighting = data.lighting;
  const lights = data.lights.map((light) => ({
    position: light.position,
    radius: light.radius,
    color: [
      light.color[0] * light.fade,
      light.color[1] * light.fade,
      light.color[2] * light.fade,
    ] as Vec3,
  }));
  if (!lighting) {
    return {
      sunDirection: [0, 0, 1],
      sunColor: [0, 0, 0],
      ambient: flatAmbient([0.25, 0.25, 0.25]),
      fog: undefined,
      lights,
    };
  }
  const dalc = lighting.directionalAmbient;
  const base = lighting.ambient;
  return {
    sunDirection: directionalLightDirection(
      lighting.directionalRotationXY,
      lighting.directionalRotationZ,
    ),
    sunColor: lighting.directional,
    ambient: [
      add(base, dalc.xPositive),
      add(base, dalc.xNegative),
      add(base, dalc.yPositive),
      add(base, dalc.yNegative),
      add(base, dalc.zPositive),
      add(base, dalc.zNegative),
    ],
    fog: {
      nearColor: lighting.fogNearColor,
      farColor: lighting.fogFarColor,
      near: lighting.fogNear,
      far: lighting.fogFar,
      power: lighting.fogPower,
      max: lighting.fogMax,
    },
    lights,
  };
}
