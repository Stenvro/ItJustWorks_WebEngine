// The kill camera (docs/animation.md, "Killmoves"): a killmove the player leads is shown by the
// kill cameras' tree (CPTH, KillmoveCamera.choose: the engine's search), first person or third;
// its shots (CAMS) play in turn, each its Max Time: the camera where its model puts it
// (meshes\cameras\*.nif: the root node's place moved by its keys or along its path, the field of
// view by the NiCamera's BSFrustumFOVController; src/render/camera-model.ts), from the shot's
// start, measured from its location's node (the attacker's torso or WEAPON node, the target's
// torso, the projectile) in the attacker's frame, looking at its target's node and turned by the
// model root's own rotation (#shotPoint, shotAxes), the world's clock at the shot's global time
// multiplier (the slow motion), the shot's image-space modifier cross-faded in
// (fVATSImageSpaceTransitionTime). A
// first-person shot leaves the player's own view. The conditions run on the attacker (the
// victim their target) with the kill (KillCameraContext): GetVATSValue's weapon, action and
// distance, and the VATS sides' functions (GetVATS{Left,Right,Back,Front}AreaFree: the free
// space beside one of them; ...TargetVisible: how far out to that side the other is still seen).

import {
  SHOT_TRANSITION_DEFAULTS,
  shotDollyTime,
  shotStartMode,
  transitionBlur,
  type ShotStartMode,
  type ShotTransition,
} from '../gameplay/combat/kill-camera-transition.ts';
import {
  CameraAction,
  CameraShotFlag,
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
import {
  readCameraModel,
  rootRotation,
  sampleCameraModel,
  shotAxes,
  type CameraModel,
} from '../render/camera-model.ts';
import type { GameSession } from './game-session.ts';

/** CPTH DATA bit 7: the path does not need shots ("Default", not "..., Must Have Camera Shots"). */
const SHOTS_OPTIONAL = 0x80;
/** How far the free space is looked for (game units: the engine's ray). */
const AREA_REACH = 10000;
/** A chest's height over the feet (game units). */
const CHEST = 96;
/** A shot without a readable model: its camera's place and field of view. */
const DEFAULT_OFFSET: Vec3 = [0, -200, 80];
const DEFAULT_FOV = (50 * Math.PI) / 180;
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
  /** A shot's kill: its projectile, where it flies (CAMS location and target 1). */
  readonly projectile?: () => { readonly position: Vec3; readonly heading: number } | undefined;
  /** What the kill was done with, for GetVATSValue: a projectile's type bits (PROJ DATA). */
  readonly projectileType?: number;
  /** The camera ends after this long whatever its shots (fVATSSafetyMaxTime{Ranged}, seconds). */
  readonly maxSeconds?: number;
  /** The move between shots' settings (none: the engine's values). */
  readonly transition?: ShotTransition;
  /** Whether the kill is predicted to kill (GetVATSValue's fatal; a killmove always is). */
  readonly fatal?: boolean;
  readonly attackerRef: number;
  readonly targetRef: number;
  readonly physics: PhysicsWorld;
  /**
   * Where a node of one of the kill is in the world: its torso (its race's body part data's
   * torso part's node) or its WEAPON node; undefined when it has none (its feet stand in, as
   * the original's 3D root). Absent: no skeleton is known (the feet, the look at chest height).
   */
  readonly node?: (reference: number, which: 'torso' | 'weapon') => Vec3 | undefined;
  /** An actor's height (its middle is a between-actors look's height; none: a chest's). */
  readonly height?: (reference: number) => number;
  /**
   * Whether an actor leads the paired animation it plays (its synchronized clip's
   * bLeadCharacter): the lead actor of a shot (CAMS subject 3) is the target when it leads.
   */
  readonly leads?: (reference: number) => boolean;
  /** Where the player's view is as the camera begins (its first shot dollies from there). */
  readonly from?: () => Vec3 | undefined;
  /** Whether the player is dead (a shot then does not cut away to their view). */
  readonly playerDead?: () => boolean;
}

/** A shot to play: its camera model (where it sits in its subject's frame), for how long. */
interface Shot {
  readonly record: CameraShot;
  readonly model: CameraModel | undefined;
}

let paths: Promise<CameraPathRecord[]> | undefined;

export class KillmoveCamera implements Camera {
  readonly near = 5;
  /** The current shot's vertical field of view (radians), as its model animates it. */
  fovY = DEFAULT_FOV;
  position: Vec3 = [0, 0, 0];
  forward: Vec3 = [0, 1, 0];
  /** The view's up (a shot's own turn may roll it). */
  up: Vec3 = [0, 0, 1];
  readonly #shots: readonly Shot[];
  readonly #subjects: KillmoveSubjects;
  #shot = 0;
  #time = 0;
  /** Seconds since it began (its safety time). */
  #elapsed = 0;
  /** How its path's shots start (CPTH DATA: dolly, cut, or a Zoom shot's own time). */
  readonly #mode: ShotStartMode;
  /**
   * The move into the current shot: where the camera was as it began (none: no view to come
   * from), the seconds of it so far, how long it takes.
   */
  #dolly: { readonly from: Vec3; seconds: number; readonly time: number } | undefined;
  /** The current shot's lead actor (CAMS subject 3): the attacker or the target. */
  #lead: number = CameraSubject.attacker;
  /** The current shot's own spot came within the cut-away distance of its look last update. */
  #near = false;
  /**
   * The shot was cut away (observed in the original: its camera came within
   * fVATSCameraCutAwayDistance of what it looks at while the player lives): the player's
   * first-person view shows from then on, the playback (its time and image space) going on.
   */
  cutAway = false;
  /** The current shot's location and target where they were as it began (its follow flags). */
  #spots: { readonly shot: number; location?: Vec3; target?: Vec3 } | undefined;
  /**
   * The radial blur's strength now (the move between shots), 0 when none. TODO(M13): the
   * image-space stack takes no free radial blur yet (it needs a neutral modifier frame).
   */
  radialBlur = 0;
  /** Where its projectile was last (a shot that hit is gone). */
  #projectile: { readonly position: Vec3; readonly heading: number } | undefined;
  done = false;
  /** The kill cameras' path it plays (CPTH editor id: development, tools). */
  readonly path: string;

  private constructor(
    shots: readonly Shot[],
    subjects: KillmoveSubjects,
    path: string,
    mode: ShotStartMode,
  ) {
    this.#shots = shots;
    this.#subjects = subjects;
    this.path = path;
    this.#mode = mode;
    this.#begin(subjects.from?.());
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
      made.push({ record: shot, model: readCameraModel(parseNif(await session.vfs.read(path))) });
    }
    return made.length > 0
      ? new KillmoveCamera(made, subjects, chosen.editorId, shotStartMode(chosen.zoom))
      : undefined;
  }

  /**
   * A camera playing given shots (no models: each its default place) with a path's DATA, as
   * choose would make it (tests, tools).
   */
  static ofShots(
    shots: readonly CameraShot[],
    subjects: KillmoveSubjects,
    pathData = 0,
  ): KillmoveCamera {
    const played = shots.map((record) => ({ record, model: undefined }));
    return new KillmoveCamera(played, subjects, 'shots', shotStartMode(pathData));
  }

  update(deltaSeconds: number): void {
    const shot = this.#shots[this.#shot];
    if (!shot) {
      this.done = true;
      return;
    }
    this.#time += deltaSeconds;
    this.#elapsed += deltaSeconds;
    if (this.#elapsed > (this.#subjects.maxSeconds ?? Infinity)) {
      this.done = true;
      return;
    }
    if (this.#dolly) this.#dolly.seconds += deltaSeconds;
    if (this.#time > Math.max(0.1, shot.record.maxTime)) {
      this.#shot++;
      this.#time = 0;
      if (this.#shot >= this.#shots.length) {
        this.done = true;
        return;
      }
      this.#begin(this.position);
    }
    const current = this.#shots[this.#shot] ?? shot;
    const subjects = this.#subjects;
    const attacker = subjects.attacker();
    const target = subjects.target();
    if (!attacker || !target) {
      this.done = true;
      return;
    }
    this.#projectile = subjects.projectile?.() ?? this.#projectile;
    const record = current.record;
    // Where the shot is measured from and what it looks at (shotPoint); without the follow
    // flags, where they were as the shot began.
    if (this.#spots?.shot !== this.#shot) this.#spots = { shot: this.#shot };
    const spots = this.#spots;
    const follows = (flag: number): boolean => (record.flags & flag) !== 0;
    const live = (subject: number, follow: boolean, held: Vec3 | undefined): Vec3 =>
      follow || !held ? this.#shotPoint(subject, record.flags, attacker, target) : held;
    const location = live(
      record.location,
      follows(CameraShotFlag.positionFollowsLocation),
      spots.location,
    );
    spots.location ??= location;
    const held = live(record.target, follows(CameraShotFlag.rotationFollowsTarget), spots.target);
    spots.target ??= held;
    // Target % Between Actors: a point that share of the way from the attacker's middle to the
    // target's (observed in the original: each at half its height over its feet).
    const share = record.targetPercentBetweenActors / 100;
    const looked = share > 0 ? this.#between(attacker, target, share) : held;
    // The frame the model's place turns with: the attacker's facing, but the target's for a
    // shot at the target that follows its bone (observed in the original).
    const heading =
      this.#subject(record.location) === CameraSubject.target &&
      !follows(CameraShotFlag.dontFollowBone)
        ? subjects.targetHeading()
        : subjects.attackerHeading();
    // The model's camera at the shot's time (every vanilla camera model has an NiCamera).
    const sample = current.model && sampleCameraModel(current.model, this.#time);
    this.fovY = sample?.fovY ?? DEFAULT_FOV;
    const [ox, oy, oz] = sample?.position ?? DEFAULT_OFFSET;
    // The offset in the location's frame (x right, y forward), turned to its heading.
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const to: Vec3 = [
      location[0] + ox * cos + oy * sin,
      location[1] - ox * sin + oy * cos,
      location[2] + oz,
    ];
    const settings = subjects.transition ?? SHOT_TRANSITION_DEFAULTS;
    // The cut-away (observed in the original): a shot whose own spot came within
    // fVATSCameraCutAwayDistance of its look at the last update hands the view to the player's
    // first person, unless the player is dead (the camera then goes on).
    if (this.#near && subjects.playerDead?.() !== true) this.cutAway = true;
    this.#near =
      Math.hypot(to[0] - looked[0], to[1] - looked[1], to[2] - looked[2]) <=
      settings.cutAwayDistance;
    this.position = to;
    this.radialBlur = 0;
    // Into a shot far from where the camera was: the dolly there (ShotTransition), but never
    // into a Shoot shot.
    const dolly = this.#dolly;
    if (dolly) {
      const from = dolly.from;
      const way: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const progress = dolly.seconds / dolly.time;
      if (
        record.action === CameraAction.shoot ||
        Math.hypot(way[0], way[1], way[2]) <= settings.dollyMin ||
        !(progress < 1)
      ) {
        this.#dolly = undefined;
      } else {
        this.position = [
          from[0] + way[0] * progress,
          from[1] + way[1] * progress,
          from[2] + way[2] * progress,
        ];
        this.radialBlur = transitionBlur(progress, settings.blurCap);
      }
    }
    // Looking at its target, turned by the model root's own rotation where its keys turn it.
    const turn =
      current.model?.turns === true ? rootRotation(current.model, this.#time) : undefined;
    const axes = shotAxes(this.position, looked, turn);
    this.forward = axes.forward;
    this.up = axes.up;
  }

  /**
   * A shot's location or target point (observed in the original): the projectile; the target's
   * torso node (the original's VATS-chosen part, none in a killmove, else its torso part's
   * node); the attacker's WEAPON node for a shot that follows the bone, else its torso node.
   * An actor without that node is measured from its feet (its 3D root); with no skeleton known
   * at all, the look goes to chest height. The lead actor is whichever of the two its shot
   * began with (#begin).
   */
  #shotPoint(subject: number, flags: number, attacker: Vec3, target: Vec3): Vec3 {
    const subjects = this.#subjects;
    const projectile = this.#projectile;
    if (subject === CameraSubject.projectile && projectile) return projectile.position;
    const node = subjects.node;
    const isTarget = this.#subject(subject) === CameraSubject.target;
    const reference = isTarget ? subjects.targetRef : subjects.attackerRef;
    const feet = isTarget ? target : attacker;
    if (!node) return [feet[0], feet[1], feet[2] + CHEST * 0.75];
    const followBone = !isTarget && (flags & CameraShotFlag.dontFollowBone) === 0;
    return (followBone ? node(reference, 'weapon') : undefined) ?? node(reference, 'torso') ?? feet;
  }

  /**
   * A shot begins (observed in the original, as the playback hands it its path's start mode):
   * the move into it from `from` (where the camera was; none: it cuts) by the mode
   * (shotDollyTime), and its lead actor: the target when the target leads the paired animation
   * it plays, else the attacker.
   */
  #begin(from: Vec3 | undefined): void {
    const record = this.#shots[this.#shot]?.record;
    const settings = this.#subjects.transition ?? SHOT_TRANSITION_DEFAULTS;
    const time = record && shotDollyTime(this.#mode, record, settings.dollyTime);
    this.#dolly = from && time !== undefined ? { from, seconds: 0, time } : undefined;
    const subjects = this.#subjects;
    this.#lead =
      subjects.leads?.(subjects.targetRef) === true ? CameraSubject.target : CameraSubject.attacker;
    this.#near = false;
  }

  /** A shot's subject with its lead actor resolved (the attacker, projectile or target). */
  #subject(subject: number): number {
    return subject === CameraSubject.leadActor ? this.#lead : subject;
  }

  /** The point `share` of the way from the attacker's middle to the target's. */
  #between(attacker: Vec3, target: Vec3, share: number): Vec3 {
    const subjects = this.#subjects;
    const middle = (feet: Vec3, reference: number): Vec3 => [
      feet[0],
      feet[1],
      feet[2] + (subjects.height ? subjects.height(reference) / 2 : CHEST * 0.75),
    ];
    const from = middle(attacker, subjects.attackerRef);
    const to = middle(target, subjects.targetRef);
    return [
      from[0] + (to[0] - from[0]) * share,
      from[1] + (to[1] - from[1]) * share,
      from[2] + (to[2] - from[2]) * share,
    ];
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const target: Vec3 = [
      this.position[0] + this.forward[0],
      this.position[1] + this.forward[1],
      this.position[2] + this.forward[2],
    ];
    const view = lookAt(this.position, target, this.up);
    const projection = perspectiveReversedZ(this.fovY, aspect, this.near);
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
    fatal: subjects.fatal ?? true,
    weaponType: type,
    projectileType: projectileTypeOf(subjects.projectileType),
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

/**
 * GetVATSValue's projectile type (0 missile, 1 lobber, 2 beam, 3 flame, 4 cone, 5 barrier, 6
 * arrow: xEdit) of a projectile's type bits (PROJ DATA: 0x1 missile .. 0x40 arrow).
 */
function projectileTypeOf(bits: number | undefined): number | undefined {
  if (bits === undefined || bits <= 0) return undefined;
  return Math.round(Math.log2(bits & -bits));
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
 * distance it returns is not observed in the original, the data compares it with 60 and 110.)
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
