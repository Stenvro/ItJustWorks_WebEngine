// Combat groups (docs/ai.md, "Combat detection"): the actors that fight together, allies on the
// same side. An actor that enters combat joins the group of an ally already fighting (one it
// would help: its assistance), else starts one; an actor leaves its group as its combat ends; an
// empty group goes. Observed in the original, the group keeps what its members know of each
// of its targets: the group's detection level of it (the highest of its members'), its stealth
// points, whether it is known (detected) or lost, where and when it was last known, detected,
// attacked from and heard; who of the group attack it. From that it knows when to search (all
// its targets lost) and when to give a target up (lost long enough, or its stealth points full
// again while it searches). Platform-independent.

type Vec3 = readonly [number, number, number];

/** What one member's detection of a target told (src/shell/actor-senses.ts, `tested`). */
export interface DetectionReport {
  /**
   * Its detection level of the target (src/ai/detection.ts): above 0 detected; 0 an event of
   * the target noticed at `event`; −1000 beyond its reach.
   */
  readonly level: number;
  /** It has a line of sight to the target. */
  readonly lineOfSight: boolean;
  /** Where the target is. */
  readonly at: Vec3;
  /** An event's place (a noise, a projectile: level 0). */
  readonly event?: Vec3 | undefined;
}

/** The game settings the groups read (CombatGroup's), with the engine's built-in values. */
export interface CombatGroupSettings {
  /** fCombatStealthPointMax: a new target has one less. */
  readonly stealthPointMax: number;
  /**
   * iCombatStealthPointDetectionThreshold, iCombatStealthPointSneakDetectionThreshold: while a
   * target has stealth points, the group detects it only above this level (sneaking: the other).
   */
  readonly detectionThreshold: number;
  readonly sneakDetectionThreshold: number;
  /** fCombatStealthPointAttackedMaxValue, DetectedEventMaxValue: an attack, an event cap them. */
  readonly attackedMaxValue: number;
  readonly detectedEventMaxValue: number;
  /** fCombatStealthPointRegen*WaitTime: how long after each they come back (seconds). */
  readonly regenAttackedWaitTime: number;
  readonly regenDetectedEventWaitTime: number;
  readonly regenAlertWaitTime: number;
  readonly regenLostWaitTime: number;
  /** fCombatStealthPointDrainMult: they drain by the detection level × this a second. */
  readonly drainMult: number;
  /** fCombatStealthPointRegenMult, RegenMin: they come back by −level × this, at least Min. */
  readonly regenMult: number;
  readonly regenMin: number;
  /**
   * fCombatDetectionNoticedTimeLimit, DistanceLimit: after a detection the group follows the
   * target this long and this far from where it was detected.
   */
  readonly noticedTimeLimit: number;
  readonly noticedDistanceLimit: number;
  /** fCombatDetectionLostTimeLimit: a target not known of this long is lost (seconds). */
  readonly lostTimeLimit: number;
  /**
   * fCombatDetectionLostCheckNoticedDistance: a member this near where the target was last
   * known, seeing the place, finds it gone (lost).
   */
  readonly lostCheckNoticedDistance: number;
  /** fCombatDetectionFleeingLostRemoveTime: a group all fleeing gives up a lost target then. */
  readonly fleeingLostRemoveTime: number;
  /** fCombatDetectionLostRemoveTime: a lost target nobody attacks is given up then. */
  readonly lostRemoveTime: number;
  /**
   * fCombatDetectionLostRemoveDistanceTime, Distance: a lost target someone attacks is given up
   * after the time, unless a member is within the distance of it.
   */
  readonly lostRemoveDistanceTime: number;
  readonly lostRemoveDistance: number;
  /**
   * fCombatDetectionLowDetectionDistance: a member out of the high process detects the targets
   * within this fully (level 100) each update.
   */
  readonly lowDetectionDistance: number;
}

const SETTINGS: readonly (readonly [keyof CombatGroupSettings, string, number])[] = [
  ['stealthPointMax', 'fCombatStealthPointMax', 100],
  ['detectionThreshold', 'iCombatStealthPointDetectionThreshold', 25],
  ['sneakDetectionThreshold', 'iCombatStealthPointSneakDetectionThreshold', 70],
  ['attackedMaxValue', 'fCombatStealthPointAttackedMaxValue', 50],
  ['detectedEventMaxValue', 'fCombatStealthPointDetectedEventMaxValue', 75],
  ['regenAttackedWaitTime', 'fCombatStealthPointRegenAttackedWaitTime', 25],
  ['regenDetectedEventWaitTime', 'fCombatStealthPointRegenDetectedEventWaitTime', 20],
  ['regenAlertWaitTime', 'fCombatStealthPointRegenAlertWaitTime', 10],
  ['regenLostWaitTime', 'fCombatStealthPointRegenLostWaitTime', 10],
  ['drainMult', 'fCombatStealthPointDrainMult', 0.5],
  ['regenMult', 'fCombatStealthPointRegenMult', 0.2],
  ['regenMin', 'fCombatStealthPointRegenMin', 3],
  ['noticedTimeLimit', 'fCombatDetectionNoticedTimeLimit', 10],
  ['noticedDistanceLimit', 'fCombatDetectionNoticedDistanceLimit', 768],
  ['lostTimeLimit', 'fCombatDetectionLostTimeLimit', 10],
  ['lostCheckNoticedDistance', 'fCombatDetectionLostCheckNoticedDistance', 256],
  ['fleeingLostRemoveTime', 'fCombatDetectionFleeingLostRemoveTime', 30],
  ['lostRemoveTime', 'fCombatDetectionLostRemoveTime', 30],
  ['lostRemoveDistanceTime', 'fCombatDetectionLostRemoveDistanceTime', 60],
  ['lostRemoveDistance', 'fCombatDetectionLostRemoveDistance', 4096],
  ['lowDetectionDistance', 'fCombatDetectionLowDetectionDistance', 4096],
];

/** The groups' settings: the load order's values, else the engine's built-in ones. */
export function readCombatGroupSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): CombatGroupSettings {
  return Object.fromEntries(
    SETTINGS.map(([key, name, fallback]) => [key, number(name) ?? fallback]),
  ) as unknown as CombatGroupSettings;
}

export const COMBAT_GROUP_DEFAULTS = readCombatGroupSettings();

/** A level beyond every member's reach (the engine's). */
const NO_LEVEL = -1000;
/** The stealth points move this often (seconds). */
const POINTS_SECONDS = 0.1;
/** The targets are weighed (attackers, low detection, removal) this often (seconds). */
const TARGETS_SECONDS = 1;
/** An event counts again only after this long and this far from the last one (seconds, units). */
const EVENT_SECONDS = 1;
const EVENT_MOVED = 64;
/** Stealth points kept above none while the level is 0 (the engine's). */
const POINTS_AT_ZERO = 0.1;

/** What a group knows of a target. */
export interface GroupTarget {
  readonly reference: number;
  /** The group's detection level of it: the highest of its members' last ones. */
  level: number;
  readonly levels: Map<number, number>;
  stealthPoints: number;
  /** Detected (above the stealth threshold) and followed since. */
  known: boolean;
  /** Lost: not known of for fCombatDetectionLostTimeLimit, or found gone. */
  lost: boolean;
  /** Where and when it was last detected. */
  detectedAt: Vec3 | undefined;
  detectedTime: number;
  /** Where and when the group last knew where it was. */
  lastKnown: Vec3 | undefined;
  lastKnownTime: number;
  /** When it was lost. */
  lostTime: number;
  /** Where and when it last attacked a member. */
  attackedAt: Vec3 | undefined;
  attackedTime: number;
  /** Where and when an event of it was last noticed. */
  eventAt: Vec3 | undefined;
  eventTime: number;
  /** How many members fight it (their combat target). */
  attackers: number;
}

export interface CombatGroup {
  readonly id: number;
  readonly members: Set<number>;
  readonly targets: Map<number, GroupTarget>;
  /** It searches for its targets (all lost). */
  searching: boolean;
  /** When its stealth points and its targets were last updated (seconds). */
  pointsAt: number;
  targetsAt: number;
}

/** What the groups ask of the fight around them. */
export interface CombatGroupWorld {
  /** A member's combat target (undefined: none). */
  combatTarget(member: number): number | undefined;
  /** Whether a member flees. */
  fleeing(member: number): boolean;
  /** Where an actor is (undefined: gone). */
  position(actor: number): Vec3 | undefined;
  /** Whether an actor is alive and present (a target that is not is given up). */
  present(actor: number): boolean;
  /** Whether a member's detection runs (the high process); others detect near targets fully. */
  detects(member: number): boolean;
  /** Whether a target sneaks (the higher stealth threshold). */
  sneaking(target: number): boolean;
  /** Whether a target is invisible. */
  invisible(target: number): boolean;
  /** Whether a member sees a place (its line of sight: the lost check). */
  sees(member: number, at: Vec3): boolean;
}

/** A place kept: a copy (the positions handed in are the actors' own, and they move on). */
const copy = (at: Vec3): Vec3 => [at[0], at[1], at[2]];

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class CombatGroups {
  readonly #groups = new Map<number, CombatGroup>();
  readonly #of = new Map<number, CombatGroup>();
  #next = 1;
  settings: CombatGroupSettings = COMBAT_GROUP_DEFAULTS;

  /**
   * An actor fights: it joins the group of the first in `allies` already in one (those it
   * fights beside), else a new one. Returns its group.
   */
  join(actor: number, allies: Iterable<number>): CombatGroup {
    const own = this.#of.get(actor);
    if (own) return own;
    for (const ally of allies) {
      const group = this.#of.get(ally);
      if (!group) continue;
      group.members.add(actor);
      this.#of.set(actor, group);
      return group;
    }
    const group: CombatGroup = {
      id: this.#next++,
      members: new Set([actor]),
      targets: new Map(),
      searching: false,
      pointsAt: -Infinity,
      targetsAt: -Infinity,
    };
    this.#groups.set(group.id, group);
    this.#of.set(actor, group);
    return group;
  }

  /** An actor's combat ended (or it left the loaded area): it leaves its group. */
  leave(actor: number): void {
    const group = this.#of.get(actor);
    if (!group) return;
    this.#of.delete(actor);
    group.members.delete(actor);
    for (const target of group.targets.values()) target.levels.delete(actor);
    if (group.members.size === 0) this.#groups.delete(group.id);
  }

  /** A target is gone (dead, left): no group fights it any more. */
  forget(target: number): void {
    for (const group of this.#groups.values()) group.targets.delete(target);
  }

  groupOf(actor: number): CombatGroup | undefined {
    return this.#of.get(actor);
  }

  /** The others of an actor's group. */
  *allies(actor: number): Iterable<number> {
    const group = this.#of.get(actor);
    if (!group) return;
    for (const member of group.members) if (member !== actor) yield member;
  }

  /** How many are in an actor's group (GetCombatGroupMemberCount; 0: none). */
  size(actor: number): number {
    return this.#of.get(actor)?.members.size ?? 0;
  }

  /** What an actor's group knows of a target (undefined: not its target). */
  target(actor: number, target: number): GroupTarget | undefined {
    return this.#of.get(actor)?.targets.get(target);
  }

  /** Whether an actor's group searches for its targets. */
  searching(actor: number): boolean {
    return this.#of.get(actor)?.searching === true;
  }

  /**
   * A target for an actor's group (one a member fights): new, with one stealth point less than
   * the most, known nowhere. Returns what the group knows of it.
   */
  addTarget(actor: number, target: number): GroupTarget | undefined {
    const group = this.#of.get(actor);
    if (!group || group.members.has(target)) return undefined;
    let known = group.targets.get(target);
    if (!known) {
      known = {
        reference: target,
        level: NO_LEVEL,
        levels: new Map(),
        stealthPoints: this.settings.stealthPointMax - 1,
        known: false,
        lost: false,
        detectedAt: undefined,
        detectedTime: -Infinity,
        lastKnown: undefined,
        lastKnownTime: -Infinity,
        lostTime: -Infinity,
        attackedAt: undefined,
        attackedTime: -Infinity,
        eventAt: undefined,
        eventTime: -Infinity,
        attackers: 0,
      };
      group.targets.set(target, known);
    }
    return known;
  }

  /**
   * A member's detection of one of its group's targets (each test, each event of it noticed),
   * as the engine updates the group's knowledge (see docs/ai.md, "Combat detection"). `now`:
   * seconds. Returns the target's knowledge, if the group has the target.
   */
  report(
    member: number,
    target: number,
    report: DetectionReport,
    world: CombatGroupWorld,
    now: number,
  ): GroupTarget | undefined {
    const group = this.#of.get(member);
    const known = group?.targets.get(target);
    if (!group || !known) return undefined;
    const settings = this.settings;
    // The group's level: the highest of its members' last ones.
    known.levels.set(member, report.level);
    let level = NO_LEVEL;
    for (const value of known.levels.values()) level = Math.max(level, value);
    known.level = level;
    // Detected: above the stealth threshold while it has stealth points (which then go).
    let detected = level;
    if (level > 0) {
      if (known.stealthPoints > 0) {
        const threshold = world.sneaking(target)
          ? settings.sneakDetectionThreshold
          : settings.detectionThreshold;
        if (level <= threshold) detected = 0;
        else known.stealthPoints = 0;
      }
      if (detected > 0) {
        known.detectedTime = now;
        known.detectedAt = copy(report.at);
        known.known = true;
      }
    }
    // Known: followed while near where and soon after it was detected.
    if (known.known) {
      const away =
        known.detectedAt === undefined ? Infinity : distance(report.at, known.detectedAt);
      if (
        now - known.detectedTime >= settings.noticedTimeLimit ||
        away >= settings.noticedDistanceLimit
      ) {
        known.known = false;
      } else {
        known.lastKnown = copy(report.at);
        known.lastKnownTime = now;
      }
    }
    // Sensed below the stealth threshold: where it is is known, but it is lost (unseen).
    if (level > 0 && detected < 1) {
      if (!known.lost) {
        known.lost = true;
        known.known = false;
        known.lostTime = now;
      }
      known.lastKnown = copy(report.at);
      known.lastKnownTime = now;
    }
    // Found again once known; lost once not known of for fCombatDetectionLostTimeLimit.
    if (known.lost || now - known.lastKnownTime <= settings.lostTimeLimit) {
      if (known.known && known.lost) {
        known.lost = false;
        known.lostTime = -Infinity;
      }
    } else {
      this.#lose(known, now);
    }
    // Undetected: one looking at it finds it gone; one at where it was last known, seeing the
    // place, too.
    if (detected < 0 && !known.lost) {
      if (report.lineOfSight && (!known.known || world.invisible(target))) {
        this.#lose(known, now);
      } else if (!known.known && known.lastKnown) {
        const at = world.position(member);
        if (
          at &&
          distance(at, known.lastKnown) < settings.lostCheckNoticedDistance &&
          world.sees(member, known.lastKnown)
        ) {
          this.#lose(known, now);
        }
      }
    }
    // An event of it (a noise): its stealth points at most fCombatStealthPointDetectedEventMaxValue.
    const event = report.event;
    if (
      report.level === 0 &&
      event &&
      now - known.eventTime > EVENT_SECONDS &&
      (known.eventAt === undefined || distance(known.eventAt, event) > EVENT_MOVED)
    ) {
      known.eventTime = now;
      known.eventAt = copy(event);
      known.stealthPoints = Math.min(known.stealthPoints, settings.detectedEventMaxValue);
    }
    return known;
  }

  #lose(known: GroupTarget, now: number): void {
    known.lost = true;
    known.known = false;
    known.lostTime = now;
  }

  /**
   * A member was attacked by one of its group's targets (from `at`): the target's stealth points
   * at most fCombatStealthPointAttackedMaxValue; the place is searched.
   */
  attacked(member: number, attacker: number, at: Vec3 | undefined, now: number): void {
    const known = this.#of.get(member)?.targets.get(attacker);
    if (!known) return;
    known.attackedTime = now;
    known.attackedAt = at && copy(at);
    known.stealthPoints = Math.min(known.stealthPoints, this.settings.attackedMaxValue);
  }

  /**
   * The groups' own time (seconds): stealth points drain while a target is sensed (by its level
   * × fCombatStealthPointDrainMult a second) and come back once it is lost and nothing
   * happened for the wait times (by −level × fCombatStealthPointRegenMult, at least RegenMin);
   * each second the attackers are counted, the members out of the high process detect the
   * targets near them, and targets are given up; then whether the group searches. Returns the
   * targets given up, by group member.
   */
  update(world: CombatGroupWorld, now: number): { member: number; target: number }[] {
    const given: { member: number; target: number }[] = [];
    for (const group of [...this.#groups.values()]) {
      if (now - group.pointsAt > POINTS_SECONDS) {
        const seconds = group.pointsAt === -Infinity ? POINTS_SECONDS : now - group.pointsAt;
        group.pointsAt = now;
        for (const known of group.targets.values()) this.#points(known, seconds, now);
      }
      if (now - group.targetsAt >= TARGETS_SECONDS) {
        group.targetsAt = now;
        this.#weigh(group, world, now, given);
      }
      this.#search(group, world);
    }
    return given;
  }

  #points(known: GroupTarget, seconds: number, now: number): void {
    const settings = this.settings;
    if (known.level < 0 || known.stealthPoints <= 0) {
      if (!known.lost || known.stealthPoints >= settings.stealthPointMax) return;
      const since = Math.min(now - known.lastKnownTime, now - known.lostTime);
      const wait =
        known.detectedTime === -Infinity ? settings.regenAlertWaitTime : settings.regenLostWaitTime;
      if (
        since > wait &&
        now - known.attackedTime > settings.regenAttackedWaitTime &&
        now - known.eventTime > settings.regenDetectedEventWaitTime
      ) {
        const rate = Math.max(settings.regenMin, -known.level * settings.regenMult);
        known.stealthPoints = Math.min(
          settings.stealthPointMax,
          known.stealthPoints + rate * seconds,
        );
      }
      return;
    }
    const floor = known.level === 0 ? POINTS_AT_ZERO : 0;
    known.stealthPoints = Math.max(
      floor,
      known.stealthPoints - known.level * settings.drainMult * seconds,
    );
  }

  #weigh(
    group: CombatGroup,
    world: CombatGroupWorld,
    now: number,
    given: { member: number; target: number }[],
  ): void {
    const settings = this.settings;
    for (const known of group.targets.values()) {
      known.attackers = 0;
      for (const member of group.members) {
        if (world.combatTarget(member) === known.reference) known.attackers++;
      }
    }
    // Members out of the high process detect the targets near them fully.
    for (const member of group.members) {
      if (world.detects(member)) continue;
      const from = world.position(member);
      if (!from) continue;
      for (const known of group.targets.values()) {
        const at = world.position(known.reference);
        if (!at) continue;
        const level = distance(from, at) < settings.lowDetectionDistance ? 100 : NO_LEVEL;
        this.report(member, known.reference, { level, lineOfSight: level > 0, at }, world, now);
      }
    }
    let fighting = 0;
    let fleeing = 0;
    for (const member of group.members) {
      if (world.fleeing(member)) fleeing++;
      else fighting++;
    }
    for (const known of [...group.targets.values()]) {
      if (!this.#givesUp(group, known, world, now, fighting, fleeing)) continue;
      group.targets.delete(known.reference);
      const member = group.members.values().next().value;
      if (member !== undefined) given.push({ member, target: known.reference });
    }
  }

  /** Whether a group gives a target up (observed in the original). */
  #givesUp(
    group: CombatGroup,
    known: GroupTarget,
    world: CombatGroupWorld,
    now: number,
    fighting: number,
    fleeing: number,
  ): boolean {
    const settings = this.settings;
    if (!world.present(known.reference)) return true;
    if (group.searching && known.stealthPoints >= settings.stealthPointMax) return true;
    if (!known.lost) return false;
    const since = Math.min(now - known.lastKnownTime, now - known.lostTime);
    if (fighting === 0 && fleeing > 0 && since > settings.fleeingLostRemoveTime) return true;
    if (since <= settings.lostRemoveTime) return false;
    if (known.attackers === 0) return true;
    if (since <= settings.lostRemoveDistanceTime) return false;
    const at = world.position(known.reference);
    if (!at) return true;
    for (const member of group.members) {
      const from = world.position(member);
      if (from && distance(from, at) < settings.lostRemoveDistance) return false;
    }
    return true;
  }

  /**
   * A group searches once all its targets are lost and one of them has attackers, unless its
   * members all flee; it stops once one is found again (or all flee, or none is left).
   */
  #search(group: CombatGroup, world: CombatGroupWorld): void {
    const targets = [...group.targets.values()];
    let fleeing = 0;
    for (const member of group.members) if (world.fleeing(member)) fleeing++;
    const allFlee = targets.length === 0 || group.members.size <= fleeing;
    if (!group.searching) {
      if (allFlee) return;
      const attacked = targets.some((known) => known.attackers > 0);
      if (attacked && targets.every((known) => known.lost)) group.searching = true;
      return;
    }
    if (allFlee || targets.some((known) => !known.lost)) group.searching = false;
  }

  *groups(): Iterable<CombatGroup> {
    yield* this.#groups.values();
  }

  clear(): void {
    this.#groups.clear();
    this.#of.clear();
  }
}
