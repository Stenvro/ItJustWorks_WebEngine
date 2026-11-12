// Which actors a melee strike reaches at its hit frame (docs/ai.md, "Combat"): those within the
// attacker's reach and inside the attack's strike angle, measured on the ground (heights only
// have to overlap). The reach is fCombatDistance × the weapon's reach (fCombatBashReach for a
// bash; the race's unarmed reach for fists) × the attacker's size; the strike is the cone of the
// attack data's strike angle about its attack angle (ATKD: 50° for attackStart, 35° for power
// attacks, 85° about ±90° for mounted side swings). An attacker with a combat target hits that
// one alone; one without, the actor nearest its strike's direction (strikeTargets; the others in
// a wider cone too with Sweep: the perk system's hook). Blocks cover fCombatHitConeAngle in front
// of the blocker. TODO(M13): the engine measures reach from its bounds and its cone's exact shape is not
// documented; here from the attacker's feet to the target's shape (its controller's radius).
// Platform-independent.

/** A compass heading (radians: 0 along +Y, π/2 along +X) from one point to another. */
export function headingTo(from: readonly number[], to: readonly number[]): number {
  return Math.atan2((to[0] ?? 0) - (from[0] ?? 0), (to[1] ?? 0) - (from[1] ?? 0));
}

/** The angle from heading `a` to heading `b`, −π..π (positive: clockwise, to the right). */
export function turnBetween(a: number, b: number): number {
  const delta = b - a;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

const DEGREES = Math.PI / 180;

/** What reaches how far: the weapon's reach (fists: the race's), times the attacker's size. */
export function meleeReach(
  attack: {
    /** The weapon's reach (WEAP DNAM); undefined: fists. */
    readonly weaponReach: number | undefined;
    readonly bash: boolean;
    /** The race's unarmed reach (RACE DATA). */
    readonly unarmedReach: number;
    /** The attacker's size (its race's height × its own scale). */
    readonly scale: number;
  },
  settings: { readonly combatDistance: number; readonly combatBashReach: number },
): number {
  const base = attack.bash
    ? settings.combatBashReach
    : attack.weaponReach === undefined
      ? attack.unarmedReach
      : settings.combatDistance * attack.weaponReach;
  return base * attack.scale;
}

/** A strike at its hit frame. */
export interface Strike {
  /** The attacker's feet and facing (compass heading). */
  readonly origin: readonly [number, number, number];
  readonly heading: number;
  /** The attacker's height (its strike reaches from its feet to its head and the reach above). */
  readonly height: number;
  readonly reach: number;
  /** ATKD: degrees off the facing the strike goes (90: to the right) and its half-width. */
  readonly attackAngle: number;
  readonly strikeAngle: number;
}

/** An actor a strike may hit. */
export interface StrikeTarget {
  readonly reference: number;
  readonly feet: readonly [number, number, number];
  /** Its shape's radius and height (its character controller's). */
  readonly radius: number;
  readonly height: number;
}

/** Where a strike meets a target: how far (to its shape), at what angle off the strike. */
export interface StrikeContact {
  readonly target: StrikeTarget;
  readonly distance: number;
  /** Radians off the strike's direction. */
  readonly angle: number;
}

/** Whether a strike reaches a target, and where (undefined: it does not). */
export function strikeContact(strike: Strike, target: StrikeTarget): StrikeContact | undefined {
  const dx = target.feet[0] - strike.origin[0];
  const dy = target.feet[1] - strike.origin[1];
  const centre = Math.hypot(dx, dy);
  const distance = Math.max(0, centre - target.radius);
  if (distance > strike.reach) return undefined;
  // The heights overlap: its feet below the attacker's head and the reach above it.
  const bottom = target.feet[2];
  const top = target.feet[2] + target.height;
  if (bottom > strike.origin[2] + strike.height + strike.reach / 2) return undefined;
  if (top < strike.origin[2] - strike.reach / 2) return undefined;
  // Close enough to be inside its own shape: any angle.
  if (centre <= target.radius) return { target, distance: 0, angle: 0 };
  const direction = strike.heading + strike.attackAngle * DEGREES;
  const off = Math.abs(turnBetween(direction, Math.atan2(dx, dy)));
  // The target's width widens the cone: its edge may be inside while its centre is not.
  const widen = Math.asin(Math.min(1, target.radius / centre));
  if (off - widen > strike.strikeAngle * DEGREES) return undefined;
  return { target, distance, angle: off };
}

/**
 * The targets a strike hits (observed in the original). An attacker with a combat target
 * (`combatTarget`: an NPC in a fight) hits that one alone, where its strike reaches it: a swing
 * that misses its target falls on no one else, friend or foe, however near they stand. One
 * without a combat target (the player, whose aim is none; an actor swinging outside a fight)
 * hits, of those its strike reaches, the one nearest the strike's direction. With the Sweep perk
 * (`sweep`: fMeleeSweepViewAngleMult) every other actor within reach and inside the strike angle
 * times that is hit as well, whether or not the strike found its own target. Those it is told to
 * leave out (the attacker, the dead, its mount) are not offered.
 */
export function strikeTargets(
  strike: Strike,
  targets: Iterable<StrikeTarget>,
  sweep?: number,
  combatTarget?: number,
): StrikeContact[] {
  const offered = [...targets];
  const reached: StrikeContact[] = [];
  for (const target of offered) {
    if (combatTarget !== undefined && target.reference !== combatTarget) continue;
    const contact = strikeContact(strike, target);
    if (contact) reached.push(contact);
  }
  reached.sort((a, b) => a.angle - b.angle || a.distance - b.distance);
  const contacts = reached.slice(0, 1);
  if (sweep === undefined) return contacts;
  const wide: Strike = { ...strike, strikeAngle: strike.strikeAngle * sweep };
  const swept: StrikeContact[] = [];
  for (const target of offered) {
    if (target === contacts[0]?.target) continue;
    const contact = strikeContact(wide, target);
    if (contact) swept.push(contact);
  }
  swept.sort((a, b) => a.distance - b.distance || a.angle - b.angle);
  return [...contacts, ...swept];
}

/**
 * Whether a blocker facing `heading` covers a hit from `from` (fCombatHitConeAngle in degrees
 * either side of its facing; TODO(M13): whether the setting is the half or the whole cone).
 */
export function blockCovers(
  blocker: readonly [number, number, number],
  heading: number,
  from: readonly number[],
  coneDegrees: number,
): boolean {
  const to = headingTo(blocker, from);
  return Math.abs(turnBetween(heading, to)) <= coneDegrees * DEGREES;
}

/**
 * Where a hit comes from as the graphs read it (staggerDirection, the hit's direction): where
 * the attacker is, clockwise from the target's facing, in turns: 0 in front, 0.25 right, 0.5
 * behind, 0.75 left (the stagger blend plays StaggerBack at 0, StaggerForward at 0.5).
 */
export function hitDirection(
  target: readonly number[],
  heading: number,
  from: readonly number[],
): number {
  const turn = turnBetween(heading, headingTo(target, from)) / (2 * Math.PI);
  return turn < 0 ? turn + 1 : turn;
}
