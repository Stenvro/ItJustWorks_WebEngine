// What the renderer looks through: a position and a view-projection, updated every frame.

import type { Mat4, Vec3 } from './math.ts';

export interface Camera {
  readonly position: Vec3;
  /** Near plane of the projection. */
  readonly near: number;
  /** The direction looked along (the audio listener's facing), if the camera knows it. */
  readonly forward?: Vec3;
  /** The vertical field of view (radians), if the camera knows it. */
  readonly fovY?: number;
  update(deltaSeconds: number): void;
  viewProjection(aspect: number, out?: Mat4): Mat4;
  /**
   * The first-person geometry's view-projection: the last viewProjection's view with first
   * person's own field of view and near plane; undefined: the camera's own (no first person).
   */
  firstPersonViewProjection?(aspect: number, out?: Mat4): Mat4 | undefined;
}
