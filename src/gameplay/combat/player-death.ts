// The player's death (docs/ai.md, "Combat"; UESP "Skyrim:Death"): their body goes limp as an
// NPC's does, the camera goes to the bleedout camera (CommonLibSSE BleedoutCameraState: the
// engine starts it for the dead player too) and stays on the body, and fPlayerDeathReloadTime
// (5 s) after the death the game loads the most recent save. The wait runs on the game's clock
// (a menu opened meanwhile, the journal's system page, holds it). The camera: in
// [Camera] iBleedoutTransitionMillis (500 ms) from where it was to its place behind the body,
// looking down at it, pulled back from fVanityModeMinDist (155) to fDefaultAutoVanityZoom (300)
// over the wait, slowly going round it. TODO(M13): the bleedout camera's pitch, the speed it
// goes round at and how far it pulls back are not documented (its state keeps a zoom, a pitch,
// a yaw and a random heading); those below are ours. Platform-independent.

/** The settings of the player's death. */
export interface PlayerDeathSettings {
  /** GMST fPlayerDeathReloadTime: seconds from the death to the reload. */
  readonly reloadTime: number;
  /** [Camera] iBleedoutTransitionMillis: the camera's move into the death camera (s). */
  readonly transition: number;
  /** [Camera] fCameraCasterBleedOutSize: the death camera's sphere against walls (units). */
  readonly casterSize: number;
  /** [Camera] fVanityModeMinDist: how far from the body the camera begins (units). */
  readonly startDistance: number;
  /** [Camera] fDefaultAutoVanityZoom: how far it has pulled back at the reload (units). */
  readonly endDistance: number;
}

export const PLAYER_DEATH_DEFAULTS: PlayerDeathSettings = {
  reloadTime: 5,
  transition: 0.5,
  casterSize: 5,
  startDistance: 155,
  endDistance: 300,
};

/** How far below the level the camera looks down at the body (radians). TODO(M13). */
export const DEATH_CAMERA_PITCH = -0.45;
/** How fast it goes round the body (radians a second). TODO(M13). */
export const DEATH_CAMERA_ORBIT = 0.15;

/**
 * The settings from the load order's game settings (`gameSetting`: a GMST's number) and the
 * INI's (`ini`: a [Camera] number).
 */
export function readPlayerDeathSettings(
  gameSetting: (editorId: string) => number | undefined,
  ini: (key: string) => number | undefined,
): PlayerDeathSettings {
  const d = PLAYER_DEATH_DEFAULTS;
  const transition = ini('iBleedoutTransitionMillis');
  return {
    reloadTime: gameSetting('fPlayerDeathReloadTime') ?? d.reloadTime,
    transition: transition === undefined ? d.transition : transition / 1000,
    casterSize: ini('fCameraCasterBleedOutSize') ?? d.casterSize,
    startDistance: ini('fVanityModeMinDist') ?? d.startDistance,
    endDistance: ini('fDefaultAutoVanityZoom') ?? d.endDistance,
  };
}

/** Where the death camera looks from, about the body. */
export interface DeathCameraOrbit {
  /** The compass heading it looks along (radians: 0 north, π/2 east). */
  readonly yaw: number;
  /** Up (positive) or down from the level (radians). */
  readonly pitch: number;
  /** How far from the body (units). */
  readonly distance: number;
  /** How far it has come from where the camera was at the death (0 .. 1). */
  readonly blend: number;
}

/**
 * The death camera `elapsed` seconds after the death: behind the body as the camera looked
 * (`heading`), going round it one way (`turn`: 1 or −1), pulling back over the reload's wait.
 */
export function deathCameraOrbit(
  elapsed: number,
  heading: number,
  turn: number,
  settings: PlayerDeathSettings,
): DeathCameraOrbit {
  const t = Math.max(0, elapsed);
  const wait = Math.max(1e-3, settings.reloadTime);
  // Eased out: it pulls back quickly at first, then settles.
  const pull = 1 - (1 - Math.min(1, t / wait)) ** 2;
  const linear = Math.min(1, t / Math.max(1e-3, settings.transition));
  return {
    yaw: heading + Math.sign(turn || 1) * DEATH_CAMERA_ORBIT * t,
    pitch: DEATH_CAMERA_PITCH,
    distance: settings.startDistance + (settings.endDistance - settings.startDistance) * pull,
    // Smoothstep: it leaves where it was and arrives without a jolt.
    blend: linear * linear * (3 - 2 * linear),
  };
}

/** The wait from the death to the reload, on the game's clock. */
export class PlayerDeathTimer {
  readonly settings: PlayerDeathSettings;
  #elapsed = 0;
  #due = false;

  constructor(settings: PlayerDeathSettings) {
    this.settings = settings;
  }

  /** Seconds since the death (the game's: not in menus). */
  get elapsed(): number {
    return this.#elapsed;
  }

  /** Whether the reload has come due. */
  get due(): boolean {
    return this.#due;
  }

  /** The game's clock went on by `seconds`; true once, as the reload comes due. */
  advance(seconds: number): boolean {
    if (this.#due) return false;
    this.#elapsed += Math.max(0, seconds);
    if (this.#elapsed < this.settings.reloadTime) return false;
    this.#due = true;
    return true;
  }
}
