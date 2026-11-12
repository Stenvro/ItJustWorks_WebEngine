// Attack data (docs/ai.md, "Combat"): an attack is the graph event the idle tree gives an
// action (ActionRightAttack → attackStart, ActionRightPowerAttack → attackPowerStartInPlace,
// ...); its data is the ATKD whose ATKE names that event: the actor's own (NPC_ ATKD, each
// overriding its race's for its event; UESP NPC_), else its race's, the race that ATKR names
// instead of its own where it has one. Platform-independent.

import { AttackFlag, type AttackData } from '../../ai/race-combat-records.ts';

/** The attack data an actor fights with: its own over its (attack) race's, by event. */
export class AttackSet {
  readonly #byEvent = new Map<string, AttackData>();

  constructor(race: readonly AttackData[], own: readonly AttackData[] = []) {
    for (const attack of race) this.#byEvent.set(attack.event.toLowerCase(), attack);
    for (const attack of own) this.#byEvent.set(attack.event.toLowerCase(), attack);
  }

  /** The data of the attack an event starts, if it is an attack's. */
  of(event: string): AttackData | undefined {
    return this.#byEvent.get(event.toLowerCase());
  }

  get size(): number {
    return this.#byEvent.size;
  }

  /** Every attack (development checks). */
  all(): Iterable<AttackData> {
    return this.#byEvent.values();
  }
}

/** What an attack event is (from its data, else from its name). */
export interface AttackEventKind {
  readonly power: boolean;
  readonly bash: boolean;
  readonly left: boolean;
}

/**
 * Whether an attack turns its attacker to its target while it plays: ATKD Rotating Attack (38
 * attacks: the bears', sabre cats', mammoths', mudcrabs', chaurus' and dwarven spiders' side
 * and spin attacks). Its controller keeps turning it through the attack, as the graph's
 * bAllowRotation lets it (src/ai/movement-drive.ts); any other attack plays as its clip faces.
 * TODO(M13): the plain reading of the flag's name; the engine's turn rate through it is the
 * race's.
 */
export function rotatesThrough(data: AttackData): boolean {
  return (data.flags & AttackFlag.rotatingAttack) !== 0;
}

/**
 * Whether an event starts an attack, and what kind: by its attack data's flags (power, bash,
 * left hand); events without data by their name (bowAttackStart, pa_ killmoves, the
 * creatures' attackStart_* and combatStanceStart).
 */
export function attackEventKind(
  event: string,
  data: AttackData | undefined,
): AttackEventKind | undefined {
  if (data) {
    return {
      power: (data.flags & AttackFlag.powerAttack) !== 0,
      bash: (data.flags & AttackFlag.bashAttack) !== 0,
      left: (data.flags & AttackFlag.leftAttack) !== 0,
    };
  }
  const name = event.toLowerCase();
  if (name.startsWith('pa_')) return { power: true, bash: false, left: false };
  if (name.includes('bash')) return { power: name.includes('power'), bash: true, left: false };
  if (name.includes('attack') || name === 'combatstancestart') {
    return { power: name.includes('power'), bash: false, left: name.includes('left') };
  }
  return undefined;
}

/** An attack data's damage, stagger and strike as an attack without data has them. */
export const DEFAULT_ATTACK: AttackData = {
  event: '',
  damageMult: 1,
  attackChance: 1,
  spell: undefined,
  flags: 0,
  attackAngle: 0,
  strikeAngle: 35,
  stagger: 0,
  attackType: undefined,
  knockdown: 0,
  recoveryTime: 0,
  staminaMult: 1,
};

/**
 * The attack data of a killmove (pa_...) or another event without its own: a power attack, its
 * damage 1 + fPowerAttackDefaultBonus times (2).
 */
export function powerAttackDefault(defaultBonus: number): AttackData {
  return {
    ...DEFAULT_ATTACK,
    damageMult: 1 + defaultBonus,
    flags: AttackFlag.powerAttack,
    stagger: 1,
  };
}

/** What the engine weighs an attack data by as it picks one (chooseAttackData). */
export interface AttackChoiceContext {
  /** The target is staggered or in a large recoil. */
  readonly targetStaggered: boolean;
  /** The target blocks, facing the attacker (within its hit cone). */
  readonly targetBlockingFacing: boolean;
  /** The target is dead (a corpse's strike cone is wider). */
  readonly targetDead: boolean;
  /** The target's bearing from the attacker's facing (radians, clockwise). */
  readonly bearing: number;
  /** The combat style's melee mults (CSTY CSME). */
  readonly attackStaggeredMult: number;
  readonly powerAttackStaggeredMult: number;
  readonly powerAttackBlockingMult: number;
  /** fCombatAttackStrikeAngleMult (0.67) and fCombatDeadActorHitConeMult (2). */
  readonly strikeAngleMult: number;
  readonly deadConeMult: number;
  /** Whether an attack is still recovering from its last use (its recovery time). */
  readonly recovering: (attack: AttackData) => boolean;
  /** Whether its target is in reach of this attack (attackReaches); none: not asked. */
  readonly reaches?: (attack: AttackData) => boolean;
}

/**
 * The engine's pick among an actor's attack data for a melee attack (observed in the
 * original; in our words): every attack of the kind asked whose recovery time since its last use
 * has passed is weighed by its attack chance, times the style's attack staggered mult (its
 * power attack staggered mult for a power attack) when the target is staggered or recoiling,
 * times its power attack blocking mult for a power attack on a target that blocks facing the
 * attacker. One is picked by weight and taken with its weight as the chance; then the target
 * must lie within its strike angle times fCombatAttackStrikeAngleMult about the attacker's
 * facing turned by its attack angle (twice that for a dead target). One that fails either is
 * dropped and the pick is made again among the rest. Undefined: none.
 */
export function chooseAttackData(
  attacks: readonly AttackData[],
  context: AttackChoiceContext,
  random: () => number = Math.random,
): AttackData | undefined {
  const weighed = attacks
    .filter((attack) => !context.recovering(attack))
    .map((attack) => {
      const power = (attack.flags & AttackFlag.powerAttack) !== 0;
      let weight = attack.attackChance;
      if (context.targetStaggered) {
        weight *= power ? context.powerAttackStaggeredMult : context.attackStaggeredMult;
      } else if (power && context.targetBlockingFacing) {
        weight *= context.powerAttackBlockingMult;
      }
      return { attack, weight };
    })
    .filter((entry) => entry.weight > 0);
  while (weighed.length > 0) {
    const total = weighed.reduce((sum, entry) => sum + entry.weight, 0);
    let pick = random() * total;
    let index = weighed.length - 1;
    for (let i = 0; i < weighed.length; i++) {
      pick -= weighed[i]?.weight ?? 0;
      if (pick < 0) {
        index = i;
        break;
      }
    }
    const entry = weighed[index];
    if (!entry) return undefined;
    weighed.splice(index, 1);
    if (random() >= entry.weight) continue;
    const cone =
      entry.attack.strikeAngle *
      context.strikeAngleMult *
      (context.targetDead ? context.deadConeMult : 1);
    const off = Math.abs(angleBetween(context.bearing, (entry.attack.attackAngle * Math.PI) / 180));
    if ((off * 180) / Math.PI > cone) continue;
    if (context.reaches && !context.reaches(entry.attack)) continue;
    return entry.attack;
  }
  return undefined;
}

/** An actor's feet and its velocity (units a second) as an attack's reach is reckoned. */
export interface AttackBody {
  readonly feet: readonly [number, number, number];
  readonly velocity: readonly [number, number];
}

/** What an attack's reach is reckoned from besides the two actors. */
export interface AttackReachContext {
  readonly attacker: AttackBody;
  /** The attacker's facing (compass, radians). */
  readonly heading: number;
  readonly target: AttackBody;
  /** The target is the player and does not go away from the attacker: its motion counts less. */
  readonly targetHeld: boolean;
  /**
   * Its weapon's reach from its centre, and the extents the reach is measured to: its target's
   * (its controller's radius), as a strike reaches from the attacker's centre to the target's
   * shape (hit-test.ts). TODO(M13): the original measures between the two actors' bounds; ours
   * leaves the attacker's own out here as in the strike (a dragon's bite reaches from its
   * centre).
   */
  readonly reach: number;
  readonly extents: number;
  /** How far its way is clear towards a point its clip takes it to (none: not asked). */
  readonly clearTo?: (point: readonly [number, number, number]) => number;
  readonly settings: {
    readonly attackStationaryAttackDistance: number;
    readonly attackMovingAttackDistance: number;
    readonly attackMovingAttackReachMult: number;
    readonly attackMovingStrikeAngleMult: number;
    readonly attackAllowedOverrunDistance: number;
    readonly attackPlayerAnticipateMult: number;
  };
}

/**
 * Whether an attack's target will be in its reach at its hit frame (observed in the original; the
 * melee attack node's check, in our words). Its clip's move by then, or for a flagged attack
 * (attackStart) its own speed by then, is its lunge: the target must first lie within the lunge,
 * its reach, the extents (the context's: its target's, as ours measures a strike) and how far
 * the target goes by then. Then where the attacker will be
 * (a lunge of more than fCombatAttackStationaryAttackDistance: its clip's offset turned by its
 * facing, its way clear for one past fCombatAttackMovingAttackDistance, short of its end by the
 * allowed overrun; flagged: its velocity on) against where the target will be (the player, unless
 * going away from it: fCombatAttackPlayerAnticipateMult of that), its reach ×
 * fCombatAttackMovingAttackReachMult if it moved past fCombatAttackMovingAttackDistance, plus the
 * extents. One moving that far must also have its target within the strike angle ×
 * fCombatAttackMovingStrikeAngleMult from there. So a forward power attack, whose clip goes
 * hundreds of units, is an attack from afar and no attack at arm's length.
 * TODO(M13): the inferred curve of the way that must be clear below twice the overrun.
 */
export function attackReaches(
  attack: AttackData,
  hit: {
    readonly hitTime: number;
    readonly motion: readonly [number, number, number] | undefined;
  },
  context: AttackReachContext,
): boolean {
  const { attacker, target, settings } = context;
  const time = hit.hitTime;
  const lunge = hit.motion
    ? Math.hypot(hit.motion[0], hit.motion[1], hit.motion[2])
    : Math.hypot(attacker.velocity[0], attacker.velocity[1]) * time;
  const targetGoes = Math.hypot(target.velocity[0], target.velocity[1]) * time;
  const apart = flatDistance(attacker.feet, target.feet);
  if (apart > lunge + context.reach + context.extents + targetGoes) return false;
  let at: readonly [number, number, number] = attacker.feet;
  if (hit.motion) {
    if (lunge > settings.attackStationaryAttackDistance) {
      const sin = Math.sin(context.heading);
      const cos = Math.cos(context.heading);
      at = [
        attacker.feet[0] + hit.motion[0] * cos + hit.motion[1] * sin,
        attacker.feet[1] - hit.motion[0] * sin + hit.motion[1] * cos,
        attacker.feet[2] + hit.motion[2],
      ];
      if (lunge > settings.attackMovingAttackDistance && context.clearTo) {
        const overrun = settings.attackAllowedOverrunDistance;
        const least = settings.attackMovingAttackDistance;
        const wanted =
          lunge > overrun * 2
            ? lunge - overrun
            : least + ((lunge - least) * (overrun - least)) / (overrun * 2 - least);
        if (context.clearTo(at) < wanted) return false;
      }
    }
  } else {
    at = [
      attacker.feet[0] + attacker.velocity[0] * time,
      attacker.feet[1] + attacker.velocity[1] * time,
      attacker.feet[2],
    ];
  }
  const ahead = context.targetHeld ? time * settings.attackPlayerAnticipateMult : time;
  const there: readonly [number, number, number] = [
    target.feet[0] + target.velocity[0] * ahead,
    target.feet[1] + target.velocity[1] * ahead,
    target.feet[2],
  ];
  const moves = flatDistance(at, attacker.feet) > settings.attackMovingAttackDistance;
  const limit =
    (moves ? settings.attackMovingAttackReachMult : 1) * context.reach + context.extents;
  if (flatDistance(at, there) > limit) return false;
  if (!moves) return true;
  const bearing = angleBetween(context.heading, Math.atan2(there[0] - at[0], there[1] - at[1]));
  const off = Math.abs(angleBetween(bearing, (attack.attackAngle * Math.PI) / 180));
  return (off * 180) / Math.PI <= attack.strikeAngle * settings.attackMovingStrikeAngleMult;
}

function flatDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));
}

/** The signed angle from a to b (radians, within ±π). */
function angleBetween(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
