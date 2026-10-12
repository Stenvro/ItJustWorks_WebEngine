import type { OrbitCamera } from './camera.ts';
import type { Vec3 } from './math.ts';
import { flatAmbient, type SceneLighting } from './scene-renderer.ts';

function normalize(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...v) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * Studio light for the model viewer: a warm key light from the camera's upper left plus
 * cool ambient, so a model is always lit from the side you look at.
 */
export function studioLighting(camera: OrbitCamera): SceneLighting {
  const eye = camera.position;
  const toCamera = normalize([
    eye[0] - camera.target[0],
    eye[1] - camera.target[1],
    eye[2] - camera.target[2],
  ]);
  const up: Vec3 = camera.upVector;
  const right = normalize([
    up[1] * toCamera[2] - up[2] * toCamera[1],
    up[2] * toCamera[0] - up[0] * toCamera[2],
    up[0] * toCamera[1] - up[1] * toCamera[0],
  ]);
  const key = (k: 0 | 1 | 2): number => -0.5 * right[k] + 0.55 * up[k] + 0.65 * toCamera[k];
  return {
    sunDirection: normalize([key(0), key(1), key(2)]),
    sunColor: [1.05, 0.98, 0.88],
    ambient: flatAmbient([0.3, 0.33, 0.38]),
    fog: undefined,
    lights: [],
  };
}
