// Mounts (docs/ai.md, "Followers, mounts and vehicles"): actors riding horses. Platform-
// independent.
//
// Mounting goes through the idle tree as using furniture does: under ActionActivate,
// HorseEvents (the target HasKeyword ActorTypeHorse) gives Mount (HorseEnter) to a rider not
// riding (IsRidingHorse 0) about to sit (GetSitting 2), Dismount (HorseExit, HorseExitSwim in
// water) to one riding. Both are paired animations (Paired_Mount.hkx, Paired_Dismount.hkx: the
// rider's graph plays them in MountSynced and DismountSynced, the horse's on the event with
// "pa_" before it): rider and horse stand at the horse's root while it plays, the rider's
// "NPC" track holding where it is from there (mounting, the race's mount offset: 63.479 units
// to the horse's left, facing it). The rider's graph raises NPCpairedStop and NPCHorseExitOut
// at the clip's end: the engine sends it pairedStop and HorseExitOut (and the horse PairEnd),
// which take it to HorseRider_State and back to its feet. Riding, the rider's root is on the
// horse's SaddleBone (its HorseRider_State poses its pelvis at the root), facing the horse's way.
// Getting off, it stands where the dismount's NPC Root ends: 111.6 units to the horse's left.

import type { Gait, MoveRequest } from './locomotion.ts';

type Vec3 = readonly [number, number, number];

/** Where something is and which way it faces (compass radians). */
export interface Placed {
  readonly position: Vec3;
  readonly heading: number;
}

/** The race's mount data (RACE DATA 128..163, src/ai/race-combat-records.ts). */
export interface MountOffsets {
  /** Where a rider stands to mount, in the horse's frame (x right, y forward, z up). */
  readonly mountOffset: Vec3;
  readonly dismountOffset: Vec3;
  readonly mountCameraOffset: Vec3;
}

/** The rider's events at a paired animation's end (the graph raises NPC<event>). */
export const PAIRED_PREFIX = 'NPC';
/** What the horse is sent as the pair ends. */
export const PAIR_END = 'PairEnd';
/** The horse's event for the rider's (pa_HorseEnter for HorseEnter). */
export const partnerEvent = (event: string): string => `pa_${event}`;

/**
 * Where the dismount leaves the rider in the horse's frame: Paired_Dismount.hkx's "NPC" track
 * (1.7, 4.4, 130.4) plus its NPC Root at the clip's end (−113.3, −1.4, −130.3).
 */
export const DISMOUNT_END: Vec3 = [-111.6, 3, 0];

/** A point in an actor's frame (x right, y forward, z up) in the world. */
export function inFrame(at: Placed, offset: Vec3): [number, number, number] {
  const sin = Math.sin(at.heading);
  const cos = Math.cos(at.heading);
  return [
    at.position[0] + offset[0] * cos + offset[1] * sin,
    at.position[1] - offset[0] * sin + offset[1] * cos,
    at.position[2] + offset[2],
  ];
}

/** A world point in an actor's frame (x right, y forward, z up). */
export function toFrame(at: Placed, point: Vec3): [number, number, number] {
  const dx = point[0] - at.position[0];
  const dy = point[1] - at.position[1];
  const sin = Math.sin(at.heading);
  const cos = Math.cos(at.heading);
  return [dx * cos - dy * sin, dx * sin + dy * cos, point[2] - at.position[2]];
}

/**
 * Where a rider stands to mount: the race's mount offset from the horse, facing the horse's
 * root (the mount's "NPC" track, turned a quarter right of the horse from its left).
 */
export function mountPlace(horse: Placed, offsets: MountOffsets): Placed {
  const position = inFrame(horse, [offsets.mountOffset[0], offsets.mountOffset[1], 0]);
  const dx = horse.position[0] - position[0];
  const dy = horse.position[1] - position[1];
  return {
    position,
    heading: Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dx, dy) : horse.heading,
  };
}

/** Where a rider gets off: the dismount's end beside the horse, facing the horse's way. */
export function dismountPlace(horse: Placed): Placed {
  return { position: inFrame(horse, DISMOUNT_END), heading: horse.heading };
}

/**
 * Where a rider's root is: on its horse's saddle (the SaddleBone's place in the world; without
 * a pose, the horse's root), facing the horse's way.
 */
export function saddlePlace(horse: Placed, saddle: Vec3 | undefined): Placed {
  return { position: saddle ?? horse.position, heading: horse.heading };
}

/** The rider's controls: the movement keys (x right, y forward), running, sprinting. */
export interface RiderInput {
  readonly x: number;
  readonly y: number;
  readonly running: boolean;
  readonly sprinting: boolean;
}

/** How a ridden horse moves now, for its rider's back key. */
export interface RiddenMotion {
  /** It moves (its movement controller's speed is not 0). */
  readonly moving: boolean;
  /** It is backing up already (it was asked to, the last time). */
  readonly backing: boolean;
}

/**
 * What a ridden horse is asked to do by its rider's controls (the camera's yaw the way the
 * keys point): forward and to the sides it goes that way, turning to it as it goes (a horse
 * does not walk sideways); sprinting it gallops. Without a key it stands. The back key (observed
 * in the original: the player's movement input on a mount) drops the side keys: a
 * horse that stands, or already backs up, backs up, facing on; one that moves otherwise stops
 * (it is reined in, not turned round). TODO(M13): how the engine turns the horse to the camera
 * (its turn rate, fHorseMaxAngleBeforeTurn) is not read yet: it turns at its movement type's.
 */
export function riddenRequest(
  input: RiderInput,
  viewYaw: number,
  horseHeading: number,
  motion: RiddenMotion = { moving: false, backing: false },
): MoveRequest | undefined {
  const { x, y } = input;
  if (x === 0 && y === 0) return undefined;
  const gait: Gait = input.sprinting && y > 0 ? 'sprint' : input.running ? 'run' : 'walk';
  if (y < 0) {
    if (motion.moving && !motion.backing) return undefined;
    // Backing up: the horse keeps its heading and goes back.
    return {
      direction: [-Math.sin(horseHeading), -Math.cos(horseHeading)],
      gait: 'walk',
      face: horseHeading,
    };
  }
  const way = viewYaw + Math.atan2(x, Math.max(y, 0));
  return { direction: [Math.sin(way), Math.cos(way)], gait };
}

/**
 * Whether a horse may be ridden by an actor without stealing it: the player may ride their
 * own (bought: the PlayerHorseFaction's, or the last they rode) and those no one owns; an
 * actor its own (the ACHR's XHOR) and those of its factions. Riding another's is stealing
 * (sStealHorse: iCrimeGoldStealHorse; src/scripting/runtime/crime-engine.ts horseTheft).
 */
export function ownsHorse(
  owner: { readonly actor?: number | undefined; readonly faction?: number | undefined },
  rider: {
    readonly base: number;
    readonly factions: ReadonlySet<number>;
    readonly lastRidden?: boolean;
  },
): boolean {
  if (rider.lastRidden) return true;
  if (owner.actor === undefined && owner.faction === undefined) return true;
  if (owner.actor !== undefined && owner.actor === rider.base) return true;
  return owner.faction !== undefined && rider.factions.has(owner.faction);
}
