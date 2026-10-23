// The player: input through the game's control map, movement at the speeds of the movement
// types (MOVT) on the character controller, jumping, swimming, and the first- and
// third-person cameras with the engine's INI settings. Its body and its animations (the
// first-person camera rides the animated Camera1st node) are the player's avatar
// (player-avatar.ts), which hooks in here.

import { DialogueCamera } from './dialogue-camera.ts';
import { CameraShake } from './camera-shake.ts';
import { TweenCamera } from './tween-camera.ts';
import type { Camera } from '../render/view-camera.ts';
import type { MoveRequest } from '../ai/locomotion.ts';
import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from '../render/math.ts';
import { parseControlMap, SCAN_CODES, type ControlMap } from '../formats/controlmap/controlmap.ts';
import type { NifFile } from '../formats/nif/nif.ts';
import { decodeWindows1252 } from '../formats/text.ts';
import {
  CharacterBody,
  type CharacterSettings,
  type CharacterShape,
} from '../physics/character.ts';
import { HAVOK_SCALE } from '../physics/collision-data.ts';
import { Layer } from '../physics/collision-layers.ts';
import {
  GRAB_DEFAULTS,
  GRAB_LIMITS,
  TELEKINESIS_DEFAULTS,
  type GrabLimits,
  type GrabSettings,
  type TelekinesisSettings,
} from '../physics/grab.ts';
import {
  DEBRIS_QUALITY,
  type DebrisQuality,
  type PhysicsOwner,
  type PhysicsWorld,
} from '../physics/physics-world.ts';
import type { Vfs } from '../vfs/vfs.ts';
import type { GameSettings } from '../world/game-settings.ts';
import { IniSettings, type IniOverrides } from '../world/ini-settings.ts';
import { MaterialFlag, parseMaterialType } from '../world/material-type.ts';
import { directionalSpeed, parseMovementType, type MovementType } from '../world/movement.ts';
import { readPlayerBody, type PlayerBody } from '../world/player-body.ts';
import type { RecordDatabase } from '../world/record-db.ts';

/** The movement types the player moves with (the behavior graph's states). */
export interface PlayerMovement {
  readonly normal: MovementType;
  readonly sprint: MovementType;
  readonly sneak: MovementType;
  readonly swim: MovementType;
}

/** What the player is made of, read once per session. */
export interface PlayerData {
  readonly body: PlayerBody;
  readonly ini: IniSettings;
  /** The installation's control map, and the bindings in use (the player's remaps on it). */
  readonly baseControls: ControlMap;
  controls: ControlMap;
  readonly movement: PlayerMovement;
  /** GMST fJumpHeightMin: how high a jump goes (game units). */
  readonly jumpHeight: number;
  /**
   * GMST fJumpFallVelocityMin: falling faster than this (game units a second) the player
   * neither sprints nor starts to (the engine's sprint, observed in the original).
   */
  readonly fallVelocityMin: number;
  /** GMST fZKey*: the spring that holds grabbed objects. */
  readonly grab: GrabSettings;
  /** GMST fGrabMaxWeightWalking, fZKeyHeavyWeight: what may be grabbed, what hinders. */
  readonly grabLimits: GrabLimits;
  /** GMST fMagicTelekinesis*: Telekinesis's spring, pull and throw. */
  readonly telekinesis: TelekinesisSettings;
  /** GMST fDebrisMinExtent, fDebrisMaxVelocity: which simulated bodies are swept. */
  readonly debris: DebrisQuality;
  /** Material ids of stairs (MATT with the stairs flag). */
  readonly stairMaterials: ReadonlySet<number>;
  /** The flags of every material type (MATT FNAM) by material id. */
  readonly materialFlags: ReadonlyMap<number, number>;
}

/** The keyboard, mouse and gamepad bindings. */
const CONTROL_MAP = 'interface\\controls\\pc\\controlmap.txt';

/**
 * Reads what the player is made of: the race's body, the INI settings, the control map, the
 * movement types and the stair materials (in the browser's session and in the Node tools).
 */
export async function readPlayerData(
  db: RecordDatabase,
  vfs: Vfs,
  settings: GameSettings,
  nif: (path: string) => Promise<NifFile>,
  /** The player's own settings over the INI files (the journal's settings pages). */
  preferences?: IniOverrides,
): Promise<PlayerData> {
  const [body, controlText] = await Promise.all([readPlayerBody(db, nif), vfs.read(CONTROL_MAP)]);
  const types = new Map<string, MovementType>();
  for (const formId of db.formIdsOfType('MOVT')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const type = parseMovementType(record);
    types.set(type.name, type);
  }
  const type = (name: string): MovementType => {
    const found = types.get(name);
    if (!found) throw new Error(`movement type ${name} is missing`);
    return found;
  };
  // Stair materials: what the character controller climbs as stairs.
  const stairMaterials = new Set<number>();
  const materialFlags = new Map<number, number>();
  for (const formId of db.formIdsOfType('MATT')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const material = parseMaterialType(record);
    materialFlags.set(material.id, material.flags);
    if ((material.flags & MaterialFlag.stairs) !== 0) stairMaterials.add(material.id);
  }
  const controls = parseControlMap(decodeWindows1252(controlText));
  return {
    body,
    stairMaterials,
    materialFlags,
    ini: new IniSettings(vfs.defaultIni, preferences),
    baseControls: controls,
    controls,
    // The behavior graph's movement states (MOVT MNAM).
    movement: {
      normal: type('NPCDefault'),
      sprint: type('NPCSprinting'),
      sneak: type('NPCSneaking'),
      swim: type('NPCSwimming'),
    },
    jumpHeight: settings.number('fJumpHeightMin') ?? JUMP_HEIGHT_MIN,
    fallVelocityMin: settings.number('fJumpFallVelocityMin') ?? FALL_VELOCITY_MIN,
    grab: grabSettings(settings),
    grabLimits: {
      maxWeight: settings.number('fGrabMaxWeightWalking') ?? GRAB_LIMITS.maxWeight,
      heavyWeight: settings.number('fZKeyHeavyWeight') ?? GRAB_LIMITS.heavyWeight,
    },
    telekinesis: telekinesisSettings(settings),
    debris: {
      minExtent: settings.number('fDebrisMinExtent') ?? DEBRIS_QUALITY.minExtent,
      maxVelocity: settings.number('fDebrisMaxVelocity') ?? DEBRIS_QUALITY.maxVelocity,
    },
  };
}

/**
 * A play's physics world as the engine's settings make it: its step and the steps a frame takes
 * at most ([HAVOK] fMaxTime, uMaxNumPhysicsStepsPerUpdate), the warm start, the quietest contact
 * heard, which bodies are swept. Before objects are placed.
 */
export function configurePhysics(
  physics: PhysicsWorld,
  data: Pick<PlayerData, 'ini' | 'debris'>,
): void {
  physics.stepSeconds = data.ini.number('HAVOK', 'fMaxTime');
  physics.maxSteps = Math.max(
    1,
    Math.round(data.ini.number('HAVOK', 'uMaxNumPhysicsStepsPerUpdate')),
  );
  physics.impactSpeed = data.ini.number('Audio', 'fMinSoundVel');
  physics.settleSeconds = data.ini.number('HAVOK', 'fWarmStartMaxTime');
  physics.debris = data.debris;
}

/** fJumpHeightMin's and fJumpFallVelocityMin's built-in values (Skyrim.esm: 76 and 700). */
const JUMP_HEIGHT_MIN = 64;
const FALL_VELOCITY_MIN = 600;

/** Telekinesis's settings: GMSTs where the plugins set them, else the engine's values. */
function telekinesisSettings(settings: GameSettings): TelekinesisSettings {
  const d = TELEKINESIS_DEFAULTS;
  const n = (name: string, fallback: number): number => settings.number(name) ?? fallback;
  return {
    spring: {
      ...d.spring,
      springDamping: n('fMagicTelekinesisSpringDamping', d.spring.springDamping),
      springElasticity: n('fMagicTelekinesisSpringElasticity', d.spring.springElasticity),
      objectDamping: n('fMagicTelekinesisObjectDamping', d.spring.objectDamping),
      maxForce: n('fMagicTelekinesisMaxForce', d.spring.maxForce),
    },
    moveBase: n('fMagicTelekinesisMoveBase', d.moveBase),
    moveAccelerate: n('fMagicTelekinesisMoveAccelerate', d.moveAccelerate),
    moveMax: n('fMagicTelekinesisMoveMax', d.moveMax),
    distanceMin: n('fMagicTelekinesisDistanceMin', d.distanceMin),
    throwSpeed: n('fMagicTelekinesisThrow', d.throwSpeed),
    throwAccelerate: n('fMagicTelekinesisThrowAccelerate', d.throwAccelerate),
    throwMax: n('fMagicTelekinesisThrowMax', d.throwMax),
    dualCastThrowMult: n('fMagicTelekinesisDualCastThrowMult', d.dualCastThrowMult),
  };
}

/** The grab spring's settings: GMSTs where the plugins set them, else the defaults. */
function grabSettings(settings: GameSettings): GrabSettings {
  return {
    springDamping: settings.number('fZKeySpringDamping') ?? GRAB_DEFAULTS.springDamping,
    springElasticity: settings.number('fZKeySpringElasticity') ?? GRAB_DEFAULTS.springElasticity,
    objectDamping: settings.number('fZKeyObjectDamping') ?? GRAB_DEFAULTS.objectDamping,
    maxForce: settings.number('fZKeyMaxForce') ?? GRAB_DEFAULTS.maxForce,
    maxForceScaleLow: settings.number('fZKeyMaxForceScaleLow') ?? GRAB_DEFAULTS.maxForceScaleLow,
    maxForceScaleHigh: settings.number('fZKeyMaxForceScaleHigh') ?? GRAB_DEFAULTS.maxForceScaleHigh,
    maxForceWeightLow: settings.number('fZKeyMaxForceWeightLow') ?? GRAB_DEFAULTS.maxForceWeightLow,
    maxForceWeightHigh:
      settings.number('fZKeyMaxForceWeightHigh') ?? GRAB_DEFAULTS.maxForceWeightHigh,
  };
}

/**
 * Steepest walkable slope (degrees). The engine keeps it in hkpCharacterProxy::maxSlopeCosine;
 * its value is not documented (no INI setting or GMST sets it). TODO(M13): calibrate.
 */
export const MAX_SLOPE = 60;

export interface PlayerSetup extends PlayerData {
  readonly physics: PhysicsWorld;
  /** The bindings in use now (they change as the player remaps keys). */
  readonly controlsNow?: () => ControlMap;
  /** The surface of the water a point (the feet) is in or over, if any. */
  readonly waterHeight: (x: number, y: number, z: number) => number | undefined;
}

/**
 * Submersion (water depth over the body's height) at which an actor swims, and the depth it
 * floats at: the shoulders. Not documented; measured in game by the author of "Wade In Water".
 */
/** How fast the bow's zoom eases in and out (per second). */
const BOW_ZOOM_RATE = 8;
const SWIM_SUBMERSION = 0.69;
/**
 * The highest stair stepped up on stair materials. How the engine climbs them is not
 * documented. The treads of the 330 vanilla stair collision meshes rise mostly 24 or 16 units,
 * but also 25–28 (about a hundred, e.g. Castle Volkihar's courtyard stairs at 24.4) and up to
 * 32 (about forty): stairs the game lets one climb.
 */
const STAIR_HEIGHT = 32;
/**
 * An actor's character controller shape, as the engine makes it from its skeleton's collision
 * bound "BBX" (scaled): rings of the bound's narrow half extent, its full height.
 */
export function controllerShape(bound: {
  readonly center: Vec3;
  readonly halfExtents: Vec3;
}): CharacterShape {
  return {
    radius: Math.min(bound.halfExtents[0], bound.halfExtents[1]),
    height: bound.center[2] + bound.halfExtents[2],
  };
}

/**
 * How actors' character controllers move: the INI's gravity and push limit, the stair
 * materials.
 */
export function controllerSettings(
  data: Pick<PlayerData, 'ini' | 'stairMaterials'>,
): CharacterSettings {
  return {
    maxSlope: MAX_SLOPE,
    fallingGravity: data.ini.number('HAVOK', 'fInAirFallingCharGravityMult'),
    unsupportedGravity: data.ini.number('HAVOK', 'fUnsupportedGravMult'),
    stairMaterials: data.stairMaterials,
    stairHeight: STAIR_HEIGHT,
    moveLimitMass: data.ini.number('HAVOK', 'fMoveLimitMass'),
  };
}

/** A door's arrival point may lie this far above its floor (game units). */
const ARRIVAL_FLOOR_BELOW = 96;
/** Rays around the edge of the controller's footprint, for a floor below it. */
const FOOTPRINT_RAYS = 8;
/** Pitch limit of the cameras (radians). */
const MAX_PITCH = (85 * Math.PI) / 180;
/** Looking further down than this while swimming forward dives. */
const DIVE_PITCH = (-30 * Math.PI) / 180;

type Pov = 'first' | 'third';

/** How the player moves this step (for its behavior graphs). */
export interface PlayerMotion {
  /** The input direction in the player's frame: x right, y forward (0, 0: standing). */
  readonly inputX: number;
  readonly inputY: number;
  readonly moving: boolean;
  readonly running: boolean;
  readonly sprinting: boolean;
}

/**
 * The vertical field of view (radians) of a horizontal one across a 4:3 frame (degrees), as
 * fDefaultWorldFOV is (wider screens see more at the sides).
 */
function verticalFov(degrees: number): number {
  return 2 * Math.atan(Math.tan((degrees * Math.PI) / 360) * 0.75);
}

/** An animated camera the player's graph starts (src/shell/actor-graph-events.ts). */
export interface AnimatedCameraRequest {
  /** The node's world matrix now (undefined: it is gone). */
  readonly node: () => Mat4 | undefined;
  /** StartAnimatedCameraDelta: the third-person camera adds the node's motion. */
  readonly delta: boolean;
  /** Seconds the camera takes over to the node (iAnimatedTransitionMillis). */
  readonly transition: number;
}

export class Player implements Camera {
  readonly character: CharacterBody;
  readonly #setup: PlayerSetup;
  /** User events held down (by name) and those pressed since the last update. */
  readonly #held = new Set<string>();
  readonly #pressed = new Set<string>();
  readonly #keyEvents = new Map<string, string[]>();
  readonly #mouseEvents = new Map<number, string[]>();
  /** Compass heading in radians: 0 looks along +Y (north), π/2 along +X (east). */
  yaw = 0;
  pitch = 0;
  pov: Pov = 'first';
  /** The camera stays as it is (furniture that forces one: src/shell/player-furniture.ts). */
  povLocked = false;
  /**
   * Whether the player may switch the camera (Game.DisablePlayerControls' abCamSwitch: MQ101's
   * cart ride keeps it in first person); undefined: always.
   */
  povSwitchAllowed: (() => boolean) | undefined;
  /** Furniture or the scripts keep the camera as it is. */
  get #povFixed(): boolean {
    return this.povLocked || this.povSwitchAllowed?.() === false;
  }
  /** Third-person zoom (0 = fVanityModeMinDist, 1 = fVanityModeMaxDist). */
  #zoom = 0;
  #zoomTarget = 0;
  #alwaysRun: boolean;
  /** Whether the player runs now without the Run key (bAlwaysRunByDefault, toggled): riding. */
  get alwaysRun(): boolean {
    return this.#alwaysRun;
  }
  #autoMove = false;
  /**
   * The scripts drive the player (SetPlayerAIDriven: src/shell/player-pilot.ts): their packages
   * move them as this asks, not the movement keys. Undefined: the player moves themselves.
   */
  pilot: MoveRequest | undefined;
  sneaking = false;
  #jumpRequested = false;
  /** The camera this frame (game units). */
  position: [number, number, number] = [0, 0, 0];
  readonly near: number;
  lensShift = 0;
  /** Called on every physics step after the player moved (a held object's spring). */
  onStep: ((step: number) => void) | undefined;
  /** How the player moved in the last step. */
  motion: PlayerMotion = { inputX: 0, inputY: 0, moving: false, running: false, sprinting: false };
  /** Whether the player may sprint now (stamina left: the progression engine); none: always. */
  canSprint: (() => boolean) | undefined;
  /** The player tried to sprint without stamina (the HUD's stamina meter blinks). */
  onSprintRefused: (() => void) | undefined;
  #sprintRefused = false;
  /**
   * Starts a jump's animation instead of jumping at once (the avatar: the graph's JumpUp
   * then calls launchJump); `moving`: a directional jump.
   */
  jumpTrigger: ((moving: boolean) => void) | undefined;
  /**
   * The first-person camera above the feet in the player's frame (x right, y forward, z
   * up), as the animated Camera1st node has it; undefined: the skeleton's rest height.
   */
  cameraOffset: (() => Vec3 | undefined) | undefined;
  /**
   * How far the body is from where it stands on its feet (game units, the world's axes): a
   * seated body's (a cart's rider sits 200 units behind and 139 above its root). The
   * third-person camera looks at the body where it is. Undefined: on its feet.
   */
  bodyShift: (() => Vec3 | undefined) | undefined;
  /** What the third-person camera passes through (the cart the player rides). */
  cameraIgnores: ((owner: PhysicsOwner | undefined) => boolean) | undefined;
  /**
   * Whether the player's weapons or magic are drawn: the third-person camera then moves to its
   * combat offsets (behind the back instead of over the shoulder).
   */
  weaponDrawn: (() => boolean) | undefined;
  /** The third-person camera's offset now (x right, y back, z up), easing to its target. */
  #shoulder: [number, number, number] | undefined;
  /**
   * Where the player may stand (the worldspace's border regions); undefined: anywhere.
   * Movement across the border stops at it and calls onBorder.
   */
  border: ((x: number, y: number) => boolean) | undefined;
  /** The player tried to leave the border regions ("You cannot go that way."). */
  onBorder: (() => void) | undefined;
  /** The last place inside the border. */
  #inside: Vec3 | undefined;
  /** The player's own pace against the world's clock (Slow Time); 1 without. */
  pace: (() => number) | undefined;
  /** The player landed after falling this far (units): falling damage. */
  onLanded: ((height: number) => void) | undefined;
  /** The bow's zoom asked for (the field of view's factor: Mod Bow Zoom), and as eased now. */
  bowZoom = 1;
  #bowZoom = 1;
  readonly #fovY: number;
  /** fDefaultWorldFOV: degrees across a 4:3 frame. */
  readonly #fovDegrees: number;
  /**
   * Whether the player holds an object heavier than fZKeyHeavyWeight (the play's grab): they
   * walk, as over-encumbered.
   */
  holdingHeavy: (() => boolean) | undefined;
  /**
   * Whether the player carries more than they can (the equip system: GameSession's
   * overEncumbered): they walk, and neither run nor sprint (UESP "Skyrim:Carry Weight").
   */
  overEncumbered: (() => boolean) | undefined;
  /** The tween menu's camera while it is open (it leans and zooms the view). */
  readonly tween: TweenCamera;
  /**
   * The player did something the actors near comment on (a topic subtype: "JUMP", "ZKEY",
   * "LOOB", ...; the stage's talk answers: src/shell/actor-talk.ts, playerAction).
   */
  onAction: ((subtype: string) => void) | undefined;
  /** The dialogue camera while the player talks with an actor (it turns to it and zooms). */
  readonly dialogue = new DialogueCamera();
  /** The camera's shake (a giant's stomp, Game.ShakeCamera): stepped with the game's time. */
  readonly shake = new CameraShake();
  /** The race's body (the cameras' heights). */
  #body: PlayerBody;

  constructor(setup: PlayerSetup, feet: Vec3, yaw: number) {
    this.#setup = setup;
    const { body, ini } = setup;
    this.#body = body;
    this.character = new CharacterBody(
      setup.physics,
      controllerShape(body.bound),
      controllerSettings(setup),
      feet,
      { reference: 0x14, kind: 'actor' },
    );
    this.yaw = yaw;
    this.#alwaysRun = ini.bool('Controls', 'bAlwaysRunByDefault');
    this.near = ini.number('Display', 'fNearDistance');
    // fDefaultWorldFOV is the horizontal field of view of a 4:3 frame (wider screens see
    // more at the sides).
    this.#fovDegrees = ini.number('Display', 'fDefaultWorldFOV');
    this.#fovY = verticalFov(this.#fovDegrees);
    this.tween = new TweenCamera({
      rotAngle: ini.number('Camera', 'fTweenCamRotAngle'),
      rotSpeed: ini.number('Camera', 'fTweenCamRotSpeed'),
      closingSpeed: ini.number('Camera', 'fTweenCamRotClosingSpeed'),
      fovMod: ini.number('Camera', 'fTweenCamZoomFOVMod'),
      zoomSpeed: ini.number('Camera', 'fTweenCamZoomSpeed'),
    });
    this.rebind(setup.controls);
  }

  /** The bindings the maps were made from. */
  #bound: ControlMap | undefined;

  /** Makes the maps again if the player's bindings changed. */
  #current(): void {
    const now = this.#setup.controlsNow?.() ?? this.#setup.controls;
    if (now !== this.#bound) this.rebind(now);
  }

  /** Takes the main gameplay bindings by browser key code and mouse button (anew: remaps). */
  rebind(controls: ControlMap): void {
    this.#bound = controls;
    this.#keyEvents.clear();
    this.#mouseEvents.clear();
    for (const event of controls.contexts[0] ?? []) {
      for (const binding of event.keys) {
        if (binding.length !== 1) continue; // combinations: screenshots
        const code = SCAN_CODES.get(binding[0] ?? 0);
        if (!code) continue;
        const list = this.#keyEvents.get(code) ?? [];
        list.push(event.name);
        this.#keyEvents.set(code, list);
      }
      for (const button of event.mouse) {
        const list = this.#mouseEvents.get(button) ?? [];
        list.push(event.name);
        this.#mouseEvents.set(button, list);
      }
    }
  }

  /** The vertical field of view (radians) of fDefaultWorldFOV (the death camera's too). */
  get fovY(): number {
    return this.#fovY;
  }

  /** The INI settings the player works with. */
  get ini(): IniSettings {
    return this.#setup.ini;
  }

  /** The spring that holds grabbed objects (GMST fZKey*). */
  /** What may be grabbed, what a held object hinders (GMST). */
  get grabLimits(): GrabLimits {
    return this.#setup.grabLimits;
  }

  /** Telekinesis's spring, pull and throw (GMST). */
  get telekinesis(): TelekinesisSettings {
    return this.#setup.telekinesis;
  }

  get grab(): GrabSettings {
    return this.#setup.grab;
  }

  /** Where the eyes are (the first-person camera), interpolated like the camera. */
  get eye(): Vec3 {
    const feet = this.character.feetAt(this.#setup.physics.alpha);
    const [x, y, z] = this.#eyeOffset();
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    return [feet[0] + x * cos + y * sin, feet[1] - x * sin + y * cos, feet[2] + z];
  }

  /** The first-person camera in the player's frame (the animated node, else the rest one). */
  #eyeOffset(): Vec3 {
    return this.cameraOffset?.() ?? [0, 0, this.#body.eyeHeight];
  }

  /** The race's height (the body and its camera nodes are scaled by it). */
  get height(): number {
    return this.#body.height;
  }

  /** The body's height: the top of its skeleton's bound (game units, scaled). */
  get bodyHeight(): number {
    const { bound } = this.#body;
    return bound.center[2] + bound.halfExtents[2];
  }

  /**
   * The player's race or sex changed (the race menu, Actor.SetRace): the cameras follow the new
   * body's height. TODO(M13): the character controller keeps the size it was made with (the
   * playable races' bounds differ by their height, 0.9 to 1.1 times).
   */
  setBody(body: PlayerBody): void {
    this.#body = body;
  }

  /**
   * The movement type the player's graph has them in, where it decides (a beast form's iState:
   * src/shell/player-avatar.ts); undefined: the player's own types by what they do.
   */
  taggedMovement: (() => MovementType | undefined) | undefined;

  /** The movement types the player moves with. */
  get movement(): PlayerMovement {
    return this.#setup.movement;
  }

  /** Jumps now, if on the ground (the avatar's jump animation pushes off). */
  launchJump(): void {
    if (!this.character.grounded || this.character.swimming) return;
    this.onAction?.('JUMP');
    // fJumpHeightMin: the height of the jump; with constant gravity v = √(2 g h).
    const g = -this.#setup.physics.world.gravity.z * HAVOK_SCALE;
    this.character.jump(Math.sqrt(2 * g * this.#setup.jumpHeight));
  }

  get forward(): Vec3 {
    const c = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * c, Math.cos(this.yaw) * c, Math.sin(this.pitch)];
  }

  /** Where the player stands (game units). */
  get feet(): Vec3 {
    return this.character.feet;
  }

  /** Where the player is drawn: the feet between the last two steps, as the camera has them. */
  get drawnFeet(): Vec3 {
    return this.character.feetAt(this.#setup.physics.alpha);
  }

  get swimming(): boolean {
    return this.character.swimming;
  }

  /**
   * The floor a player arriving through a door at `feet` stands on: the first surface below
   * half the body's height above the arrival point, down to ARRIVAL_FLOOR_BELOW below it. Above
   * stay porch roofs and door frames; below the middle of the body, the character controller
   * is pushed up out of what it stands in (Havok's character proxy recovers from penetration
   * along the contact normal: up, below its middle). Arrival points lie up to 37 units under
   * their floor (the doors of Halted Stream Camp, Chillfurrow Farm and Fenn's Gulch Mine).
   * Where the ray down the middle finds nothing (a seam between floor pieces: Bryling's House,
   * where the entrance's alcove has no floor of its own), the shape rests on the highest floor
   * under the edge of its footprint. The rays leave out the player's own shape (standing there
   * already) and phantoms.
   */
  arrivalFloor(feet: Vec3): { readonly height: number; readonly owner: number } | undefined {
    const above = this.character.shape.height / 2;
    const floorAt = (x: number, y: number) =>
      this.#setup.physics.raycast(
        [x, y, feet[2] + above],
        [0, 0, -1],
        above + ARRIVAL_FLOOR_BELOW,
        Layer.charController,
        this.character.collider,
      );
    let hit = floorAt(feet[0], feet[1]);
    if (!hit) {
      // The middle misses: the highest floor under the footprint's edge.
      const radius = this.character.shape.radius;
      for (let i = 0; i < FOOTPRINT_RAYS; i++) {
        const angle = (i * 2 * Math.PI) / FOOTPRINT_RAYS;
        const edge = floorAt(
          feet[0] + Math.cos(angle) * radius,
          feet[1] + Math.sin(angle) * radius,
        );
        if (edge && (!hit || edge.point[2] > hit.point[2])) hit = edge;
      }
    }
    return hit && { height: hit.point[2], owner: hit.owner?.reference ?? 0 };
  }

  teleport(feet: Vec3, yaw?: number): void {
    this.character.teleport(feet);
    if (yaw !== undefined) this.yaw = yaw;
  }

  #event(name: string): boolean {
    return this.#held.has(name);
  }

  /** The key a user event is bound to, as printed on the keyboard ("E", "Space"). */
  keyOf(name: string): string | undefined {
    this.#current();
    for (const [code, events] of this.#keyEvents) {
      if (events.includes(name)) return code.replace(/^(Key|Digit)/, '');
    }
    return undefined;
  }

  /** Whether a user event is held down. */
  isHeld(name: string): boolean {
    return this.#held.has(name);
  }

  /** Whether a user event was pressed since it was last taken (then forgets the press). */
  takePressed(name: string): boolean {
    return this.#take(name);
  }

  #take(name: string): boolean {
    const pressed = this.#pressed.has(name);
    this.#pressed.delete(name);
    return pressed;
  }

  /** Every frame; `held`: the ground is not there yet, the player stays where they are. */
  update(deltaSeconds: number, held = false): void {
    const { physics, ini } = this.#setup;
    if (this.#take('Toggle POV') && !this.#povFixed) {
      this.setPov(this.pov === 'first' ? 'third' : 'first');
    }
    if (this.#take('Toggle Always Run')) this.#alwaysRun = !this.#alwaysRun;
    if (this.#take('Auto-Move')) this.#autoMove = !this.#autoMove;
    if (this.#take('Sneak') && !this.character.swimming) this.sneaking = !this.sneaking;
    // A press waits for the next physics step (a frame may have none).
    if (this.#take('Jump')) this.#jumpRequested = true;
    physics.step(deltaSeconds, (step) => {
      if (!held) this.#move(step);
      this.onStep?.(step);
    });
    // Third-person zoom eases towards its target (fMouseWheelZoomSpeed).
    const speed = ini.number('Camera', 'fMouseWheelZoomSpeed');
    this.#zoom += (this.#zoomTarget - this.#zoom) * Math.min(1, deltaSeconds * speed * 10);
    // The bow's zoom eases in and out (TODO(M13): the engine's rate).
    const zoom = this.bowZoom;
    this.#bowZoom += (zoom - this.#bowZoom) * Math.min(1, deltaSeconds * BOW_ZOOM_RATE);
    if (Math.abs(this.#bowZoom - zoom) < 1e-3) this.#bowZoom = zoom;
    this.#moveShoulder(deltaSeconds);
    this.#placeCamera(physics.alpha);
    this.shake.step(deltaSeconds);
    if (this.#animated) this.#animated.since += deltaSeconds;
  }

  /**
   * The third-person camera's offset eases toward its target (fShoulderDollySpeed of the way a
   * second): over the shoulder (fOverShoulderPosX, fOverShoulderPosZ), or with the weapon drawn
   * behind the back (fOverShoulderCombatPosX, fOverShoulderCombatPosZ) and
   * fOverShoulderCombatAddY farther.
   */
  #moveShoulder(deltaSeconds: number): void {
    const ini = this.#setup.ini;
    const drawn = this.weaponDrawn?.() === true;
    const target: [number, number, number] = drawn
      ? [
          ini.number('Camera', 'fOverShoulderCombatPosX'),
          -ini.number('Camera', 'fOverShoulderCombatAddY'),
          ini.number('Camera', 'fOverShoulderCombatPosZ'),
        ]
      : [ini.number('Camera', 'fOverShoulderPosX'), 0, ini.number('Camera', 'fOverShoulderPosZ')];
    const now = this.#shoulder;
    if (!now || this.pov === 'first') {
      this.#shoulder = target;
      return;
    }
    const share = Math.min(1, ini.number('Camera', 'fShoulderDollySpeed') * deltaSeconds);
    this.#shoulder = [
      now[0] + (target[0] - now[0]) * share,
      now[1] + (target[1] - now[1]) * share,
      now[2] + (target[2] - now[2]) * share,
    ];
  }

  /** One physics step of movement. */
  #move(seconds: number): void {
    const jump = this.#jumpRequested;
    this.#jumpRequested = false;
    const { movement } = this.#setup;
    const character = this.character;
    // Input direction in the player's frame: x right, y forward.
    let x = 0;
    let y = this.#autoMove ? 1 : 0;
    if (this.#event('Forward')) y += 1;
    if (this.#event('Back')) y -= 1;
    if (this.#event('Strafe Right')) x += 1;
    if (this.#event('Strafe Left')) x -= 1;
    if (this.#event('Back') || this.#event('Forward')) this.#autoMove = false;
    const pilot = this.pilot;
    if (pilot) [x, y] = this.#piloted(pilot, seconds);
    const moving = x !== 0 || y !== 0;
    // Swimming: deep enough water lifts the body.
    const [fx, fy, fz] = character.feet;
    const water = this.#setup.waterHeight(fx, fy, fz);
    const depth = water === undefined ? 0 : (water - fz) / character.shape.height;
    const swimming =
      depth >= SWIM_SUBMERSION || (character.swimming && depth > SWIM_SUBMERSION - 0.05);
    character.swimming = swimming;
    if (swimming) this.sneaking = false;
    // "Run" walks while always-run is on, runs while it is off; over-encumbered, one walks.
    // Piloted, the package's gait.
    const burdened = (this.overEncumbered?.() ?? false) || (this.holdingHeavy?.() ?? false);
    const running =
      !burdened && (pilot ? pilot.gait !== 'walk' : this.#alwaysRun !== this.#event('Run'));
    const wantsSprint =
      !burdened &&
      (pilot ? pilot.gait === 'sprint' : this.#event('Sprint')) &&
      y > 0 &&
      !this.sneaking &&
      !swimming &&
      // Falling fast (fJumpFallVelocityMin) one does not sprint (a jump or a step down does not
      // end a sprint).
      !(character.verticalSpeed < -this.#setup.fallVelocityMin);
    // Without stamina there is no sprinting (the stamina meter blinks as it is tried).
    const allowed = !wantsSprint || (this.canSprint?.() ?? true);
    if (wantsSprint && !allowed && !this.#sprintRefused) this.onSprintRefused?.();
    this.#sprintRefused = wantsSprint && !allowed;
    const sprinting = wantsSprint && allowed;
    // A beast form moves at the movement type its graph is in (WerewolfBeastSprint, ...).
    const beast = swimming ? undefined : this.taggedMovement?.();
    const type =
      beast ??
      (swimming
        ? movement.swim
        : sprinting
          ? movement.sprint
          : this.sneaking
            ? movement.sneak
            : movement.normal);
    // In slowed time the player keeps their own pace against the world's clock (Slow Time:
    // GameSession.playerPace).
    const pace = this.pace?.() ?? 1;
    const speed = moving ? directionalSpeed(running ? type.run : type.walk, x, y) * pace : 0;
    this.motion = { inputX: x, inputY: y, moving, running, sprinting };
    const length = Math.hypot(x, y) || 1;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Right is (cos, -sin), forward (sin, cos).
    const vx = ((x * cos + y * sin) / length) * speed;
    const vy = ((-x * sin + y * cos) / length) * speed;
    if (character.grounded || swimming) character.velocity = [vx, vy];
    if (swimming && water !== undefined) {
      // Float with the shoulders at the surface; looking down while swimming forward dives,
      // looking up from below rises.
      const surface = water - SWIM_SUBMERSION * character.shape.height;
      const diving = moving && y > 0 && (this.pitch < DIVE_PITCH || fz < surface - 1);
      const vertical = diving ? Math.sin(this.pitch) * speed : 0;
      // Rising and sinking to the surface goes at most at swimming speed, also when idle.
      const rate = movement.swim.run.forward;
      const float = Math.max(-rate, Math.min(rate, (surface - fz) / Math.max(seconds, 1e-3)));
      // Wading out: the shore lifts the body above the swimming depth; the water does not
      // pull it back down.
      const floatSpeed = fz > surface && character.supported ? 0 : float;
      character.verticalSpeed = diving ? Math.min(vertical, floatSpeed) : floatSpeed;
    } else if (jump && !sprinting && character.grounded) {
      if (this.jumpTrigger) this.jumpTrigger(moving);
      else this.launchJump();
    }
    // The border regions: moving out stops at the edge.
    const border = this.border;
    if (border) {
      const [vx0, vy0] = character.velocity;
      if (!border(fx + vx0 * seconds, fy + vy0 * seconds)) {
        character.velocity = [0, 0];
        this.onBorder?.();
      }
    }
    character.step(seconds);
    // Landed from a fall (not in water): its height, for falling damage (GameSession).
    if (character.landedFrom !== undefined) this.onLanded?.(character.landedFrom);
    if (border) {
      const [nx, ny, nz] = character.feet;
      if (border(nx, ny)) this.#inside = [nx, ny, nz];
      else if (this.#inside) {
        // Pushed or fallen across: back to the last place inside.
        character.teleport([this.#inside[0], this.#inside[1], Math.max(nz, this.#inside[2])]);
        this.onBorder?.();
      }
    }
  }

  /**
   * A step as the pilot asks: the player turns to the way they go (or to the heading asked) at
   * their movement type's rotation speed and goes that way. Returns the input direction in
   * their frame (x right, y forward).
   */
  #piloted(pilot: MoveRequest, seconds: number): [number, number] {
    const direction = pilot.direction;
    const length = direction ? Math.hypot(direction[0], direction[1]) : 0;
    const face =
      pilot.face ??
      (direction && length > 1e-6 ? Math.atan2(direction[0], direction[1]) : undefined);
    if (face !== undefined) {
      const type = this.#setup.movement.normal;
      const rate =
        length > 1e-6
          ? type.rotateWhileMoving
          : pilot.gait === 'walk'
            ? type.rotateInPlace.walk
            : type.rotateInPlace.run;
      const turn = Math.atan2(Math.sin(face - this.yaw), Math.cos(face - this.yaw));
      const most = rate * seconds;
      this.yaw += Math.max(-most, Math.min(most, turn));
    }
    if (!direction || length <= 1e-6) return [0, 0];
    // The way to go in the player's frame: right is (cos, -sin), forward (sin, cos).
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wx = direction[0] / length;
    const wy = direction[1] / length;
    return [wx * cos - wy * sin, wx * sin + wy * cos];
  }

  /** First or third person (third: zoomed out at least to the shoulder). */
  setPov(pov: Pov): void {
    this.pov = pov;
    if (pov === 'third') this.#zoomTarget = Math.max(this.#zoomTarget, 0);
  }

  /** First person at the eye; third person behind the shoulder, kept out of walls. */
  #placeCamera(alpha: number): void {
    const { ini, physics } = this.#setup;
    const body = this.#body;
    const feet = this.character.feetAt(alpha);
    if (this.pov === 'first') {
      // The camera rides the first-person skeleton's Camera1st node (sneaking lowers it).
      const [x, y, z] = this.#eyeOffset();
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      this.position = [feet[0] + x * cos + y * sin, feet[1] - x * sin + y * cos, feet[2] + z];
      return;
    }
    // Camera3rd hangs on the skeleton's root, not on its animated bones: a seated body (a cart's
    // rider, its root at the cart's) takes it along where the body is.
    const [sx, sy, sz] = this.bodyShift?.() ?? [0, 0, 0];
    const target: Vec3 = [
      feet[0] + sx + body.thirdPersonTarget[0],
      feet[1] + sy + body.thirdPersonTarget[1],
      feet[2] + sz + body.thirdPersonTarget[2],
    ];
    const min = ini.number('Camera', 'fVanityModeMinDist');
    const max = ini.number('Camera', 'fVanityModeMaxDist');
    const [shoulderX, shoulderBack, shoulderZ] = this.#shoulder ?? [
      ini.number('Camera', 'fOverShoulderPosX'),
      0,
      ini.number('Camera', 'fOverShoulderPosZ'),
    ];
    const distance = Math.max(0, min + this.#zoom * (max - min) + shoulderBack);
    const right: Vec3 = [Math.cos(this.yaw), -Math.sin(this.yaw), 0];
    const pivot: Vec3 = [
      target[0] + right[0] * shoulderX,
      target[1] + right[1] * shoulderX,
      target[2] + shoulderZ,
    ];
    const forward = this.forward;
    const back: Vec3 = [-forward[0], -forward[1], -forward[2]];
    // The camera sphere (fCameraCasterSize) stops at walls between the player and the camera.
    const reach = physics.sphereCast(
      pivot,
      back,
      distance,
      ini.number('Camera', 'fCameraCasterSize'),
      Layer.camera,
      this.character.collider,
      this.cameraIgnores,
    );
    this.position = [
      pivot[0] + back[0] * reach,
      pivot[1] + back[1] * reach,
      pivot[2] + back[2] * reach,
    ];
    this.#animateCamera();
  }

  // --- Animated cameras (the player's graph: StartAnimatedCamera) -------------------------------

  /** The animated camera under way, if any. */
  #animated:
    | (AnimatedCameraRequest & {
        /** Seconds since it began. */
        since: number;
        /** The node's place as it began (the delta camera adds its motion since). */
        readonly start: Vec3 | undefined;
      })
    | undefined;
  /** Where the animated camera looks (the node's forward), blended in as it takes over. */
  #animatedForward: { readonly forward: Vec3; readonly share: number } | undefined;

  /**
   * StartAnimatedCamera / StartAnimatedCameraDelta (src/shell/actor-graph-events.ts): the
   * third-person camera goes over to the node (its transition's seconds), or adds its motion.
   */
  startAnimatedCamera(request: AnimatedCameraRequest): void {
    const at = request.node();
    this.#animated = {
      ...request,
      since: 0,
      start: at ? [at[12] ?? 0, at[13] ?? 0, at[14] ?? 0] : undefined,
    };
  }

  /** EndAnimatedCamera: the camera is the player's again. */
  endAnimatedCamera(): void {
    this.#animated = undefined;
    this.#animatedForward = undefined;
  }

  /**
   * PitchOverrideStart / PitchOverrideEnd: observed in the original, set on the
   * third-person camera while it is the camera's state. TODO(M13): what the third-person camera
   * does with it is not known; nothing reads it yet.
   */
  pitchOverride = false;

  setPitchOverride(on: boolean): void {
    if (this.pov === 'third') this.pitchOverride = on;
  }

  /**
   * ZeroOutCameraPitch: observed in the original, the camera's pitch goes to level (its
   * heading kept). TODO(M13): whether the engine eases it there.
   */
  zeroPitch(): void {
    this.pitch = 0;
  }

  /** The animated camera rides its node (third person; first person keeps the eye). */
  #animateCamera(): void {
    const animated = this.#animated;
    this.#animatedForward = undefined;
    if (!animated || this.pov !== 'third') return;
    const node = animated.node();
    if (!node) return;
    const at: Vec3 = [node[12] ?? 0, node[13] ?? 0, node[14] ?? 0];
    if (animated.delta) {
      const start = animated.start ?? at;
      this.position = [
        this.position[0] + at[0] - start[0],
        this.position[1] + at[1] - start[1],
        this.position[2] + at[2] - start[2],
      ];
      return;
    }
    const share = animated.transition > 0 ? Math.min(1, animated.since / animated.transition) : 1;
    this.position = [
      this.position[0] + (at[0] - this.position[0]) * share,
      this.position[1] + (at[1] - this.position[1]) * share,
      this.position[2] + (at[2] - this.position[2]) * share,
    ];
    // TODO(M13): the axis an animated camera node looks along is inferred (the node's +y, as
    // actors face).
    const length = Math.hypot(node[4] ?? 0, node[5] ?? 0, node[6] ?? 0) || 1;
    this.#animatedForward = {
      forward: [(node[4] ?? 0) / length, (node[5] ?? 0) / length, (node[6] ?? 0) / length],
      share,
    };
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    // A bow's zoom (Eagle Eye: Mod Bow Zoom) narrows the view.
    let fovY = this.#bowZoom === 1 ? this.#fovY : verticalFov(this.#fovDegrees * this.#bowZoom);
    // In a conversation the player's view turns to the speaker (they face it after) and zooms.
    if (this.dialogue.active) {
      const view = this.dialogue.sample(performance.now(), this.position, this.yaw, this.pitch);
      this.yaw = view.yaw;
      this.pitch = view.pitch;
      fovY = verticalFov(this.#fovDegrees + view.fov);
    }
    let forward = this.forward;
    let yaw = this.yaw;
    let pitch = this.pitch;
    if (this.tween.active) {
      const added = this.tween.sample(performance.now());
      yaw += added.yaw;
      pitch += added.pitch;
      fovY = verticalFov(this.#fovDegrees + added.fov);
    }
    // The camera's shake turns the view (src/shell/camera-shake.ts): about its right (pitch),
    // its forward (roll) and up (counter-clockwise lowers the compass heading).
    const shake = this.shake.angles;
    let up: Vec3 = [0, 0, 1];
    if (shake) {
      yaw -= shake[2];
      pitch += shake[0];
      const roll = shake[1];
      up = [Math.cos(yaw) * Math.sin(roll), -Math.sin(yaw) * Math.sin(roll), Math.cos(roll)];
    }
    if (this.tween.active || shake) {
      const c = Math.cos(pitch);
      forward = [Math.sin(yaw) * c, Math.cos(yaw) * c, Math.sin(pitch)];
    }
    // An animated camera looks where its node does, taking over through its transition.
    const animated = this.#animatedForward;
    if (animated) {
      const mixed: Vec3 = [
        forward[0] + (animated.forward[0] - forward[0]) * animated.share,
        forward[1] + (animated.forward[1] - forward[1]) * animated.share,
        forward[2] + (animated.forward[2] - forward[2]) * animated.share,
      ];
      const length = Math.hypot(...mixed) || 1;
      forward = [mixed[0] / length, mixed[1] / length, mixed[2] / length];
    }
    const target: Vec3 = [
      this.position[0] + forward[0],
      this.position[1] + forward[1],
      this.position[2] + forward[2],
    ];
    const view = lookAt(this.position, target, up);
    const projection = perspectiveReversedZ(fovY, aspect, this.near);
    projection[8] = -this.lensShift;
    return multiply(projection, view, out);
  }

  /** Told of each user event the player presses (help messages wait for one). */
  onPress: ((name: string) => void) | undefined;

  /** Presses or releases a user event by its control map name ("Forward", "Jump", ...). */
  press(name: string, down: boolean): void {
    if (down) {
      if (!this.#held.has(name)) {
        this.#pressed.add(name);
        this.onPress?.(name);
      }
      this.#held.add(name);
    } else {
      this.#held.delete(name);
    }
  }

  /** The user events bound to a key (by KeyboardEvent.code). */
  eventsOfKey(code: string): readonly string[] | undefined {
    this.#current();
    return this.#keyEvents.get(code);
  }

  /** The user events bound to a mouse button (control map ids). */
  eventsOfMouse(button: number): readonly string[] | undefined {
    this.#current();
    return this.#mouseEvents.get(button);
  }

  /** Forgets every held key (the window lost focus). */
  releaseAll(): void {
    this.#held.clear();
  }

  /**
   * Mouse look by mouse counts: fMouseHeadingSensitivity × fMouseHeadingXScale × π radians per
   * count; vertically also × fMouseHeadingYScale.
   */
  look(countsX: number, countsY: number): void {
    const { ini } = this.#setup;
    const perCount =
      Math.PI *
      ini.number('Controls', 'fMouseHeadingSensitivity') *
      ini.number('Controls', 'fMouseHeadingXScale');
    this.yaw += countsX * perCount;
    // The setting Invert Y (bInvertYValues) turns looking up and down around.
    const invert = ini.bool('Controls', 'bInvertYValues') ? -1 : 1;
    this.pitch = Math.max(
      -MAX_PITCH,
      Math.min(
        MAX_PITCH,
        this.pitch - invert * countsY * perCount * ini.number('Controls', 'fMouseHeadingYScale'),
      ),
    );
  }

  /**
   * The mouse wheel: in third person zooms by fMouseWheelZoomIncrement down to fMinCurrentZoom,
   * and further in to first person; out of first person to the closest third-person view.
   */
  zoom(zoomIn: boolean): void {
    const { ini } = this.#setup;
    const step = ini.number('Camera', 'fMouseWheelZoomIncrement');
    if (zoomIn) {
      if (this.pov === 'third') {
        const lowest = ini.number('Camera', 'fMinCurrentZoom');
        if (this.#zoomTarget <= lowest + 1e-6) {
          if (!this.#povFixed) this.setPov('first');
        } else this.#zoomTarget = Math.max(lowest, this.#zoomTarget - step);
      }
    } else if (this.pov === 'first') {
      if (this.#povFixed) return;
      this.#zoomTarget = ini.number('Camera', 'fMinCurrentZoom');
      this.#zoom = this.#zoomTarget;
      this.setPov('third');
    } else {
      this.#zoomTarget = Math.min(1, this.#zoomTarget + step);
    }
  }

  free(): void {
    this.character.free();
  }
}
