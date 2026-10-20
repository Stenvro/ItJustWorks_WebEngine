// The killmove camera (docs/ai.md, "Combat"): a paired killmove the player is in, seen in third
// person, is shown by the kill cameras' tree (CPTH): from PairedKillTest (GetPairedAnimation)
// down, the first path whose conditions hold, the deepest with shots; its shots (CAMS) play in
// turn, each its Max Time: the camera at its model's ExportCam node (meshes\cameras\*.nif) in
// the frame of the shot's location (the attacker, the target), looking at its target. The
// VATS conditions (GetVATS{Left,Right,Back,Front}AreaFree) are the free space beside the target
// (a ray from its chest); the others are the running game's. TODO(M13): the shots' time
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
import { ObjectHandle } from '../scripting/values.ts';
import { meshPath } from '../world/actors.ts';
import type { GameSession } from './game-session.ts';

/** The kill cameras' root for paired animations. */
const ROOT = 'pairedkilltest';
/** The VATS area functions (UESP Function Indices): the free space to the right .. front. */
const VATS_AREA: ReadonlyMap<number, number> = new Map([
  [515, Math.PI / 2],
  [516, -Math.PI / 2],
  [517, Math.PI],
  [518, 0],
]);
/** How far the free space is looked for (game units). */
const AREA_REACH = 512;
/** A chest's height over the feet (game units). */
const CHEST = 96;

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
    const context = { target: runtime.referenceHandle(subjects.attackerRef) };
    const holds = async (conditions: readonly Condition[]): Promise<boolean> => {
      const rest: Condition[] = [];
      for (const condition of conditions) {
        const angle = VATS_AREA.get(condition.function);
        if (angle === undefined) {
          rest.push(condition);
          continue;
        }
        const free = areaFree(subjects, angle);
        const comparand = typeof condition.comparand === 'number' ? condition.comparand : 0;
        if (!compare(condition.operator, free, comparand)) return false;
      }
      return runtime.conditionsHold(rest, subject, undefined, context);
    };
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

/** The free space beside the target, turned `angle` from the attacker's facing (units). */
function areaFree(subjects: KillmoveSubjects, angle: number): number {
  const target = subjects.target();
  if (!target || !subjects.physics.queriesCurrent) return AREA_REACH;
  const heading = subjects.attackerHeading() + angle;
  const hit = subjects.physics.raycast(
    [target[0], target[1], target[2] + CHEST],
    [Math.sin(heading), Math.cos(heading), 0],
    AREA_REACH,
    Layer.camera,
  );
  return hit?.distance ?? AREA_REACH;
}

/** A condition's comparison (CTDA operator: ==, !=, >, >=, <, <=). */
function compare(operator: number, value: number, comparand: number): boolean {
  switch (operator) {
    case 0:
      return value === comparand;
    case 1:
      return value !== comparand;
    case 2:
      return value > comparand;
    case 3:
      return value >= comparand;
    case 4:
      return value < comparand;
    default:
      return value <= comparand;
  }
}
