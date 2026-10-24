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

/** The attack data of a killmove (pa_...) or another event without its own: a power attack. */
export const POWER_ATTACK_DEFAULT: AttackData = {
  ...DEFAULT_ATTACK,
  damageMult: 2,
  flags: AttackFlag.powerAttack,
  stagger: 1,
};

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
    return entry.attack;
  }
  return undefined;
}

/** The signed angle from a to b (radians, within ±π). */
function angleBetween(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
