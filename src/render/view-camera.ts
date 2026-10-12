// What the renderer looks through: a position and a view-projection, updated every frame.

import type { Mat4, Vec3 } from './math.ts';

export interface Camera {
  readonly position: Vec3;
  /** Near plane of the projection. */
  readonly near: number;
  update(deltaSeconds: number): void;
  viewProjection(aspect: number, out?: Mat4): Mat4;
}
