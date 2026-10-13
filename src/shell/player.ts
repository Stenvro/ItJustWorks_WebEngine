// The player: input through the game's control map, movement at the speeds of the movement
// types (MOVT) on the character controller, jumping, swimming, and the first- and
// third-person cameras with the engine's INI settings. Drawn as a camera (the body is drawn
// with the actors, TODO(M7)).

import type { Camera } from '../render/view-camera.ts';
import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from '../render/math.ts';
import { SCAN_CODES, type ControlMap } from '../formats/controlmap/controlmap.ts';
import { CharacterBody } from '../physics/character.ts';
import { HAVOK_SCALE } from '../physics/collision-data.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { GrabSettings } from '../physics/grab.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { IniSettings } from '../world/ini-settings.ts';
import { directionalSpeed, type MovementType } from '../world/movement.ts';
import type { PlayerBody } from '../world/player-body.ts';

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
  readonly controls: ControlMap;
  readonly movement: PlayerMovement;
  /** GMST fJumpHeightMin: how high a jump goes (game units). */
  readonly jumpHeight: number;
  /** GMST fZKey*: the spring that holds grabbed objects. */
  readonly grab: GrabSettings;
  /** Material ids of stairs (MATT with the stairs flag). */
  readonly stairMaterials: ReadonlySet<number>;
}

/**
 * Steepest walkable slope (degrees). The engine keeps it in hkpCharacterProxy::maxSlopeCosine;
 * its value is not documented (no INI setting or GMST sets it). TODO(M13): calibrate.
 */
export const MAX_SLOPE = 60;

export interface PlayerSetup extends PlayerData {
  readonly physics: PhysicsWorld;
  /** The water surface at a point, if there is water there. */
  readonly waterHeight: (x: number, y: number) => number | undefined;
}

/**
 * Submersion (water depth over the body's height) at which an actor swims, and the depth it
 * floats at: the shoulders. Not documented; measured in game by the author of "Wade In Water".
 */
const SWIM_SUBMERSION = 0.69;
/**
 * The highest stair stepped up on stair materials. How the engine climbs them is not
 * documented. The treads of the 330 vanilla stair collision meshes rise mostly 24 or 16 units,
 * but also 25–28 (about a hundred, e.g. Castle Volkihar's courtyard stairs at 24.4) and up to
 * 32 (about forty): stairs the game lets one climb.
 */
const STAIR_HEIGHT = 32;
/** Pitch limit of the cameras (radians). */
const MAX_PITCH = (85 * Math.PI) / 180;
/** Looking further down than this while swimming forward dives. */
const DIVE_PITCH = (-30 * Math.PI) / 180;

type Pov = 'first' | 'third';

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
  /** Third-person zoom (0 = fVanityModeMinDist, 1 = fVanityModeMaxDist). */
  #zoom = 0;
  #zoomTarget = 0;
  #alwaysRun: boolean;
  #autoMove = false;
  sneaking = false;
  #jumpRequested = false;
  /** The camera this frame (game units). */
  position: [number, number, number] = [0, 0, 0];
  readonly near: number;
  lensShift = 0;
  /** Called on every physics step after the player moved (a held object's spring). */
  onStep: ((step: number) => void) | undefined;
  /**
   * Where the player may stand (the worldspace's border regions); undefined: anywhere.
   * Movement across the border stops at it and calls onBorder.
   */
  border: ((x: number, y: number) => boolean) | undefined;
  /** The player tried to leave the border regions ("You cannot go that way."). */
  onBorder: (() => void) | undefined;
  /** The last place inside the border. */
  #inside: Vec3 | undefined;
  readonly #fovY: number;

  constructor(setup: PlayerSetup, feet: Vec3, yaw: number) {
    this.#setup = setup;
    const { body, ini } = setup;
    this.character = new CharacterBody(
      setup.physics,
      {
        // The engine makes the controller from the skeleton's bound: its narrow side.
        radius: Math.min(body.bound.halfExtents[0], body.bound.halfExtents[1]),
        height: body.bound.center[2] + body.bound.halfExtents[2],
      },
      {
        maxSlope: MAX_SLOPE,
        fallingGravity: ini.number('HAVOK', 'fInAirFallingCharGravityMult'),
        unsupportedGravity: ini.number('HAVOK', 'fUnsupportedGravMult'),
        stairMaterials: setup.stairMaterials,
        stairHeight: STAIR_HEIGHT,
      },
      feet,
      { reference: 0x14, kind: 'actor' },
    );
    this.yaw = yaw;
    this.#alwaysRun = ini.bool('Controls', 'bAlwaysRunByDefault');
    this.near = ini.number('Display', 'fNearDistance');
    // fDefaultWorldFOV is the horizontal field of view of a 4:3 frame (wider screens see
    // more at the sides).
    const fov = (ini.number('Display', 'fDefaultWorldFOV') * Math.PI) / 180;
    this.#fovY = 2 * Math.atan(Math.tan(fov / 2) * 0.75);
    // Main gameplay bindings by browser key code and mouse button.
    for (const event of setup.controls.contexts[0] ?? []) {
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

  /** The INI settings the player works with. */
  get ini(): IniSettings {
    return this.#setup.ini;
  }

  /** The spring that holds grabbed objects (GMST fZKey*). */
  get grab(): GrabSettings {
    return this.#setup.grab;
  }

  /** Where the eyes are (the first-person camera), interpolated like the camera. */
  get eye(): Vec3 {
    const feet = this.character.feetAt(this.#setup.physics.alpha);
    return [feet[0], feet[1], feet[2] + this.#setup.body.eyeHeight];
  }

  get forward(): Vec3 {
    const c = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * c, Math.cos(this.yaw) * c, Math.sin(this.pitch)];
  }

  /** Where the player stands (game units). */
  get feet(): Vec3 {
    return this.character.feet;
  }

  get swimming(): boolean {
    return this.character.swimming;
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
    if (this.#take('Toggle POV')) this.#setPov(this.pov === 'first' ? 'third' : 'first');
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
    this.#placeCamera(physics.alpha);
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
    const moving = x !== 0 || y !== 0;
    // Swimming: deep enough water lifts the body.
    const [fx, fy, fz] = character.feet;
    const water = this.#setup.waterHeight(fx, fy);
    const depth = water === undefined ? 0 : (water - fz) / character.shape.height;
    const swimming =
      depth >= SWIM_SUBMERSION || (character.swimming && depth > SWIM_SUBMERSION - 0.05);
    character.swimming = swimming;
    if (swimming) this.sneaking = false;
    // "Run" walks while always-run is on, runs while it is off.
    const running = this.#alwaysRun !== this.#event('Run');
    const sprinting =
      this.#event('Sprint') && y > 0 && !this.sneaking && !swimming && character.grounded;
    const type = swimming
      ? movement.swim
      : sprinting
        ? movement.sprint
        : this.sneaking
          ? movement.sneak
          : movement.normal;
    const speed = moving ? directionalSpeed(running ? type.run : type.walk, x, y) : 0;
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
    } else if (jump && !sprinting) {
      // fJumpHeightMin: the height of the jump; with constant gravity v = √(2 g h).
      const g = -this.#setup.physics.world.gravity.z * HAVOK_SCALE;
      character.jump(Math.sqrt(2 * g * this.#setup.jumpHeight));
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

  #setPov(pov: Pov): void {
    this.pov = pov;
    if (pov === 'third') this.#zoomTarget = Math.max(this.#zoomTarget, 0);
  }

  /** First person at the eye; third person behind the shoulder, kept out of walls. */
  #placeCamera(alpha: number): void {
    const { body, ini, physics } = this.#setup;
    const feet = this.character.feetAt(alpha);
    if (this.pov === 'first') {
      // TODO(M7): the camera follows the animated Camera1st node (sneaking, swimming).
      this.position = [feet[0], feet[1], feet[2] + body.eyeHeight];
      return;
    }
    const target: Vec3 = [
      feet[0] + body.thirdPersonTarget[0],
      feet[1] + body.thirdPersonTarget[1],
      feet[2] + body.thirdPersonTarget[2],
    ];
    const min = ini.number('Camera', 'fVanityModeMinDist');
    const max = ini.number('Camera', 'fVanityModeMaxDist');
    const distance = Math.max(0, min + this.#zoom * (max - min));
    const right: Vec3 = [Math.cos(this.yaw), -Math.sin(this.yaw), 0];
    const shoulderX = ini.number('Camera', 'fOverShoulderPosX');
    const shoulderZ = ini.number('Camera', 'fOverShoulderPosZ');
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
    );
    this.position = [
      pivot[0] + back[0] * reach,
      pivot[1] + back[1] * reach,
      pivot[2] + back[2] * reach,
    ];
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const forward = this.forward;
    const target: Vec3 = [
      this.position[0] + forward[0],
      this.position[1] + forward[1],
      this.position[2] + forward[2],
    ];
    const view = lookAt(this.position, target, [0, 0, 1]);
    const projection = perspectiveReversedZ(this.#fovY, aspect, this.near);
    projection[8] = -this.lensShift;
    return multiply(projection, view, out);
  }

  /** Presses or releases a user event by its control map name ("Forward", "Jump", ...). */
  press(name: string, down: boolean): void {
    if (down) {
      if (!this.#held.has(name)) this.#pressed.add(name);
      this.#held.add(name);
    } else {
      this.#held.delete(name);
    }
  }

  /** The user events bound to a key (by KeyboardEvent.code). */
  eventsOfKey(code: string): readonly string[] | undefined {
    return this.#keyEvents.get(code);
  }

  /** The user events bound to a mouse button (control map ids). */
  eventsOfMouse(button: number): readonly string[] | undefined {
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
    this.pitch = Math.max(
      -MAX_PITCH,
      Math.min(
        MAX_PITCH,
        this.pitch - countsY * perCount * ini.number('Controls', 'fMouseHeadingYScale'),
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
        if (this.#zoomTarget <= lowest + 1e-6) this.#setPov('first');
        else this.#zoomTarget = Math.max(lowest, this.#zoomTarget - step);
      }
    } else if (this.pov === 'first') {
      this.#zoomTarget = ini.number('Camera', 'fMinCurrentZoom');
      this.#zoom = this.#zoomTarget;
      this.#setPov('third');
    } else {
      this.#zoomTarget = Math.min(1, this.#zoomTarget + step);
    }
  }

  free(): void {
    this.character.free();
  }
}
