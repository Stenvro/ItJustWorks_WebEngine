// Where shots go (docs/gameplay.md, "Aiming projectiles"; src/gameplay/combat/aim.ts): the
// player's spells and arrows leave the hand (the bow's WEAPON node) along the view, tilted up
// by [Combat] f1PArrowTiltUpAngle / f3PArrowTiltUpAngle (f1PBoltTiltUpAngle for a bolt in first
// person), and the aim assistance turns them, at most fAutoAimMaxDegrees (third person
// fAutoAimMaxDegrees3rdPerson), toward what they aim at: the hostile actor shown in the middle
// of the screen, else the point the camera's ray meets within fAutoAimMaxDistance (the ray's end
// without one) — so they land under the crosshair in either view. An arrow is lifted onto its
// arc and never turned down. An NPC aims at its target's upper body, where the target will be
// when the shot arrives (on a falling shot's arc), off by its aim variance.

import { Layer } from '../physics/collision-layers.ts';
import type { Mat4, Vec3 } from '../render/math.ts';
import {
  AIM_DEFAULTS,
  AIM_HEIGHT,
  aimAngles,
  aimOffset,
  aimPoint,
  anglesOf,
  assistAim,
  directionOf,
  leadPoint,
  readAimSettings,
  type AimSettings,
} from '../gameplay/combat/aim.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { GameSession } from './game-session.ts';
import type { PlayerView } from './race-menu.ts';

/** What a shot is, for its aim. */
export interface ShotKind {
  /** Its speed (units/s) and how fast it falls (units/s²: the PROJ's gravity × the world's). */
  readonly speed: number;
  readonly gravity: number;
  /** A shot of ammunition (an arrow or a bolt), else a spell's. */
  readonly ammunition?: 'arrow' | 'bolt';
  /**
   * Its PROJ's Disable Combat Aim Correction: an NPC's shot goes straight at its target, not led
   * and without its aim variance.
   */
  readonly uncorrected?: boolean;
}

/** An actor shots may be aimed at. */
export interface AimTarget {
  readonly reference: number;
  readonly feet: Vec3;
  readonly height: number;
  readonly radius: number;
}

export interface ProjectileAimOptions {
  readonly session: GameSession;
  readonly player: () => PlayerView | undefined;
  /** The living actors (the player among them). */
  readonly targets: () => Iterable<AimTarget>;
  /** Whether an actor is hostile to another. */
  readonly hostile: (actor: number, target: number) => boolean;
  /** An actor's velocity (units/s), if it moves. */
  readonly velocity: (reference: number) => Vec3 | undefined;
  readonly sneaking?: (reference: number) => boolean;
  /** The screen's aspect (width / height). */
  readonly aspect: () => number;
}

/** The camera's ray passes the player's own bodies this many times at most (units a step). */
const SELF_TRIES = 4;
const SELF_STEP = 4;

/** How a shot's aim variance is chosen (the combat AI's aim controller). */
export type AimVariance = 'bow' | 'immediate' | 'concentration' | 'none';

export class ProjectileAim {
  readonly #options: ProjectileAimOptions;
  #settings: AimSettings = AIM_DEFAULTS;
  #read = false;

  constructor(options: ProjectileAimOptions) {
    this.#options = options;
  }

  get settings(): AimSettings {
    this.#readSettings();
    return this.#settings;
  }

  #readSettings(): void {
    if (this.#read) return;
    this.#read = true;
    void this.#options.session.settings().then((settings) => {
      this.#settings = readAimSettings((name) => settings.number(name));
    });
  }

  /**
   * The point the camera's ray meets within `reach` on the line-of-sight layer (the player's
   * own bodies passed), and what it met; else the ray's end.
   */
  crosshair(
    reach = this.settings.autoAimMaxDistance,
  ): { readonly point: Vec3; readonly reference: number | undefined } | undefined {
    const play = this.#options.player()?.play;
    if (!play) return undefined;
    const from = play.view.position;
    const forward = play.view.forward ?? play.forward;
    const physics = play.player.character.physics;
    let start = 0;
    let distance = reach;
    let reference: number | undefined;
    for (let tries = 0; tries < SELF_TRIES && physics.queriesCurrent; tries++) {
      const origin: Vec3 = [
        from[0] + forward[0] * start,
        from[1] + forward[1] * start,
        from[2] + forward[2] * start,
      ];
      const hit = physics.raycast(
        origin,
        forward,
        reach - start,
        Layer.lineOfSight,
        play.player.character.collider,
      );
      if (!hit) break;
      if (hit.owner?.reference === PLAYER_REF) {
        start += hit.distance + SELF_STEP;
        continue;
      }
      distance = start + hit.distance;
      reference = hit.owner?.kind === 'actor' ? hit.owner.reference : undefined;
      break;
    }
    return {
      point: [
        from[0] + forward[0] * distance,
        from[1] + forward[1] * distance,
        from[2] + forward[2] * distance,
      ],
      reference,
    };
  }

  /**
   * The actor the aim assistance takes: a living one hostile to the player within
   * fAutoAimMaxDistance whose figure on screen reaches into the middle fAutoAimScreenPercentage
   * of it, seen from the camera; of those the one nearest the middle.
   */
  #assisted(): AimTarget | undefined {
    const play = this.#options.player()?.play;
    if (!play) return undefined;
    const settings = this.settings;
    const camera = play.view;
    const matrix = camera.viewProjection(this.#options.aspect());
    const half = settings.autoAimScreenPercentage * 0.005;
    const feet = play.player.feet;
    const physics = play.player.character.physics;
    let best: { target: AimTarget; off: number } | undefined;
    for (const target of this.#options.targets()) {
      if (target.reference === PLAYER_REF) continue;
      const d = Math.hypot(
        target.feet[0] - feet[0],
        target.feet[1] - feet[1],
        target.feet[2] - feet[2],
      );
      if (d > settings.autoAimMaxDistance) continue;
      if (!this.#options.hostile(target.reference, PLAYER_REF)) continue;
      const box = screenBox(matrix, target);
      if (!box) continue;
      if (box.maxX < -half || box.minX > half || box.maxY < -half || box.minY > half) continue;
      const off = Math.abs(box.minX + box.maxX) + Math.abs(box.minY + box.maxY);
      if (best && best.off <= off) continue;
      // Seen from the camera: nothing on the line-of-sight layer before its middle.
      const middle: Vec3 = [target.feet[0], target.feet[1], target.feet[2] + target.height / 2];
      const way: Vec3 = [
        middle[0] - camera.position[0],
        middle[1] - camera.position[1],
        middle[2] - camera.position[2],
      ];
      const length = Math.hypot(...way);
      if (length > 1e-3 && physics.queriesCurrent) {
        const hit = physics.raycast(
          camera.position,
          [way[0] / length, way[1] / length, way[2] / length],
          length,
          Layer.lineOfSight,
          play.player.character.collider,
        );
        const owner = hit?.owner?.reference;
        if (hit && owner !== target.reference && owner !== PLAYER_REF) continue;
      }
      best = { target, off };
    }
    return best?.target;
  }

  /** Whether the player looks through their own eyes (the first-person arms are the hands). */
  firstPerson(): boolean {
    const play = this.#options.player()?.play;
    return play !== undefined && !play.bodyShown;
  }

  /**
   * The direction the player's shot leaves `origin` along (a hand's magic node, the bow's
   * WEAPON node): the view tilted up, turned by the aim assistance toward what it aims at.
   */
  player(origin: Vec3, shot: ShotKind): Vec3 | undefined {
    const play = this.#options.player()?.play;
    if (!play) return undefined;
    const settings = this.settings;
    const ini = this.#options.session.ini;
    const first = this.firstPerson();
    const tilt = first
      ? shot.ammunition === 'bolt'
        ? ini.number('Combat', 'f1PBoltTiltUpAngle')
        : ini.number('Combat', 'f1PArrowTiltUpAngle')
      : ini.number('Combat', 'f3PArrowTiltUpAngle');
    const view = anglesOf(play.view.forward ?? play.forward);
    const reference = { heading: view.heading, pitch: view.pitch + (tilt * Math.PI) / 180 };
    const crosshair = this.crosshair();
    const assisted = this.#assisted();
    // The assisted actor's middle, unless the crosshair is on it already (its point then).
    const point =
      assisted && crosshair?.reference !== assisted.reference
        ? aimPoint(assisted.feet, assisted.height, AIM_HEIGHT.middle)
        : crosshair?.point;
    if (!point) return directionOf(reference);
    const desired = aimAngles(origin, point, shot.speed, shot.gravity);
    const max = first ? settings.autoAimMaxDegrees : settings.autoAimMaxDegrees3rdPerson;
    return directionOf(assistAim(reference, desired, max, shot.ammunition !== undefined));
  }

  /**
   * The direction an NPC's shot leaves `origin` along at `target`: at its upper body where it
   * will be as the shot arrives, on a falling shot's arc, off by the shot's aim variance.
   */
  npc(origin: Vec3, target: AimTarget, shot: ShotKind, variance: AimVariance): Vec3 {
    const settings = this.settings;
    const sneaking = this.#options.sneaking?.(target.reference) === true;
    const upper = aimPoint(target.feet, target.height, AIM_HEIGHT.upper, sneaking);
    const middle = aimPoint(target.feet, target.height, AIM_HEIGHT.middle, sneaking);
    if (shot.uncorrected === true)
      return unit([upper[0] - origin[0], upper[1] - origin[1], upper[2] - origin[2]]);
    const factor =
      variance === 'bow'
        ? settings.rangedAimVariance
        : variance === 'immediate'
          ? settings.magicImmediateAimVariance
          : variance === 'concentration'
            ? settings.magicConcentrationAimVariance
            : 0;
    const aimed = aimOffset(upper, middle, factor, settings, [
      Math.random(),
      Math.random(),
      Math.random(),
      Math.random(),
    ]);
    // Led along the ground: a character controller's vertical speed is its fall's (it builds up
    // while it stands on a slope or a step). TODO(M13): a jumping or flying target's climb.
    const moving = this.#options.velocity(target.reference);
    const velocity: Vec3 = moving ? [moving[0], moving[1], 0] : [0, 0, 0];
    const point = leadPoint(origin, aimed, velocity, shot.speed, shot.gravity, settings);
    return unit([point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]]);
  }
}

function unit(way: Vec3): Vec3 {
  const length = Math.hypot(...way);
  return length > 1e-6 ? [way[0] / length, way[1] / length, way[2] / length] : [0, 1, 0];
}

/** An actor's figure on screen (normalized device coordinates, -1..1), if before the camera. */
function screenBox(
  matrix: Mat4,
  target: AimTarget,
): { minX: number; maxX: number; minY: number; maxY: number } | undefined {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const r = target.radius;
  for (const dz of [0, target.height]) {
    for (const [dx, dy] of [
      [-r, -r],
      [r, -r],
      [-r, r],
      [r, r],
    ] as const) {
      const x = target.feet[0] + dx;
      const y = target.feet[1] + dy;
      const z = target.feet[2] + dz;
      const cx =
        (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0);
      const cy =
        (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0);
      const cw =
        (matrix[3] ?? 0) * x + (matrix[7] ?? 0) * y + (matrix[11] ?? 0) * z + (matrix[15] ?? 0);
      if (cw <= 1e-3) return undefined;
      minX = Math.min(minX, cx / cw);
      maxX = Math.max(maxX, cx / cw);
      minY = Math.min(minY, cy / cw);
      maxY = Math.max(maxY, cy / cw);
    }
  }
  return { minX, maxX, minY, maxY };
}
