// What a water type does to the actors in it (WATR, docs/gameplay.md, "Water damage"): a type
// flagged Causes Damage takes its damage per second (DATA) of their health while they are in
// it, and its spell (XNAM) is put on them as they come in, and again each SPELL_INTERVAL while
// they stay. No vanilla type has damage per second or a spell (Apocrypha's set the flag alone;
// its water is dangerous through IsInDangerousWater). Platform-independent.
// TODO(M13): how often the engine puts the spell on again is not documented.

/** A water type's harm (src/world/water.ts, WaterBody). */
export interface WaterHarm {
  readonly causesDamage: boolean;
  readonly damagePerSecond: number;
  readonly spell: number | undefined;
}

/** Seconds between a water spell's applications on one actor. */
export const SPELL_INTERVAL = 1;

/** What a step in water does to an actor. */
export interface WaterHarmStep {
  /** Health it takes. */
  readonly damage: number;
  /** The spell to put on it now, if any. */
  readonly spell: number | undefined;
}

const NONE: WaterHarmStep = { damage: 0, spell: undefined };

/** One actor's time in harmful water. */
export class WaterHazard {
  #type: number | undefined;
  #sinceSpell = 0;

  /**
   * `seconds` pass with the actor at a submersion in water of a type (`harm`: the type's, if
   * any harm). Out of the water (submersion 0) nothing happens and the next entry is new.
   */
  step(
    type: number | undefined,
    harm: WaterHarm | undefined,
    submersion: number,
    seconds: number,
  ): WaterHarmStep {
    if (type === undefined || submersion <= 0) {
      this.#type = undefined;
      return NONE;
    }
    const entered = this.#type !== type;
    this.#type = type;
    if (!harm) return NONE;
    const damage = harm.causesDamage ? harm.damagePerSecond * seconds : 0;
    let spell: number | undefined;
    if (harm.spell !== undefined) {
      this.#sinceSpell = entered ? SPELL_INTERVAL : this.#sinceSpell + seconds;
      if (this.#sinceSpell >= SPELL_INTERVAL) {
        this.#sinceSpell = 0;
        spell = harm.spell;
      }
    }
    return { damage, spell };
  }
}
