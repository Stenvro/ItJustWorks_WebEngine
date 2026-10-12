// Converts a cell's lighting (XCLL / lighting template, placed lights) into what the
// renderer uses.

import type { Vec3 } from '../render/math.ts';
import { flatAmbient, type PointLight, type SceneLighting } from '../render/scene-renderer.ts';
import type { CellData, CellLight } from './cell-loader.ts';
import { FLICKERING_LIGHT_DISTANCE, lightFlicker } from './light-flicker.ts';

/** Point lights fade out from this distance to the camera (fLightLODStartFade, High)... */
export const LIGHT_LOD_START_FADE = 3500;
/** ...over this range (fLightLODRange). */
export const LIGHT_LOD_RANGE = 500;

/**
 * Placed lights at a moment, seen from `camera`: brightness (LIGH fade), flicker or pulse
 * (only near the camera) and the distance fade applied. Lights faded out completely are
 * left out; without a camera nothing fades or flickers.
 */
export function pointLights(
  lights: readonly CellLight[],
  seconds: number,
  camera?: Vec3,
): PointLight[] {
  const result: PointLight[] = [];
  for (const light of lights) {
    const distance = camera
      ? Math.hypot(
          light.position[0] - camera[0],
          light.position[1] - camera[1],
          light.position[2] - camera[2],
        )
      : 0;
    const lod = 1 - Math.min(1, Math.max(0, (distance - LIGHT_LOD_START_FADE) / LIGHT_LOD_RANGE));
    if (lod <= 0) continue;
    const flicker =
      camera && distance <= FLICKERING_LIGHT_DISTANCE
        ? lightFlicker(light, seconds, light.reference % 997)
        : STEADY;
    const brightness = light.fade * flicker.scale * lod;
    result.push({
      position: [
        light.position[0] + flicker.offset[0],
        light.position[1] + flicker.offset[1],
        light.position[2] + flicker.offset[2],
      ],
      radius: light.radius,
      color: [
        light.color[0] * brightness,
        light.color[1] * brightness,
        light.color[2] * brightness,
      ],
    });
  }
  return result;
}

const STEADY = { scale: 1, offset: [0, 0, 0] } as const;

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
 * Lights are given at time 0; per frame, replace them with `pointLights(…, seconds)`.
 */
export function cellSceneLighting(
  data: CellData,
  isEnabled: (reference: number) => boolean = () => true,
): SceneLighting {
  const lighting = data.lighting;
  const lights = pointLights(
    data.lights.filter((light) => isEnabled(light.reference)),
    0,
  );
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
