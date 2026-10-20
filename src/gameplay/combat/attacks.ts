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
