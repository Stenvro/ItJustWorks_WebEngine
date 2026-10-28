// The player: input through the game's control map, movement at the speeds of the movement
// types (MOVT) on the character controller, jumping, swimming, and the first- and
// third-person cameras with the engine's INI settings. Its body and its animations (the
// first-person camera rides the animated Camera1st node) are the player's avatar
// (player-avatar.ts), which hooks in here.

import { DialogueCamera } from './dialogue-camera.ts';
import { CameraShake } from './camera-shake.ts';
import {
  AutoVanity,
  cameraState,
  horseShoulder,
  zoomRange,
  type CameraConditions,
  type CameraState,
} from './camera-states.ts';
import { TweenCamera } from './tween-camera.ts';
import type { Camera } from '../render/view-camera.ts';
import type { MoveRequest } from '../ai/locomotion.ts';
import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from '../render/math.ts';
import { firstPersonViewProjection, verticalFov } from '../render/first-person-view.ts';
import {
  InputContext,
  parseControlMap,
  SCAN_CODES,
  type ControlMap,
} from '../formats/controlmap/controlmap.ts';
import { padEvents } from '../formats/controlmap/gamepad.ts';
import type { NifFile } from '../formats/nif/nif.ts';
import { decodeWindows1252 } from '../formats/text.ts';
import {
  CharacterBody,
  type CharacterSettings,
  type CharacterShape,
} from '../physics/character.ts';
import { HAVOK_SCALE } from '../physics/collision-data.ts';
import { solverSettings } from '../physics/constraint-solver.ts';
import { Layer } from '../physics/collision-layers.ts';
import {
  GRAB_DEFAULTS,
  GRAB_LIMITS,
  TELEKINESIS_SPRING,
  type GrabLimits,
  type GrabSettings,
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
import { MaterialFlag, materialId, parseMaterialType } from '../world/material-type.ts';
import {
  directionalSpeed,
  parseMovementType,
  stickPace,
  type MovementType,
} from '../world/movement.ts';
import { readPlayerBody, type PlayerBody } from '../world/player-body.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import { parseWaterBody } from '../world/water.ts';
import type { WaterHarm } from '../gameplay/water-hazard.ts';
import { floatSpeed, submersion, SWIM_SUBMERSION, swims } from '../gameplay/swimming.ts';
import {
  SPLASH_DEFAULTS,
  WATER_RULE_DEFAULTS,
  type SplashSettings,
  type WaterRules,
} from '../physics/water-physics.ts';

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
  /** GMST fMagicTelekinesisSpring*, ...ObjectDamping, ...MaxForce: Telekinesis's spring. */
  readonly telekinesisSpring: GrabSettings;
  /** GMST fHavokTauRatio: how the constraint solver's tau follows the step (solverSettings). */
  readonly havokTauRatio: number;
  /** GMST fDebrisMinExtent, fDebrisMaxVelocity: which simulated bodies are swept. */
  readonly debris: DebrisQuality;
  /** Material ids of stairs (MATT with the stairs flag). */
  readonly stairMaterials: ReadonlySet<number>;
  /** The flags of every material type (MATT FNAM) by material id. */
  readonly materialFlags: ReadonlyMap<number, number>;
  /** What water does to bodies (src/physics/water-physics.ts): currents, buoyancy, splashes. */
  readonly water: WaterRules;
}

/** The water physics' settings: GMSTs where the plugins set them, else the engine's values. */
function splashSettings(settings: GameSettings): SplashSettings {
  const d = SPLASH_DEFAULTS;
  const n = (name: string, fallback: number): number => settings.number(name) ?? fallback;
  return {
    light: n('fSplashSoundLight', d.light),
    medium: n('fSplashSoundMedium', d.medium),
    heavy: n('fSplashSoundHeavy', d.heavy),
    timer: n('fSplashSoundTimer', d.timer),
    velocityMult: n('fSplashSoundVelocityMult', d.velocityMult),
    outMult: n('fSplashSoundOutMult', d.outMult),
    model: settings.string('sSplashParticles') ?? d.model,
    scales: [
      n('fSplashScale1', d.scales[0]),
      n('fSplashScale2', d.scales[1]),
      n('fSplashScale3', d.scales[2]),
    ],
  };
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
  const buoyancy = new Map<number, number>();
  const materialOfForm = new Map<number, number>();
  for (const formId of db.formIdsOfType('MATT')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const material = parseMaterialType(record);
    materialFlags.set(material.id, material.flags);
    buoyancy.set(material.id, material.buoyancy);
    materialOfForm.set(material.formId, material.id);
    if ((material.flags & MaterialFlag.stairs) !== 0) stairMaterials.add(material.id);
  }
  // The water types' currents, damage and spells (water-physics.ts, water-hazard.ts).
  const currents = new Map<number, { linear: Vec3; angular: Vec3 }>();
  const harms = new Map<number, WaterHarm>();
  const waterMaterials = new Map<number, number>();
  const flowmapTypes = new Set<number>();
  for (const formId of db.formIdsOfType('WATR')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const water = parseWaterBody(record);
    if (water.spell !== undefined || (water.causesDamage && water.damagePerSecond > 0))
      harms.set(formId, water);
    if (water.flowmap) flowmapTypes.add(formId);
    const own = water.material === undefined ? undefined : materialOfForm.get(water.material);
    if (own !== undefined) waterMaterials.set(formId, own);
    if (water.linearVelocity.some((v) => v !== 0) || water.angularVelocity.some((v) => v !== 0))
      currents.set(formId, {
        linear: [...water.linearVelocity],
        angular: [...water.angularVelocity],
      });
  }
  const controls = parseControlMap(decodeWindows1252(controlText));
  return {
    body,
    stairMaterials,
    materialFlags,
    water: {
      currents,
      buoyancy,
      ragdollBody: settings.number('fBuoyancyMultBody') ?? WATER_RULE_DEFAULTS.ragdollBody,
      ragdollExtremity:
        settings.number('fBuoyancyMultExtremity') ?? WATER_RULE_DEFAULTS.ragdollExtremity,
      splash: splashSettings(settings),
      waterMaterials,
      waterMaterial: materialId('Water'),
      harms,
      flowmapTypes,
    },
    ini: new IniSettings(vfs.ini, preferences),
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
    telekinesisSpring: telekinesisSpring(settings),
    havokTauRatio: settings.number('fHavokTauRatio') ?? HAVOK_TAU_RATIO,
    debris: {
      minExtent: settings.number('fDebrisMinExtent') ?? DEBRIS_QUALITY.minExtent,
      maxVelocity: settings.number('fDebrisMaxVelocity') ?? DEBRIS_QUALITY.maxVelocity,
    },
  };
}

/**
 * A play's physics world as the engine's settings make it: its step and the steps a frame takes
 * at most ([HAVOK] fMaxTime, uMaxNumPhysicsStepsPerUpdate), the warm start, the quietest contact
 * heard, which bodies are swept, the constraint solver's tau and iterations (fHavokTauRatio).
 * Before objects are placed.
 */
export function configurePhysics(
  physics: PhysicsWorld,
  data: Pick<PlayerData, 'ini' | 'debris' | 'havokTauRatio'>,
): void {
  physics.stepSeconds = data.ini.number('HAVOK', 'fMaxTime');
  physics.maxSteps = Math.max(
    1,
    Math.round(data.ini.number('HAVOK', 'uMaxNumPhysicsStepsPerUpdate')),
  );
  physics.impactSpeed = data.ini.number('Audio', 'fMinSoundVel');
  physics.settleSeconds = data.ini.number('HAVOK', 'fWarmStartMaxTime');
  physics.debris = data.debris;
  physics.solver = solverSettings(
    physics.stepSeconds,
    data.ini.number('HAVOK', 'fMaxTime'),
    data.havokTauRatio,
  );
  physics.penetration = {
    seconds: data.ini.number('RagdollAnim', 'fDetectionUpdateTimeSec'),
    desiredSpeed: data.ini.number('RagdollAnim', 'fDesiredVel'),
    impulseLimit: data.ini.number('RagdollAnim', 'fImpulseLimit'),
  };
}

/** fJumpHeightMin's and fJumpFallVelocityMin's built-in values (Skyrim.esm: 76 and 700). */
const JUMP_HEIGHT_MIN = 64;
const FALL_VELOCITY_MIN = 600;
/** fHavokTauRatio's built-in value (observed in the original; Skyrim.esm does not set it). */
const HAVOK_TAU_RATIO = 0.5;

/** Telekinesis's spring: GMSTs where the plugins set them, else the engine's values. */
function telekinesisSpring(settings: GameSettings): GrabSettings {
  const d = TELEKINESIS_SPRING;
  return {
    ...d,
    springDamping: settings.number('fMagicTelekinesisSpringDamping') ?? d.springDamping,
    springElasticity: settings.number('fMagicTelekinesisSpringElasticity') ?? d.springElasticity,
    objectDamping: settings.number('fMagicTelekinesisObjectDamping') ?? d.objectDamping,
    maxForce: settings.number('fMagicTelekinesisMaxForce') ?? d.maxForce,
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

/** How fast the bow's zoom eases in and out (per second). */
const BOW_ZOOM_RATE = 8;
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
  /** Each step: how deep the player is in water (its share of their height, 0..1): breath. */
  onSubmersion:
    | ((
        submersion: number,
        seconds: number,
        water?: { readonly type: number; readonly harm: WaterHarm | undefined },
      ) => void)
    | undefined;
  /** The water type at a point and its harm (water-hazard.ts), if the play has water. */
  waterOf:
    | ((
        x: number,
        y: number,
        z: number,
      ) => { readonly type: number; readonly harm: WaterHarm | undefined } | undefined)
    | undefined;
  /** The bow's zoom asked for (the field of view's factor: Mod Bow Zoom), and as eased now. */
  bowZoom = 1;
  #bowZoom = 1;
  #fovY: number;
  /** fDefaultWorldFOV: degrees across a 4:3 frame (the console's fov changes it). */
  #fovDegrees: number;
  /** The console's tcl: no collision, no gravity; the player flies where they look. */
  noClip = false;

  /** fDefault1stPersonFOV: first person's own field of view (degrees across a 4:3 frame). */
  #firstPersonFov: number;
  /** The view of the last viewProjection (the first-person view looks along it). */
  readonly #view = new Float32Array(16);

  /** The world's and first person's fields of view (degrees across a 4:3 frame): fov. */
  setFov(degrees: number, firstPerson?: number): void {
    this.#fovDegrees = degrees;
    this.#fovY = verticalFov(degrees);
    if (firstPerson !== undefined) this.#firstPersonFov = firstPerson;
  }
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
  /** The auto vanity camera: it circles the player after a while without input. */
  readonly vanity = new AutoVanity();
  /** The point of view the vanity camera came from (it goes back to it). */
  #vanityPov: Pov | undefined;
  /** Input came this frame (a key, the mouse, the wheel): the vanity camera's idle clock. */
  #input = false;
  /** What the player rides (the mount's and the dragon's camera states); undefined: none. */
  mount: (() => 'horse' | 'dragon' | undefined) | undefined;
  /** Whether the vanity camera may start (no combat, no menu); undefined: always. */
  vanityAllowed: (() => boolean) | undefined;

  /**
   * The camera's state (src/shell/camera-states.ts), from what the player does; `others`: the
   * states the play session knows (the free camera, a kill camera, bleedout, furniture).
   */
  cameraState(others: Partial<CameraConditions> = {}): CameraState {
    return cameraState({
      pov: this.pov,
      animated: this.#animated !== undefined,
      tween: this.tween.active,
      vanity: this.vanity.active,
      mount: this.mount?.(),
      ...others,
    });
  }
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
    this.#firstPersonFov = ini.number('Display', 'fDefault1stPersonFOV');
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

  /** Telekinesis's spring (GMST). */
  get telekinesisSpring(): GrabSettings {
    return this.#setup.telekinesisSpring;
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

  /**
   * Jumps now, if on the ground: the avatar's graph's JumpBegin (the engine's
   * JumpAnimEventHandler, observed in the original: the character controller jumps fJumpHeightMin high).
   * TODO(M13): the actor's jump height mult and fJumpSwimmingMult in water (we do not jump
   * while swimming).
   */
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

  /** The camera's heading: the player's, or the vanity camera's about them. */
  #viewYaw(): number {
    return this.vanity.active ? this.vanity.yaw : this.yaw;
  }

  /** Where the camera looks (the vanity camera: at the player, from its heading). */
  #viewForward(): Vec3 {
    if (!this.vanity.active) return this.forward;
    const yaw = this.vanity.yaw;
    const c = Math.cos(this.pitch);
    return [Math.sin(yaw) * c, Math.cos(yaw) * c, Math.sin(this.pitch)];
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
    this.#togglePov(deltaSeconds);
    if (this.#take('Toggle Always Run')) this.#alwaysRun = !this.#alwaysRun;
    if (this.#take('Auto-Move')) this.#autoMove = !this.#autoMove;
    if (this.#take('Sneak') && !this.character.swimming) this.sneaking = !this.sneaking;
    // A press waits for the next physics step (a frame may have none).
    if (this.#take('Jump')) this.#jumpRequested = true;
    physics.step(deltaSeconds, (step) => {
      if (!held) this.#move(step);
      this.onStep?.(step);
    });
    // Third-person zoom moves to its target at fMouseWheelZoomSpeed (of the zoom's range) a
    // second (observed in the original).
    const speed = ini.number('Camera', 'fMouseWheelZoomSpeed') * deltaSeconds;
    const toZoom = this.#zoomTarget - this.#zoom;
    this.#zoom =
      Math.abs(toZoom) <= speed ? this.#zoomTarget : this.#zoom + Math.sign(toZoom) * speed;
    // The bow's zoom eases in and out (TODO(M13): the engine's rate).
    const zoom = this.bowZoom;
    this.#bowZoom += (zoom - this.#bowZoom) * Math.min(1, deltaSeconds * BOW_ZOOM_RATE);
    if (Math.abs(this.#bowZoom - zoom) < 1e-3) this.#bowZoom = zoom;
    this.#stepCameraState(deltaSeconds);
    this.#moveShoulder(deltaSeconds);
    this.#placeCamera(physics.alpha, deltaSeconds);
    this.shake.step(deltaSeconds);
    if (this.#animated) this.#animated.since += deltaSeconds;
  }

  /**
   * The camera states the player's own camera has (src/shell/camera-states.ts): a dragon's back
   * is seen in third person; the auto vanity camera starts after the idle delay (in third
   * person, from either) and any input ends it, back to the point of view it came from.
   */
  #stepCameraState(deltaSeconds: number): void {
    const { ini } = this.#setup;
    const mount = this.mount?.();
    if (mount === 'dragon' && this.pov === 'first') this.setPov('third');
    const input = this.#input;
    this.#input = false;
    const idle = !input && this.#held.size === 0 && !this.motion.moving && this.pilot === undefined;
    // TODO(M13): what else keeps it from starting in the engine (sneaking, a drawn weapon).
    const allowed =
      (this.vanityAllowed?.() ?? true) &&
      mount === undefined &&
      // A script that keeps the camera as it is (DisablePlayerControls' abCamSwitch, MQ101's cart
      // and walk to the block) keeps the vanity camera off too.
      !this.#povFixed &&
      !this.noClip &&
      this.#animated === undefined &&
      !this.dialogue.active &&
      !this.tween.active;
    const started = this.vanity.step(deltaSeconds, idle, allowed, this.yaw, {
      delay: ini.number('Camera', 'fAutoVanityModeDelay'),
      increment: ini.number('Camera', 'fAutoVanityIncrement'),
      zoom: ini.number('Camera', 'fDefaultAutoVanityZoom'),
      disabled: ini.bool('Camera', 'bDisableAutoVanityMode'),
      forced: ini.bool('Camera', 'bForceAutoVanityMode'),
    });
    if (started) {
      this.#vanityPov = this.pov;
      this.pov = 'third';
    } else if (!this.vanity.active && this.#vanityPov !== undefined) {
      this.pov = this.#vanityPov;
      this.#vanityPov = undefined;
    }
  }

  /** Seconds Toggle POV has been held (undefined: it is up), and whether the hold switched. */
  #povHeld: { seconds: number; switched: boolean } | undefined;

  /**
   * Toggle POV, as the engine's camera states take it (observed in the original): let go after at least
   * fTogglePOVDelay seconds it switches between first and third person; held in first person
   * for f1st3rdSwitchDelay seconds it goes to third person at once (and the letting go does no
   * more). TODO(phase 7): held in third person it turns the camera about the player (the vanity
   * hold), and then its letting go returns to first person only with
   * bReturnTo1stPersonFromVanity.
   */
  #togglePov(deltaSeconds: number): void {
    const { ini } = this.#setup;
    const pressed = this.#take('Toggle POV');
    const held = this.#held.has('Toggle POV');
    if (pressed || (held && !this.#povHeld)) this.#povHeld = { seconds: 0, switched: false };
    const hold = this.#povHeld;
    if (!hold) return;
    if (held) {
      hold.seconds += deltaSeconds;
      if (
        this.pov === 'first' &&
        !hold.switched &&
        !this.#povFixed &&
        hold.seconds >= ini.number('Camera', 'f1st3rdSwitchDelay')
      ) {
        hold.switched = true;
        this.setPov('third');
      }
      return;
    }
    // Let go (or a tap pressed and let go between two frames).
    this.#povHeld = undefined;
    if (hold.switched || this.#povFixed) return;
    if (hold.seconds < ini.number('Controls', 'fTogglePOVDelay')) return;
    this.setPov(this.pov === 'first' ? 'third' : 'first');
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
    // The mount's camera state: the horse's shoulder offsets, drawn or not.
    const target: [number, number, number] =
      this.mount?.() === 'horse'
        ? horseShoulder((key) => ini.number('Camera', key))
        : drawn
          ? [
              ini.number('Camera', 'fOverShoulderCombatPosX'),
              -ini.number('Camera', 'fOverShoulderCombatAddY'),
              ini.number('Camera', 'fOverShoulderCombatPosZ'),
            ]
          : [
              ini.number('Camera', 'fOverShoulderPosX'),
              0,
              ini.number('Camera', 'fOverShoulderPosZ'),
            ];
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
    // Moved by the stick alone, its deflection sets the pace (stickPace).
    const deflection = x === 0 && y === 0 ? Math.min(1, Math.hypot(...this.stick)) : 1;
    // The left stick adds to the keys (a gamepad's Move).
    x = Math.max(-1, Math.min(1, x + this.stick[0]));
    y = Math.max(-1, Math.min(1, y + this.stick[1]));
    if (this.#event('Back') || this.#event('Forward')) this.#autoMove = false;
    const pilot = this.pilot;
    if (pilot) [x, y] = this.#piloted(pilot, seconds);
    const moving = x !== 0 || y !== 0;
    if (this.noClip) {
      this.#fly(x, y, seconds);
      return;
    }
    // Swimming: deep enough water lifts the body.
    const [fx, fy, fz] = character.feet;
    const water = this.#setup.waterHeight(fx, fy, fz);
    const depth = submersion(fz, character.shape.height, water);
    const swimming = swims(depth, character.swimming);
    character.swimming = swimming;
    if (swimming) this.sneaking = false;
    this.onSubmersion?.(depth, seconds, depth > 0 ? this.waterOf?.(fx, fy, fz) : undefined);
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
    const speed = moving
      ? stickPace(
          directionalSpeed(type.walk, x, y),
          directionalSpeed(type.run, x, y),
          running,
          deflection,
        ) * pace
      : 0;
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
      // Wading out: the shore lifts the body above the swimming depth; the water does not
      // pull it back down.
      const rising = floatSpeed(
        fz,
        character.shape.height,
        water,
        movement.swim.run.forward,
        seconds,
        character.supported,
      );
      character.verticalSpeed = diving ? Math.min(vertical, rising) : rising;
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
    // Standing on a turning body (a platform, a lift), it turns with it.
    this.yaw += character.carriedTurn;
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
   * The console's tcl: the player passes through everything and goes where they look (the
   * view's pitch too), without gravity. TODO(M13): the engine's speed for it (here the run
   * speed).
   */
  #fly(x: number, y: number, seconds: number): void {
    const moving = x !== 0 || y !== 0;
    this.motion = { inputX: x, inputY: y, moving, running: true, sprinting: false };
    const feet = this.character.feet;
    if (!moving) {
      this.character.carry(feet, feet);
      return;
    }
    const speed = this.#setup.movement.normal.run.forward / Math.hypot(x, y);
    const forward = this.forward;
    const right: Vec3 = [Math.cos(this.yaw), -Math.sin(this.yaw), 0];
    const step = (axis: 0 | 1 | 2): number =>
      feet[axis] + (forward[axis] * y + right[axis] * x) * speed * seconds;
    this.character.carry(feet, [step(0), step(1), step(2)]);
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

  /** The third-person camera at `at` (`blocked`: a wall stopped it), eased out of a wall. */
  #recover(at: Vec3, blocked: boolean, deltaSeconds: number): [number, number, number] {
    const { ini } = this.#setup;
    if (blocked) {
      this.#collided = { at, progress: 0 };
      return [...at];
    }
    const from = this.#collided;
    if (!from) return [...at];
    const way = (at[0] - from.at[0]) ** 2 + (at[1] - from.at[1]) ** 2 + (at[2] - from.at[2]) ** 2;
    if (way > ini.number('Camera', 'fCollisionRecoveryMinDist')) {
      from.progress = Math.min(
        1,
        from.progress + ini.number('Camera', 'fCollisionRecoverySpeed') * deltaSeconds,
      );
      if (from.progress < 1) {
        const t = from.progress;
        return [
          from.at[0] + (at[0] - from.at[0]) * t,
          from.at[1] + (at[1] - from.at[1]) * t,
          from.at[2] + (at[2] - from.at[2]) * t,
        ];
      }
    }
    this.#collided = undefined;
    return [...at];
  }

  /** First or third person (third: zoomed out at least to the shoulder). */
  setPov(pov: Pov): void {
    // A point of view asked for ends the vanity camera (it does not go back after).
    this.vanity.input();
    this.#vanityPov = undefined;
    this.pov = pov;
    if (pov === 'third') this.#zoomTarget = Math.max(this.#zoomTarget, 0);
  }

  /**
   * Where the third-person camera last met a wall, and how far it has eased back out since
   * (0..1; fCollisionRecoverySpeed a second). Undefined: it is where it should be.
   */
  #collided: { readonly at: Vec3; progress: number } | undefined;

  /**
   * First person at the eye; third person behind the shoulder, kept out of walls. Observed in the
   * original: looking down pulls the third-person camera back by up to
   * fPitchZoomOutMaxDist (in step with the pitch, all of it looking straight down); a camera a
   * wall pushed in eases back out once the wall is gone, from where it met it, when the way back
   * is longer than √fCollisionRecoveryMinDist (else it jumps there).
   */
  #placeCamera(alpha: number, deltaSeconds = 0): void {
    const { ini, physics } = this.#setup;
    const body = this.#body;
    const feet = this.character.feetAt(alpha);
    if (this.pov === 'first') {
      this.#collided = undefined;
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
    // A dragon's back widens the zoom's ends (src/shell/camera-states.ts).
    const [min, max] = zoomRange((key) => ini.number('Camera', key), this.mount?.());
    // The vanity camera circles the body itself, fDefaultAutoVanityZoom away.
    const vanity = this.vanity.active;
    const [shoulderX, shoulderBack, shoulderZ] = vanity
      ? [0, 0, 0]
      : (this.#shoulder ?? [
          ini.number('Camera', 'fOverShoulderPosX'),
          0,
          ini.number('Camera', 'fOverShoulderPosZ'),
        ]);
    const pitchZoom =
      this.pitch < 0
        ? (-this.pitch / (Math.PI / 2)) * ini.number('Camera', 'fPitchZoomOutMaxDist')
        : 0;
    const distance = vanity
      ? ini.number('Camera', 'fDefaultAutoVanityZoom')
      : Math.max(0, min + this.#zoom * (max - min) + shoulderBack + pitchZoom);
    const yaw = this.#viewYaw();
    const right: Vec3 = [Math.cos(yaw), -Math.sin(yaw), 0];
    const pivot: Vec3 = [
      target[0] + right[0] * shoulderX,
      target[1] + right[1] * shoulderX,
      target[2] + shoulderZ,
    ];
    const forward = this.#viewForward();
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
    const at: Vec3 = [
      pivot[0] + back[0] * reach,
      pivot[1] + back[1] * reach,
      pivot[2] + back[2] * reach,
    ];
    this.position = this.#recover(at, reach < distance - 1e-3, deltaSeconds);
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

  /**
   * CameraOverrideStart / CameraOverrideStop (the player's graph): observed in the
   * original, a flag of the camera's third-person state set and cleared. TODO(M13): what the
   * third-person camera does with it is not read; nothing reads it yet.
   */
  cameraOverride = false;

  /**
   * The bow's zoom as the player's graph has it (BowZoomStart / BowZoomStop: observed in the
   * original, the zoom starts and stops on these events); undefined until the graph raised
   * either (the input's block alone then: src/shell/player-combat.ts).
   */
  graphBowZoom: boolean | undefined;

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
    let forward = this.#viewForward();
    let yaw = this.#viewYaw();
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
    this.#view.set(view);
    const projection = perspectiveReversedZ(fovY, aspect, this.near);
    projection[8] = -this.lensShift;
    return multiply(projection, view, out);
  }

  /**
   * The arms' view-projection (src/render/first-person-view.ts): the view just made, with first
   * person's own field of view: a bow's zoom, a conversation's and the tween menu's narrow the
   * world's, not this.
   */
  firstPersonViewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    return firstPersonViewProjection(this.#view, this.#firstPersonFov, aspect, this.lensShift, out);
  }

  /** Told of each user event the player presses (help messages wait for one). */
  onPress: ((name: string) => void) | undefined;

  /** Presses or releases a user event by its control map name ("Forward", "Jump", ...). */
  press(name: string, down: boolean): void {
    if (down) {
      this.#input = true;
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

  /** The control map with the player's remaps, as the player reads it now. */
  get controlMap(): ControlMap | undefined {
    this.#current();
    return this.#bound;
  }

  /** The user events of the main gameplay context bound to a gamepad input (PadInput). */
  eventsOfPad(input: number): readonly string[] {
    this.#current();
    return this.#bound ? padEvents(this.#bound, InputContext.gameplay, input) : [];
  }

  /**
   * The left stick (Move): x right, y forward, past its dead zone (src/shell/gamepad-input.ts).
   * Moved by it alone, its deflection sets the pace (src/world/movement.ts stickPace).
   */
  stick: readonly [number, number] = [0, 0];

  /**
   * The right stick (Look) held for some seconds: fGamepadHeadingSensitivity of π radians per
   * second at full deflection. TODO(M13): the engine's own look rate and its acceleration.
   */
  lookStick(x: number, y: number, seconds: number): void {
    if (x === 0 && y === 0) return;
    const { ini } = this.#setup;
    const rate = Math.PI * (ini.number('Controls', 'fGamepadHeadingSensitivity') || 0.6667);
    const invert = ini.bool('Controls', 'bInvertYValues') ? -1 : 1;
    this.#input = true;
    this.yaw += x * rate * seconds;
    this.pitch = Math.max(
      -MAX_PITCH,
      Math.min(MAX_PITCH, this.pitch - invert * y * rate * seconds),
    );
  }

  /** Forgets every held key (the window lost focus). */
  releaseAll(): void {
    this.#held.clear();
    this.stick = [0, 0];
  }

  /**
   * Mouse look by mouse counts: fMouseHeadingSensitivity × fMouseHeadingXScale × π radians per
   * count; vertically also × fMouseHeadingYScale.
   */
  look(countsX: number, countsY: number): void {
    const { ini } = this.#setup;
    if (countsX !== 0 || countsY !== 0) this.#input = true;
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
    this.#input = true;
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
