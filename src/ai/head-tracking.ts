// Where actors look (docs/animation.md, "Head tracking"): the engine keeps per actor a head
// track target of each kind (CommonLibSSE HighProcessData::HEAD_TRACK_TYPE: default, action,
// script, combat, dialogue, procedure); the highest kind set is the one looked at. Scripts set
// theirs (Actor.SetLookAt, ClearLookAt), dialogue its partner, AI and combat theirs; without
// any, an actor looks at the player near it and in front of it. The point it looks at moves
// towards the target at the head tracking speed (fHeadTrackSpeed*), now and then off it by a
// random offset (fAIHeadTrack*); the graph's BSLookAtModifier turns the head and eyes to it
// (src/animation/procedural.ts). Platform-independent.

export type Vec3 = readonly [number, number, number];

/** HighProcessData::HEAD_TRACK_TYPE, lowest first (CommonLibSSE). */
export const HEAD_TRACK_KINDS = [
  'default',
  'action',
  'script',
  'combat',
  'dialogue',
  'procedure',
] as const;

export type HeadTrackKind = (typeof HEAD_TRACK_KINDS)[number];

/** What an actor looks at: a reference (an actor's head, an object) or a world point. */
export type LookTarget = number | Vec3;

/**
 * Who each actor is asked to look at, by kind, and whether its head tracking is on: kept by
 * the session (scripts, AI, dialogue and combat ask; the actors' views read it every frame).
 */
export class LookRequests {
  readonly #targets = new Map<number, Map<HeadTrackKind, LookTarget>>();
  readonly #off = new Set<number>();

  /**
   * An actor looks at a target (undefined: stops looking at what this kind asked). Kinds:
   * 'script' (SetLookAt), 'dialogue' (who it talks to), 'combat' (its target), 'action',
   * 'procedure' (a package's), 'default' (the engine's own choice).
   */
  lookAt(actor: number, target: LookTarget | undefined, kind: HeadTrackKind = 'action'): void {
    let kinds = this.#targets.get(actor);
    if (target === undefined) {
      kinds?.delete(kind);
      if (kinds?.size === 0) this.#targets.delete(actor);
      return;
    }
    if (!kinds) {
      kinds = new Map();
      this.#targets.set(actor, kinds);
    }
    kinds.set(kind, typeof target === 'number' ? target : [target[0], target[1], target[2]]);
  }

  /**
   * What an actor is asked to look at: the highest kind set (TODO(M13): the engine's order of
   * the kinds is not documented; the enum's, highest last, reads as the priority).
   */
  target(actor: number): { readonly target: LookTarget; readonly kind: HeadTrackKind } | undefined {
    const kinds = this.#targets.get(actor);
    if (!kinds) return undefined;
    for (let i = HEAD_TRACK_KINDS.length - 1; i >= 0; i--) {
      const kind = HEAD_TRACK_KINDS[i];
      const target = kind && kinds.get(kind);
      if (kind && target !== undefined) return { target, kind };
    }
    return undefined;
  }

  /** Actor.SetHeadTracking: whether the actor head-tracks at all (on unless turned off). */
  setHeadTracking(actor: number, on: boolean): void {
    if (on) this.#off.delete(actor);
    else this.#off.add(actor);
  }

  headTracking(actor: number): boolean {
    return !this.#off.has(actor);
  }
}

/** The game settings head tracking reads (Skyrim.esm's values: VANILLA_HEAD_TRACK). */
export interface HeadTrackSettings {
  /** The look moves this fast (degrees a second) while more than fHeadTrackSpeedMaxAngle off. */
  readonly fHeadTrackSpeedMax: number;
  readonly fHeadTrackSpeedMaxAngle: number;
  /** ... and this fast within fHeadTrackSpeedMinAngle; between, in proportion. */
  readonly fHeadTrackSpeedMin: number;
  readonly fHeadTrackSpeedMinAngle: number;
  /** A random offset (game units) off the target, picked every so often and held a while. */
  readonly fAIHeadTrackOffsetRandomValueMin: number;
  readonly fAIHeadTrackOffsetRandomValueMax: number;
  readonly fAIHeadTrackPickNewOffsetTimer: number;
  readonly fAIHeadTrackStayInOffsetMin: number;
  readonly fAIHeadTrackStayInOffsetMax: number;
  readonly fAIHeadTrackResetPositionTimer: number;
  /** The same in dialogue. */
  readonly fAIHeadTrackDialogueOffsetRandomValue: number;
  readonly fAIHeadTrackDialoguePickNewOffsetTimer: number;
  readonly fAIHeadTrackDialogueStayInOffsetMin: number;
  readonly fAIHeadTrackDialogueStayInOffsetMax: number;
  readonly fAIHeadTrackDialogueResetPositionTimer: number;
}

export const VANILLA_HEAD_TRACK: HeadTrackSettings = {
  fHeadTrackSpeedMax: 200,
  fHeadTrackSpeedMaxAngle: 10,
  fHeadTrackSpeedMin: 60,
  fHeadTrackSpeedMinAngle: 5,
  fAIHeadTrackOffsetRandomValueMin: 0,
  fAIHeadTrackOffsetRandomValueMax: 0,
  fAIHeadTrackPickNewOffsetTimer: 2,
  fAIHeadTrackStayInOffsetMin: 1,
  fAIHeadTrackStayInOffsetMax: 2,
  fAIHeadTrackResetPositionTimer: 4,
  fAIHeadTrackDialogueOffsetRandomValue: 0,
  fAIHeadTrackDialoguePickNewOffsetTimer: 2,
  fAIHeadTrackDialogueStayInOffsetMin: 1,
  fAIHeadTrackDialogueStayInOffsetMax: 2,
  fAIHeadTrackDialogueResetPositionTimer: 4,
};

/** The setting names of HeadTrackSettings (read from the game settings). */
export const HEAD_TRACK_SETTINGS = Object.keys(VANILLA_HEAD_TRACK) as (keyof HeadTrackSettings)[];

/** How far off its facing an actor may choose another actor to look at (120°). */
const LOOK_CHOICE_ANGLE = (2 * Math.PI) / 3;

/**
 * Whether an actor (its head, facing `heading`: compass, radians) takes the player's eye as
 * its default head track target: as any other actor it may look at (observed in the
 * original), within fAIMaxHeadTrackDistance (`maxDistance`, game units, head to head) and 120° of
 * its facing. Only once it has detected them (src/shell/actor-looks.ts).
 */
export function noticesPlayer(
  head: Vec3,
  heading: number,
  eye: Vec3,
  maxDistance: number,
): boolean {
  return chooseLookActor(head, heading, [{ reference: 0, head: eye }], maxDistance) === 0;
}

/** Another actor's head, as an actor choosing whom to look at sees it. */
export interface LookCandidate {
  readonly reference: number;
  readonly head: Vec3;
}

/**
 * Whom an actor without a target of its own looks at among the other actors (observed in the
 * original): one within fAIMaxHeadTrackDistance of it (game units) and within 120° of
 * its facing (`heading`: compass, radians), the best one. TODO(M13): the engine scores the
 * candidates by a rule not read yet; here the nearest is the best.
 */
export function chooseLookActor(
  head: Vec3,
  heading: number,
  candidates: Iterable<LookCandidate>,
  maxDistance: number,
): number | undefined {
  let best: number | undefined;
  let bestDistance = Infinity;
  const facing = [Math.sin(heading), Math.cos(heading)] as const;
  for (const candidate of candidates) {
    const dx = candidate.head[0] - head[0];
    const dy = candidate.head[1] - head[1];
    const dz = candidate.head[2] - head[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance > maxDistance || distance >= bestDistance) continue;
    const horizontal = Math.hypot(dx, dy);
    if (horizontal > 1e-3) {
      const cosine = (dx * facing[0] + dy * facing[1]) / horizontal;
      if (cosine < Math.cos(LOOK_CHOICE_ANGLE)) continue;
    }
    best = candidate.reference;
    bestDistance = distance;
  }
  return best;
}

/**
 * One actor's look: the point its look-at aims at, moving towards where the target is at the
 * head tracking speed (an angle about the head), with the random offsets.
 */
export class HeadTracker {
  readonly #random: () => number;
  /** The way it looks now (unit, from its head), undefined while it looks at nothing. */
  #direction: [number, number, number] | undefined;
  #distance = 0;
  /** The random offset now, and the seconds until it changes. */
  #offset: [number, number, number] = [0, 0, 0];
  #offsetTimer = 0;
  #holding = false;

  constructor(random: () => number) {
    this.#random = random;
  }

  /**
   * Advances `dt` seconds: where its look-at should aim (a world point), or undefined if it
   * looks at nothing. `head` is where its head is, `forward` the way it faces (unit);
   * `target` where it is asked to look; `dialogue`: the dialogue's offsets.
   */
  update(
    dt: number,
    head: Vec3,
    forward: Vec3,
    target: Vec3 | undefined,
    settings: HeadTrackSettings,
    dialogue: boolean,
  ): Vec3 | undefined {
    if (!target) {
      this.#direction = undefined;
      this.#offset = [0, 0, 0];
      this.#holding = false;
      return undefined;
    }
    const aim = this.#offsetTarget(dt, target, settings, dialogue);
    const wanted = [aim[0] - head[0], aim[1] - head[1], aim[2] - head[2]] as const;
    const distance = Math.hypot(wanted[0], wanted[1], wanted[2]);
    if (distance < 1e-3) return aim;
    const to: [number, number, number] = [
      wanted[0] / distance,
      wanted[1] / distance,
      wanted[2] / distance,
    ];
    // A new look starts from where the actor faces.
    const from = this.#direction ?? [forward[0], forward[1], forward[2]];
    if (!this.#direction) this.#distance = distance;
    const angle = Math.acos(
      Math.min(1, Math.max(-1, from[0] * to[0] + from[1] * to[1] + from[2] * to[2])),
    );
    const degrees = (angle * 180) / Math.PI;
    const {
      fHeadTrackSpeedMax: fast,
      fHeadTrackSpeedMaxAngle: far,
      fHeadTrackSpeedMin: slow,
      fHeadTrackSpeedMinAngle: near,
    } = settings;
    const share = far > near ? Math.min(1, Math.max(0, (degrees - near) / (far - near))) : 1;
    const speed = ((slow + (fast - slow) * share) * Math.PI) / 180;
    const step = speed * dt;
    let direction: [number, number, number];
    if (angle <= step || angle < 1e-6) {
      direction = to;
    } else {
      // Turned towards it by the step (slerp along the great circle).
      const t = step / angle;
      const sin = Math.sin(angle);
      const a = Math.sin((1 - t) * angle) / sin;
      const b = Math.sin(t * angle) / sin;
      direction = [from[0] * a + to[0] * b, from[1] * a + to[1] * b, from[2] * a + to[2] * b];
    }
    this.#direction = direction;
    // Its distance follows in proportion.
    this.#distance += (distance - this.#distance) * Math.min(1, dt * 10);
    return [
      head[0] + direction[0] * this.#distance,
      head[1] + direction[1] * this.#distance,
      head[2] + direction[2] * this.#distance,
    ];
  }

  /**
   * The target with its random offset: every PickNewOffsetTimer seconds an offset of
   * OffsetRandomValueMin..Max units in a random direction, held StayInOffsetMin..Max seconds
   * (at most ResetPositionTimer), then back on the target. Skyrim.esm's values are 0: on it.
   * TODO(M13): the engine's use of these timers is not documented.
   */
  #offsetTarget(dt: number, target: Vec3, settings: HeadTrackSettings, dialogue: boolean): Vec3 {
    const min = dialogue ? 0 : settings.fAIHeadTrackOffsetRandomValueMin;
    const max = dialogue
      ? settings.fAIHeadTrackDialogueOffsetRandomValue
      : settings.fAIHeadTrackOffsetRandomValueMax;
    if (max <= 0 && min <= 0) return target;
    this.#offsetTimer -= dt;
    if (this.#offsetTimer <= 0) {
      if (this.#holding) {
        this.#offset = [0, 0, 0];
        this.#holding = false;
        this.#offsetTimer = dialogue
          ? settings.fAIHeadTrackDialoguePickNewOffsetTimer
          : settings.fAIHeadTrackPickNewOffsetTimer;
      } else {
        const size = min + (max - min) * this.#random();
        const yaw = this.#random() * Math.PI * 2;
        const pitch = (this.#random() - 0.5) * Math.PI;
        this.#offset = [
          Math.cos(pitch) * Math.sin(yaw) * size,
          Math.cos(pitch) * Math.cos(yaw) * size,
          Math.sin(pitch) * size,
        ];
        this.#holding = true;
        const stayMin = dialogue
          ? settings.fAIHeadTrackDialogueStayInOffsetMin
          : settings.fAIHeadTrackStayInOffsetMin;
        const stayMax = dialogue
          ? settings.fAIHeadTrackDialogueStayInOffsetMax
          : settings.fAIHeadTrackStayInOffsetMax;
        const reset = dialogue
          ? settings.fAIHeadTrackDialogueResetPositionTimer
          : settings.fAIHeadTrackResetPositionTimer;
        this.#offsetTimer = Math.min(reset, stayMin + (stayMax - stayMin) * this.#random());
      }
    }
    return [target[0] + this.#offset[0], target[1] + this.#offset[1], target[2] + this.#offset[2]];
  }
}
