// The kill camera (docs/animation.md, "Killmoves"): a killmove the player leads is shown by the
// kill cameras' tree (CPTH, KillmoveCamera.choose: the engine's search), first person or third;
// its shots (CAMS) play in turn, each its Max Time: the camera at its model's ExportCam node
// (meshes\cameras\*.nif) in the frame of the shot's location (the attacker, the target),
// looking at its target, the world's clock at the shot's global time multiplier (the slow
// motion), the shot's image-space modifier cross-faded in (fVATSImageSpaceTransitionTime). A
// first-person shot leaves the player's own view. The conditions run on the attacker (the
// victim their target) with the kill (KillCameraContext): GetVATSValue's weapon, action and
// distance, and the VATS sides' functions (GetVATS{Left,Right,Back,Front}AreaFree: the free
// space beside one of them; ...TargetVisible: how far out to that side the other is still seen).

import {
  CameraSubject,
  parseCameraPath,
  parseCameraShot,
  type CameraPathRecord,
  type CameraShot,
} from '../gameplay/combat/combat-records.ts';
import { orderSiblings } from '../ai/idle-records.ts';
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

/** CPTH DATA bit 7: the path does not need shots ("Default", not "..., Must Have Camera Shots"). */
const SHOTS_OPTIONAL = 0x80;
/** How far the free space is looked for (game units: the engine's ray). */
const AREA_REACH = 10000;
/** A chest's height over the feet (game units). */
const CHEST = 96;
/** How far a ray steps on through the body it started in (game units). */
const SELF_STEP = 8;
/** GetVATSValue's actions (xEdit wbConditionVATSValueParameters, VATS Action). */
const VatsAction = { unarmed: 0, oneHanded: 1, twoHanded: 2, magic: 3, ranged: 4 } as const;

/** What the camera shows. */
export interface KillmoveSubjects {
  readonly attacker: () => Vec3 | undefined;
  readonly attackerHeading: () => number;
  readonly target: () => Vec3 | undefined;
  readonly targetHeading: () => number;
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
  /** The kill cameras' path it plays (CPTH editor id: development, tools). */
  readonly path: string;

  private constructor(shots: readonly Shot[], subjects: KillmoveSubjects, path: string) {
    this.#shots = shots;
    this.#subjects = subjects;
    this.path = path;
    this.update(0);
  }

  /**
   * The shots the kill cameras' tree gives this killmove (undefined: none, the player's own
   * view). Observed in the original: the tree's roots in order (each names the one before
   * it), each searched depth first: a path whose conditions hold (run on the attacker, the
   * victim their target) is tried below first, and is itself the answer if none below is and
   * it has shots (or does not need them: DATA bit 7). The answer needs every shot to last (a
   * max or min time); one that does not need shots but has them gives none.
   */
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
    const children = (parent: number | undefined): CameraPathRecord[] =>
      orderSiblings(all.filter((path) => path.parent === parent));
    const subject = new ObjectHandle(subjects.attackerRef, 'actor');
    const context = {
      target: runtime.referenceHandle(subjects.targetRef),
      kill: await killOf(runtime, subjects, session),
    };
    const holds = (conditions: readonly Condition[]): Promise<boolean> =>
      runtime.conditionsHold(conditions, subject, undefined, context);
    const seen = new Set<number>();
    const search = async (path: CameraPathRecord): Promise<CameraPathRecord | undefined> => {
      if (seen.has(path.formId) || !(await holds(path.conditions))) return undefined;
      seen.add(path.formId);
      for (const child of children(path.formId)) {
        const found = await search(child);
        if (found) return found;
      }
      return path.shots.length > 0 || (path.zoom & SHOTS_OPTIONAL) !== 0 ? path : undefined;
    };
    let chosen: CameraPathRecord | undefined;
    for (const root of children(undefined)) {
      chosen = await search(root);
      if (chosen) break;
    }
    if (!chosen || chosen.shots.length === 0 || (chosen.zoom & SHOTS_OPTIONAL) !== 0) {
      return undefined;
    }
    const db = await session.db;
    const made: Shot[] = [];
    for (const formId of chosen.shots) {
      const record = await db.get(formId);
      if (record?.type !== 'CAMS') continue;
      const shot = parseCameraShot(record);
      if (shot.maxTime === 0 && shot.minTime === 0) return undefined;
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
    return made.length > 0 ? new KillmoveCamera(made, subjects, chosen.editorId) : undefined;
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

  /** How fast the world's clock runs during the current shot (CAMS global time multiplier). */
  get timeMultiplier(): number {
    const shot = this.#shots[this.#shot];
    return this.done || !shot ? 1 : shot.record.globalTimeMult;
  }

  /** The current shot's image-space modifier (IMAD), if it has one. */
  get imageSpaceModifier(): number | undefined {
    return this.done ? undefined : this.#shots[this.#shot]?.record.imageSpaceModifier;
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
  session: GameSession,
): Promise<KillCameraContext> {
  const weapon = await runtime.equipment.weapon(subjects.attackerRef, 'right');
  const item = weapon === undefined ? undefined : await runtime.equipment.item(weapon);
  const type = item?.weapon?.weaponType;
  const attacker = subjects.attacker();
  const target = subjects.target();
  const settings = await session.settings();
  const smart: SmartCamera = {
    height: settings.number('fVATSSmartCameraCheckHeight') ?? 96,
    step: settings.number('fVATSSmartCameraCheckStepDistance') ?? 128,
    steps: settings.number('fVATSSmartCameraCheckStepCount') ?? 5,
  };
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
    areaFree: (reference, side) => areaFree(subjects, smart, reference, side),
    targetVisible: (reference, side) => targetVisible(subjects, smart, reference, side),
  };
}

/** The game settings of the kill cameras' space checks. */
interface SmartCamera {
  /** fVATSSmartCameraCheckHeight: the checks' height over the feet. */
  readonly height: number;
  /** fVATSSmartCameraCheckStepDistance, fVATSSmartCameraCheckStepCount: the sight's steps. */
  readonly step: number;
  readonly steps: number;
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

/** Where one of the kill is and which way it faces (the other: the target). */
function placeOf(
  subjects: KillmoveSubjects,
  reference: number,
): { readonly at: Vec3; readonly heading: number } | undefined {
  const attacker = reference === subjects.attackerRef;
  const at = attacker ? subjects.attacker() : subjects.target();
  if (!at) return undefined;
  return { at, heading: attacker ? subjects.attackerHeading() : subjects.targetHeading() };
}

/**
 * GetVATS{Right,Left,Back,Front}AreaFree, observed in the original: how far a ray from the
 * reference (at fVATSSmartCameraCheckHeight over its feet) runs toward the side of its own
 * facing before it meets anything but the reference (none: as far as it was cast).
 */
function areaFree(
  subjects: KillmoveSubjects,
  smart: SmartCamera,
  reference: number,
  angle: number,
): number {
  const from = placeOf(subjects, reference);
  if (!from || !subjects.physics.queriesCurrent) return AREA_REACH;
  const heading = from.heading + angle;
  const direction: Vec3 = [Math.sin(heading), Math.cos(heading), 0];
  // Past the reference's own body (the ray starts inside it).
  let start = 0;
  for (let tries = 0; tries < 16; tries++) {
    const origin: Vec3 = [
      from.at[0] + direction[0] * start,
      from.at[1] + direction[1] * start,
      from.at[2] + smart.height,
    ];
    const hit = subjects.physics.raycast(origin, direction, AREA_REACH - start, Layer.camera);
    if (!hit) return AREA_REACH;
    if (hit.owner?.kind !== 'actor' || hit.owner.reference !== reference) {
      return start + hit.distance;
    }
    start += hit.distance + SELF_STEP;
  }
  return start;
}

/**
 * GetVATS{Right,Left,Back,Front}TargetVisible, observed in the original: from points
 * beside the reference toward the side of its facing (fVATSSmartCameraCheckStepDistance apart,
 * fVATSSmartCameraCheckStepCount of them, at fVATSSmartCameraCheckHeight), a ray to the other
 * of the kill: blocked where it meets something before 85% of the way (another actor only
 * within 256 units). The value is how far out the sight still holds: the last clear step's
 * distance (0: none). (Inferred: the engine's loop stops at the first blocked step; which
 * distance it returns is not in the decompiled code, the data compares it with 60 and 110.)
 */
function targetVisible(
  subjects: KillmoveSubjects,
  smart: SmartCamera,
  reference: number,
  angle: number,
): number {
  const from = placeOf(subjects, reference);
  const other = reference === subjects.attackerRef ? subjects.target() : subjects.attacker();
  if (!from || !other || !subjects.physics.queriesCurrent) return smart.step * smart.steps;
  const heading = from.heading + angle;
  const to: Vec3 = [other[0], other[1], other[2] + CHEST * 0.75];
  let seen = 0;
  for (let step = 1; step <= smart.steps; step++) {
    const at: Vec3 = [
      from.at[0] + Math.sin(heading) * step * smart.step,
      from.at[1] + Math.cos(heading) * step * smart.step,
      from.at[2] + smart.height,
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
    const blocked =
      hit !== undefined &&
      hit.distance <= length * 0.85 &&
      (hit.owner?.kind !== 'actor' || hit.distance <= 256);
    if (blocked) break;
    seen = step * smart.step;
  }
  return seen;
}
