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
