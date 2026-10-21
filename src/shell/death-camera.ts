// The camera on the dead player (docs/ai.md, "Combat"): the engine's bleedout camera, third
// person on the body (src/gameplay/combat/player-death.ts: where it looks from, how it moves
// in and pulls back). It looks at a bone of the ragdoll (its state's animated bone: the centre
// of mass, else the pelvis or the root) as the body falls, kept out of walls by a sphere of
// fCameraCasterBleedOutSize on L_CAMERA (passing the body itself).

import { deathCameraOrbit, type PlayerDeathSettings } from '../gameplay/combat/player-death.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import {
  lookAt,
  multiply,
  perspectiveReversedZ,
  transformPoint,
  type Mat4,
  type Vec3,
} from '../render/math.ts';
import type { Camera } from '../render/view-camera.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { PlacedActor } from './actors.ts';

/** The bones the camera looks at, the first the skeleton has (creatures have their own). */
const LOOK_BONES = ['NPC COM [COM ]', 'NPC Pelvis [Pelv]', 'NPC Root [Root]'];
/** Without such a bone: this high over where the body lies (units). */
const BODY_MIDDLE = 64;

export interface DeathCameraOptions {
  /** The camera at the death: the death camera moves from there. */
  readonly from: { readonly position: Vec3; readonly forward: Vec3 };
  /** The dead player's body (its pose is its ragdoll's), at its placement. */
  readonly body: PlacedActor | undefined;
  readonly world: Mat4;
  readonly physics: PhysicsWorld;
  readonly settings: PlayerDeathSettings;
  /** The view's field of view (radians, vertical), near plane and lens shift: the player's. */
  readonly lens: { readonly fovY: number; readonly near: number; readonly lensShift: number };
  /** Which way it goes round the body (1 or −1). */
  readonly turn: number;
}

export class DeathCamera implements Camera {
  readonly near: number;
  position: Vec3;
  forward: Vec3;
  /** Seconds since the death, on the game's clock (src/shell/player-death.ts sets it). */
  elapsed = 0;
  readonly #options: DeathCameraOptions;
  readonly #from: { readonly position: Vec3; readonly forward: Vec3 };
  /** The compass heading the camera looked along at the death: it stays behind the body so. */
  readonly #heading: number;

  constructor(options: DeathCameraOptions) {
    this.#options = options;
    this.near = options.lens.near;
    this.#from = { position: [...options.from.position], forward: [...options.from.forward] };
    this.position = [...this.#from.position];
    this.forward = [...this.#from.forward];
    const [fx, fy] = this.#from.forward;
    this.#heading = Math.hypot(fx, fy) > 1e-6 ? Math.atan2(fx, fy) : 0;
    this.update();
  }

  /** Where the camera looks: the ragdoll's bone in the world. */
  #target(): Vec3 {
    const { body, world } = this.#options;
    for (const name of LOOK_BONES) {
      const node = body?.pose.world(name);
      if (node) return transformPoint(multiply(world, node), [0, 0, 0]);
    }
    return [world[12] ?? 0, world[13] ?? 0, (world[14] ?? 0) + BODY_MIDDLE];
  }

  update(): void {
    const { physics, settings, turn } = this.#options;
    const target = this.#target();
    const orbit = deathCameraOrbit(this.elapsed, this.#heading, turn, settings);
    const c = Math.cos(orbit.pitch);
    const look: Vec3 = [Math.sin(orbit.yaw) * c, Math.cos(orbit.yaw) * c, Math.sin(orbit.pitch)];
    const back: Vec3 = [-look[0], -look[1], -look[2]];
    // Walls between the body and the camera bring it in (the body's own bodies do not).
    const reach = physics.queriesCurrent
      ? physics.sphereCast(
          target,
          back,
          orbit.distance,
          settings.casterSize,
          Layer.camera,
          undefined,
          (owner) => owner?.reference === PLAYER_REF,
        )
      : orbit.distance;
    const at: Vec3 = [
      target[0] + back[0] * reach,
      target[1] + back[1] * reach,
      target[2] + back[2] * reach,
    ];
    // From where the camera was to its place by the blend.
    const b = orbit.blend;
    const from = this.#from;
    this.position = [
      from.position[0] + (at[0] - from.position[0]) * b,
      from.position[1] + (at[1] - from.position[1]) * b,
      from.position[2] + (at[2] - from.position[2]) * b,
    ];
    // It turns to the body as it moves.
    const toBody: Vec3 = [
      target[0] - this.position[0],
      target[1] - this.position[1],
      target[2] - this.position[2],
    ];
    const length = Math.hypot(...toBody);
    const aim: Vec3 =
      length > 1e-3 ? [toBody[0] / length, toBody[1] / length, toBody[2] / length] : look;
    const way: Vec3 = [
      from.forward[0] + (aim[0] - from.forward[0]) * b,
      from.forward[1] + (aim[1] - from.forward[1]) * b,
      from.forward[2] + (aim[2] - from.forward[2]) * b,
    ];
    const wayLength = Math.hypot(...way) || 1;
    this.forward = [way[0] / wayLength, way[1] / wayLength, way[2] / wayLength];
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const lens = this.#options.lens;
    const target: Vec3 = [
      this.position[0] + this.forward[0],
      this.position[1] + this.forward[1],
      this.position[2] + this.forward[2],
    ];
    const view = lookAt(this.position, target, [0, 0, 1]);
    const projection = perspectiveReversedZ(lens.fovY, aspect, this.near);
    projection[8] = -lens.lensShift;
    return multiply(projection, view, out);
  }
}
