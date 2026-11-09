// The player camera's states (docs/rendering.md, "Cameras"; CommonLibSSE PlayerCamera's
// CameraStates, in the engine's order): first person, auto vanity, VATS (the kill cameras), the
// free camera, iron sights, furniture, the transition between first and third person, the tween
// menu's, an animated camera, third person, a mount's (HorseCameraState), bleedout and a
// dragon's (DragonCameraState). One state is the camera's at a time; here it is worked out each
// frame from what the player is doing, the one asked for first in the engine's order of
// precedence (the kill camera and the free camera over everything, the player's own view last).
//
// The auto vanity camera (AutoVanityState): after fAutoVanityModeDelay seconds of the player
// doing nothing (no key, no mouse, standing) it slowly circles the player fDefaultAutoVanityZoom
// units away, fAutoVanityIncrement radians each 60th of a second; any input ends it and the
// camera is the player's again, as it was. bDisableAutoVanityMode keeps it from starting,
// bForceAutoVanityMode starts it at once. The mount's camera is third person's with the horse's
// shoulder offsets ([Camera] fOverShoulderHorse*); a dragon's is third person zoomed between
// fVanityModeMinDistFly and fVanityModeMaxDist x fVanityModeMaxDistFlyMult, never first person.
//
// The dragon's camera (DragonCameraState, observed in the original; docs/rendering.md,
// "Cameras"): its shoulder offsets are [Camera] fOverShoulderDragon* (600 units farther back), or
// with a weapon or spell drawn the GMSTs fOverShoulderRangedDragon* (150 back, 90 up). Its
// heading is the dragon's plus the player's own turn about it, so the view turns with the dragon.
// Only a ridden mount that is horse-like (the ActorTypeHorse keyword, or its race tilts front to
// back) and moves keeps the view's heading in the world as it turns beneath it, never more than
// fDragonMaxAngleBeforeTurn degrees from its heading: no vanilla dragon is. Locked on a target (the dragon's attack target the player set) it looks from the
// player at that target instead. Each change between the two (a lock, a new target, the lock
// let go) eases from the last view to the new one in fDragonCameraDollyTime seconds, the heading
// and pitch each a straight blend. bDragonCameraTargetPlayer (1) keeps the camera on the player;
// 0 hangs it on the dragon (while unlocked).
// Platform-free.

/** The engine's camera states (CommonLibSSE CameraStates, SE order). */
export const CameraState = {
  firstPerson: 0,
  autoVanity: 1,
  vats: 2,
  free: 3,
  ironSights: 4,
  furniture: 5,
  transition: 6,
  tween: 7,
  animated: 8,
  thirdPerson: 9,
  mount: 10,
  bleedout: 11,
  dragon: 12,
} as const;
export type CameraState = (typeof CameraState)[keyof typeof CameraState];

/** What the player is doing that the camera's state follows. */
export interface CameraConditions {
  readonly pov: 'first' | 'third';
  /** The console's tfc. */
  readonly free?: boolean;
  /** A kill camera plays (a killmove's, a ranged kill's: the engine's VATS camera). */
  readonly killCamera?: boolean;
  /** The tween menu is open. */
  readonly tween?: boolean;
  /** The player's graph runs an animated camera (StartAnimatedCamera). */
  readonly animated?: boolean;
  /** Furniture with a camera of its own holds the player (a workbench, a bed). */
  readonly furniture?: boolean;
  /** The player bleeds out, lies knocked down or dead (the bleedout camera). */
  readonly bleedout?: boolean;
  /** The auto vanity camera circles the player. */
  readonly vanity?: boolean;
  /** What the player rides. */
  readonly mount?: 'horse' | 'dragon' | undefined;
}

/** The camera's state for what the player is doing, by the engine's precedence. */
export function cameraState(c: CameraConditions): CameraState {
  if (c.killCamera) return CameraState.vats;
  if (c.free) return CameraState.free;
  if (c.tween) return CameraState.tween;
  if (c.animated) return CameraState.animated;
  if (c.bleedout) return CameraState.bleedout;
  if (c.furniture) return CameraState.furniture;
  if (c.vanity) return CameraState.autoVanity;
  // A dragon's back is always seen from behind.
  if (c.mount === 'dragon') return CameraState.dragon;
  if (c.pov === 'first') return CameraState.firstPerson;
  return c.mount === 'horse' ? CameraState.mount : CameraState.thirdPerson;
}

/** The [Camera] settings of the auto vanity camera. */
export interface VanitySettings {
  /** fAutoVanityModeDelay: seconds without input before it starts. */
  readonly delay: number;
  /** fAutoVanityIncrement: radians it turns each 60th of a second. */
  readonly increment: number;
  /** fDefaultAutoVanityZoom: how far from the player it circles (units). */
  readonly zoom: number;
  /** bDisableAutoVanityMode. */
  readonly disabled: boolean;
  /** bForceAutoVanityMode. */
  readonly forced: boolean;
}

/**
 * The auto vanity camera's clock: idle seconds counted while the player does nothing and may
 * idle (`allowed`), its turn about the player once it runs.
 */
export class AutoVanity {
  #idle = 0;
  /** The turn about the player (radians, added to the heading it started from). */
  #turn: number | undefined;
  /** The heading it started from (the camera's then). */
  #from = 0;

  /** Whether it circles the player now. */
  get active(): boolean {
    return this.#turn !== undefined;
  }

  /** The camera's heading about the player while it runs (compass radians). */
  get yaw(): number {
    return this.#from + (this.#turn ?? 0);
  }

  /**
   * Any input from the player: the idle clock starts again, and a running vanity camera ends
   * (true: it did).
   */
  input(): boolean {
    this.#idle = 0;
    const ended = this.#turn !== undefined;
    this.#turn = undefined;
    return ended;
  }

  /**
   * Steps the clock: `idle` whether the player did nothing this frame, `allowed` whether the
   * vanity camera may run (no combat, no menu, nothing driving the camera). Returns true the
   * frame it starts (from the camera's heading `yaw`).
   */
  step(seconds: number, idle: boolean, allowed: boolean, yaw: number, s: VanitySettings): boolean {
    if (!allowed || s.disabled) {
      this.#idle = 0;
      this.#turn = undefined;
      return false;
    }
    if (!idle) {
      this.input();
      return false;
    }
    if (this.#turn !== undefined) {
      // TODO(M13): the engine steps it per update; here per 60th of a second, as at 60 fps.
      this.#turn += s.increment * seconds * 60;
      return false;
    }
    this.#idle += seconds;
    if (!s.forced && this.#idle < s.delay) return false;
    this.#from = yaw;
    this.#turn = 0;
    return true;
  }
}

/** The third-person camera's shoulder offset riding a horse (x right, y back, z up). */
export function horseShoulder(
  number: (
    key: 'fOverShoulderHorsePosX' | 'fOverShoulderHorseAddY' | 'fOverShoulderHorsePosZ',
  ) => number,
): [number, number, number] {
  return [
    number('fOverShoulderHorsePosX'),
    -number('fOverShoulderHorseAddY'),
    number('fOverShoulderHorsePosZ'),
  ];
}

/**
 * The third-person camera's shoulder offset on a dragon's back (x right, y back, z up): the
 * dragon's [Camera] offsets, or with a weapon or spell drawn the ranged ones (GMSTs).
 */
export function dragonShoulder(
  number: (
    key: 'fOverShoulderDragonPosX' | 'fOverShoulderDragonAddY' | 'fOverShoulderDragonPosZ',
  ) => number,
  ranged: readonly [number, number, number],
  drawn: boolean,
): [number, number, number] {
  if (drawn) return [ranged[0], -ranged[1], ranged[2]];
  return [
    number('fOverShoulderDragonPosX'),
    -number('fOverShoulderDragonAddY'),
    number('fOverShoulderDragonPosZ'),
  ];
}

/** The dragon camera's [Camera] settings. */
export interface DragonCameraSettings {
  /** fDragonMaxAngleBeforeTurn: how far (radians) the view may turn from a moving dragon. */
  readonly maxAngle: number;
  /** fDragonCameraDollyTime: seconds of the ease between the free view and a locked one. */
  readonly dollyTime: number;
}

/** What the dragon camera follows this frame. */
export interface DragonCameraInput {
  /** The player's view (compass radians, pitch up positive), as their input turned it. */
  readonly yaw: number;
  readonly pitch: number;
  /** The ridden dragon's heading (compass radians). */
  readonly heading: number;
  /**
   * The mount moves and is horse-like (ActorTypeHorse, or its race tilts front to back): the
   * view is held against its turns. No vanilla dragon is.
   */
  readonly holds: boolean;
  /** The locked target: its reference, and the pitch and heading from the player to it. */
  readonly locked?:
    { readonly reference: number; readonly yaw: number; readonly pitch: number } | undefined;
}

/** The heading (compass radians) and pitch (up positive) from one point to another. */
export function lookAngles(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): { readonly yaw: number; readonly pitch: number } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return { yaw: Math.atan2(dx, dy), pitch: Math.atan2(to[2] - from[2], Math.hypot(dx, dy)) };
}

const wrapAngle = (a: number): number => {
  if (a > Math.PI || a < -Math.PI) {
    const t = (a + Math.PI) % (2 * Math.PI);
    return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
  }
  return a;
};

/**
 * The horse's camera state's view (HorseCameraState): the player's view (compass radians) as a
 * ridden horse turns beneath it. While the horse moves the view keeps its heading in the world,
 * and the horse steers to it (src/ai/mounts.ts riddenRequest); turned farther than
 * fHorseMaxAngleBeforeTurn (`maxAngle`, radians; 90°) from the horse's heading, the horse's
 * turns take the view along at that angle. A standing horse leaves the view free (the player
 * looks round it). TODO(M13): inferred, the dragon camera's rule for a horse-like mount
 * (fDragonMaxAngleBeforeTurn, observed in the original) applied to the horse's own setting.
 */
export function horseViewYaw(
  yaw: number,
  heading: number,
  moving: boolean,
  maxAngle: number,
): number {
  if (!moving) return yaw;
  const offset = wrapAngle(yaw - heading);
  if (Math.abs(offset) <= maxAngle) return yaw;
  // The view goes back to the limit (its own winding kept: the yaw is not wrapped).
  return yaw - offset + Math.sign(offset) * maxAngle;
}

/**
 * The dragon's camera state: the player's view turning with the dragon (or held against its
 * turns while it moves), the lock on a target and the ease between them.
 */
export class DragonCamera {
  /** The mount's heading at the last frame (its turn since). */
  #lastHeading: number | undefined;
  /** The ease: its progress (0..1), where it starts and where it goes (heading, pitch). */
  #progress = 1;
  #from: readonly [number, number] = [0, 0];
  #to: readonly [number, number] = [0, 0];
  /** The target locked last frame, if any. */
  #locked: number | undefined;

  /** The camera is the dragon's again (riding begins): no ease, the view as it is. */
  reset(heading: number, yaw: number, pitch: number): void {
    this.#lastHeading = heading;
    this.#progress = 1;
    this.#from = this.#to = [yaw, pitch];
    this.#locked = undefined;
  }

  /**
   * One frame: the player's own heading after the dragon's turn (`yaw`, what their input keeps
   * turning) and the view's heading and pitch.
   */
  step(
    input: DragonCameraInput,
    seconds: number,
    s: DragonCameraSettings,
  ): { readonly yaw: number; readonly view: readonly [number, number] } {
    // The player's view is kept as a turn about the mount's heading.
    const turned = wrapAngle(input.heading - (this.#lastHeading ?? input.heading));
    this.#lastHeading = input.heading;
    let yaw: number;
    if (input.holds) {
      // Held in the world as the mount turns, up to the angle from its heading.
      const offset = wrapAngle(input.yaw - input.heading);
      yaw = input.heading + Math.min(s.maxAngle, Math.max(-s.maxAngle, offset));
    } else {
      // The view turns with the mount.
      yaw = input.heading + wrapAngle(input.yaw + turned - input.heading);
    }
    const locked = input.locked;
    if (locked) {
      if (this.#locked !== locked.reference) {
        // A lock, or a new target: the ease starts from where the view was going.
        this.#from = this.#to;
        this.#progress = 0;
        this.#locked = locked.reference;
      }
      this.#to = [wrapAngle(locked.yaw), locked.pitch];
    } else {
      if (this.#locked !== undefined) {
        this.#from = this.#to;
        this.#progress = 0;
        this.#locked = undefined;
      }
      this.#to = [wrapAngle(yaw), input.pitch];
    }
    const p = s.dollyTime > 0 ? this.#progress : 1;
    const view: [number, number] = [
      this.#from[0] + (this.#to[0] - this.#from[0]) * p,
      this.#from[1] + (this.#to[1] - this.#from[1]) * p,
    ];
    if (this.#progress < 1 && s.dollyTime > 0) {
      this.#progress = Math.min(1, Math.max(0, this.#progress + seconds / s.dollyTime));
    }
    return { yaw, view };
  }
}

/** The third-person zoom's ends (units): a dragon's back widens them. */
export function zoomRange(
  number: (
    key:
      | 'fVanityModeMinDist'
      | 'fVanityModeMaxDist'
      | 'fVanityModeMinDistFly'
      | 'fVanityModeMaxDistFlyMult',
  ) => number,
  mount: 'horse' | 'dragon' | undefined,
): readonly [number, number] {
  if (mount === 'dragon') {
    return [
      number('fVanityModeMinDistFly'),
      number('fVanityModeMaxDist') * number('fVanityModeMaxDistFlyMult'),
    ];
  }
  return [number('fVanityModeMinDist'), number('fVanityModeMaxDist')];
}
