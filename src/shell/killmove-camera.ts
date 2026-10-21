// The killmove camera (docs/ai.md, "Combat"): a paired killmove the player is in, seen in third
// person, is shown by the kill cameras' tree (CPTH): from PairedKillTest (GetPairedAnimation)
// down, the first path whose conditions hold, the deepest with shots; its shots (CAMS) play in
// turn, each its Max Time: the camera at its model's ExportCam node (meshes\cameras\*.nif) in
// the frame of the shot's location (the attacker, the target), looking at its target. The
// conditions run on the target (the attacker their target) with the kill (KillCameraContext):
// GetVATSValue's weapon, action and distance, and the VATS sides' functions
// (GetVATS{Left,Right,Back,Front}AreaFree: the free space beside one of them, a ray from its
// chest; ...TargetVisible: how far into it the other is still seen). TODO(M13): the shots' time
// multipliers (slow motion: the engine's time scale) and their image-space modifiers.

import {
  CameraSubject,
  parseCameraPath,
  parseCameraShot,
  type CameraPathRecord,
  type CameraShot,
} from '../gameplay/combat/combat-records.ts';
import { parseNif } from '../formats/nif/nif.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from '../render/math.ts';
import type { Camera } from '../render/view-camera.ts';
import type { Condition } from '../scripting/conditions.ts';
import type { KillCameraContext } from '../scripting/runtime/condition-values.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ObjectHandle } from '../scripting/values.ts';
import { meshPath } from '../world/actors.ts';
import type { GameSession } from './game-session.ts';

/** The kill cameras' root for paired animations. */
const ROOT = 'pairedkilltest';
/** How far the free space is looked for (game units). */
const AREA_REACH = 512;
/** A chest's height over the feet (game units). */
const CHEST = 96;
/** The steps a camera's sight of the other is tried at beside a reference (units). */
const VISIBLE_STEP = 10;
/** GetVATSValue's actions (xEdit wbConditionVATSValueParameters, VATS Action). */
const VatsAction = { unarmed: 0, oneHanded: 1, twoHanded: 2, magic: 3, ranged: 4 } as const;

/** What the camera shows. */
export interface KillmoveSubjects {
  readonly attacker: () => Vec3 | undefined;
  readonly attackerHeading: () => number;
  readonly target: () => Vec3 | undefined;
  readonly attackerRef: number;
  readonly targetRef: number;
  readonly physics: PhysicsWorld;
}

/** A shot to play: where its camera sits in its subject's frame, for how long. */
interface Shot {
  readonly record: CameraShot;
  readonly offset: Vec3;
  readonly fovY: number;
}

let paths: Promise<CameraPathRecord[]> | undefined;

export class KillmoveCamera implements Camera {
  readonly near = 5;
  position: Vec3 = [0, 0, 0];
  forward: Vec3 = [0, 1, 0];
  readonly #shots: readonly Shot[];
  readonly #subjects: KillmoveSubjects;
  #shot = 0;
  #time = 0;
  done = false;

  private constructor(shots: readonly Shot[], subjects: KillmoveSubjects) {
    this.#shots = shots;
    this.#subjects = subjects;
    this.update(0);
  }

  /** The shots the kill cameras' tree gives this killmove (undefined: none, the player's own). */
  static async choose(
    session: GameSession,
    subjects: KillmoveSubjects,
  ): Promise<KillmoveCamera | undefined> {
    const runtime = session.scriptsReady;
    if (!runtime) return undefined;
    paths ??= session.db.then(async (db) => {
      const found: CameraPathRecord[] = [];
      for (const formId of db.formIdsOfType('CPTH')) {
        const record = await db.get(formId);
        if (record && !record.deleted) found.push(parseCameraPath(record));
      }
      return found;
    });
    const all = await paths;
    const root = all.find((path) => path.editorId.toLowerCase() === ROOT);
    if (!root) return undefined;
    const subject = new ObjectHandle(subjects.targetRef, 'actor');
    const context = {
      target: runtime.referenceHandle(subjects.attackerRef),
      kill: await killOf(runtime, subjects),
    };
    const holds = (conditions: readonly Condition[]): Promise<boolean> =>
      runtime.conditionsHold(conditions, subject, undefined, context);
    // Down the tree: the first child whose conditions hold, as deep as it goes.
    let node = root;
    let shots = node.shots;
    for (let depth = 0; depth < 16; depth++) {
      let next: CameraPathRecord | undefined;
      for (const child of all.filter((path) => path.parent === node.formId)) {
        if (await holds(child.conditions)) {
          next = child;
          break;
        }
      }
      if (!next) break;
      node = next;
      if (node.shots.length > 0) shots = node.shots;
    }
    const db = await session.db;
    const made: Shot[] = [];
    for (const formId of shots) {
      const record = await db.get(formId);
      if (record?.type !== 'CAMS') continue;
      const shot = parseCameraShot(record);
      // The first-person shot (no model): the player's own camera.
      if (shot.model === undefined) return undefined;
      const path = meshPath(shot.model);
      if (!session.vfs.has(path)) continue;
      const file = parseNif(await session.vfs.read(path));
      let offset: Vec3 = [0, -200, 80];
      let fovY = (50 * Math.PI) / 180;
      for (const block of file.blocks) {
        if (block.kind === 'node' && block.name === 'ExportCam') {
          const [x, y, z] = block.transform.translation;
          offset = [x, y, z];
        } else if (block.kind === 'camera') {
          fovY = 2 * Math.atan(Math.abs(block.frustum.top));
        }
      }
      made.push({ record: shot, offset, fovY });
    }
    return made.length > 0 ? new KillmoveCamera(made, subjects) : undefined;
  }

  update(deltaSeconds: number): void {
    const shot = this.#shots[this.#shot];
    if (!shot) {
      this.done = true;
      return;
    }
    this.#time += deltaSeconds;
    if (this.#time > Math.max(0.1, shot.record.maxTime)) {
      this.#shot++;
      this.#time = 0;
      if (this.#shot >= this.#shots.length) {
        this.done = true;
        return;
      }
    }
    const current = this.#shots[this.#shot] ?? shot;
    const subjects = this.#subjects;
    const attacker = subjects.attacker();
    const target = subjects.target();
    if (!attacker || !target) {
      this.done = true;
      return;
    }
    const location = current.record.location === CameraSubject.target ? target : attacker;
    const heading = subjects.attackerHeading();
    const [ox, oy, oz] = current.offset;
    // The offset in the location's frame (x right, y forward), turned to its heading.
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    this.position = [
      location[0] + ox * cos + oy * sin,
      location[1] - ox * sin + oy * cos,
      location[2] + oz,
    ];
    const look = current.record.target === CameraSubject.attacker ? attacker : target;
    const at: Vec3 = [look[0], look[1], look[2] + CHEST * 0.75];
    const way: Vec3 = [
      at[0] - this.position[0],
      at[1] - this.position[1],
      at[2] - this.position[2],
    ];
    const length = Math.hypot(way[0], way[1], way[2]) || 1;
    this.forward = [way[0] / length, way[1] / length, way[2] / length];
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const shot = this.#shots[Math.min(this.#shot, this.#shots.length - 1)];
    const target: Vec3 = [
      this.position[0] + this.forward[0],
      this.position[1] + this.forward[1],
      this.position[2] + this.forward[2],
    ];
    const view = lookAt(this.position, target, [0, 0, 1]);
    const projection = perspectiveReversedZ(shot?.fovY ?? 0.9, aspect, this.near);
    return multiply(projection, view, out);
  }
}

/**
 * The kill the camera shows, as the kill cameras' conditions ask it (KillCameraContext): the
 * attacker's weapon and its action (a paired killmove: unarmed, one- or two-handed), the
 * target, their distance, and the free space beside either of them.
 */
async function killOf(
  runtime: ScriptRuntime,
  subjects: KillmoveSubjects,
): Promise<KillCameraContext> {
  const weapon = await runtime.equipment.weapon(subjects.attackerRef, 'right');
  const item = weapon === undefined ? undefined : await runtime.equipment.item(weapon);
  const type = item?.weapon?.weaponType;
  const attacker = subjects.attacker();
  const target = subjects.target();
  return {
    weapon,
    target: await runtime.baseOf(subjects.targetRef),
    distance:
      attacker && target
        ? Math.hypot(attacker[0] - target[0], attacker[1] - target[1], attacker[2] - target[2])
        : 0,
    action: actionOf(type),
    critical: false,
    fatal: true,
    weaponType: type,
    projectileType: undefined,
    delivery: undefined,
    castingType: undefined,
    areaFree: (reference, side) => areaFree(subjects, placeOf(subjects, reference), side),
    targetVisible: (reference, side) => targetVisible(subjects, reference, side),
  };
}

/** GetVATSValue's action of a weapon's animation type (WEAP DNAM: 0 hand to hand .. 9). */
function actionOf(type: number | undefined): number {
  switch (type) {
    case 1:
    case 2:
    case 3:
    case 4:
      return VatsAction.oneHanded;
    case 5:
    case 6:
      return VatsAction.twoHanded;
    case 7:
    case 9:
      return VatsAction.ranged;
    case 8:
      return VatsAction.magic;
    default:
      return VatsAction.unarmed;
  }
}

/** Where the attacker or the target is (the other: the target). */
function placeOf(subjects: KillmoveSubjects, reference: number): Vec3 | undefined {
  return reference === subjects.attackerRef ? subjects.attacker() : subjects.target();
}

/**
 * The free space beside a place, turned by the angle from the attacker's facing (units): the
 * camera's frame is the attacker's.
 */
function areaFree(subjects: KillmoveSubjects, from: Vec3 | undefined, angle: number): number {
  if (!from || !subjects.physics.queriesCurrent) return AREA_REACH;
  const heading = subjects.attackerHeading() + angle;
  const hit = subjects.physics.raycast(
    [from[0], from[1], from[2] + CHEST],
    [Math.sin(heading), Math.cos(heading), 0],
    AREA_REACH,
    Layer.camera,
  );
  return hit?.distance ?? AREA_REACH;
}

/**
 * How far beside a reference (the angle from the attacker's facing) a camera still sees the
 * other of the kill: the farthest point of the free space from which a ray to the other's chest
 * is clear (units). TODO(M13): the engine's measure is not documented (the data compares it with
 * 60 and 110).
 */
function targetVisible(subjects: KillmoveSubjects, reference: number, angle: number): number {
  const from = placeOf(subjects, reference);
  const other = reference === subjects.attackerRef ? subjects.target() : subjects.attacker();
  if (!from || !other || !subjects.physics.queriesCurrent) return AREA_REACH;
  const free = areaFree(subjects, from, angle);
  const heading = subjects.attackerHeading() + angle;
  const to: Vec3 = [other[0], other[1], other[2] + CHEST * 0.75];
  let seen = 0;
  for (let step = VISIBLE_STEP; step <= free; step += VISIBLE_STEP) {
    const at: Vec3 = [
      from[0] + Math.sin(heading) * step,
      from[1] + Math.cos(heading) * step,
      from[2] + CHEST,
    ];
    const way: Vec3 = [to[0] - at[0], to[1] - at[1], to[2] - at[2]];
    const length = Math.hypot(way[0], way[1], way[2]);
    if (length < 1) continue;
    const hit = subjects.physics.raycast(
      at,
      [way[0] / length, way[1] / length, way[2] / length],
      length,
      Layer.camera,
    );
    if (hit) break;
    seen = step;
  }
  return seen;
}
