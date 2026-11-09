// Flight past a load door (docs/ai.md, "The combat behaviour tree", Flee): an actor that fled
// through a load door (Flee Through Door) leaves the loaded area, and with it its fight; its
// flight goes on in the space it came into. Placed there again while its enemy is there too (the
// player followed it through, or that side is loaded already) and before its side would have
// given its enemy up, it fights on: it flees again from that enemy, as afraid as it was (its
// confidence boosts and its fight's confidence modifier kept), and leaves alone the door it came
// out of for fCombatFleeLastDoorRestrictTime from its passage, as one that has just come by it.
// Its fight lasts as long as a group keeps a target lost while all of it flees
// (fCombatDetectionFleeingLostRemoveTime, 30 s); later it is over. Inferred from the settings and
// the combat group's rules, TODO(M13): the original's handling of a fight whose actor left the
// loaded area. Platform-independent.

/** What a fled actor's fight carries through the door. */
export interface FledFight {
  /** The enemy it fled from (its combat target). */
  readonly enemy: number;
  /** The door it came out of on the other side (the one it came by). */
  readonly door: number;
  /** Its fight's confidence modifier and the levels Boost Confidence raised it by. */
  readonly modifier: number | undefined;
  readonly boost: number;
  /** How long its fight is carried (its group's fCombatDetectionFleeingLostRemoveTime). */
  readonly keep?: number | undefined;
}

interface Fled extends FledFight {
  /** When it went through (the keeper's clock, seconds). */
  readonly at: number;
}

/** A fled fight to take up now, and how long ago its actor went through. */
export interface FledFightDue extends FledFight {
  readonly actor: number;
  readonly ago: number;
}

export class FledThroughDoors {
  readonly #fled = new Map<number, Fled>();
  #clock = 0;
  /** fCombatDetectionFleeingLostRemoveTime: how long a fled actor's fight is carried. */
  keepTime: number;

  constructor(keepTime = 30) {
    this.keepTime = keepTime;
  }

  /** An actor fled through a door: its fight goes with it. */
  went(actor: number, fight: FledFight): void {
    this.#fled.set(actor, { ...fight, at: this.#clock });
  }

  /** Whether an actor's fled fight is still carried. */
  carries(actor: number): boolean {
    return this.#fled.has(actor);
  }

  /**
   * One frame (seconds): the fights to take up now, those whose actor and enemy are both here
   * (`present`); those carried longer than the keep time are over and dropped. A fight handed
   * out stays until `taken` (its actor may not be ready to fight yet).
   */
  update(seconds: number, present: (reference: number) => boolean): FledFightDue[] {
    this.#clock += seconds;
    const due: FledFightDue[] = [];
    for (const [actor, fled] of this.#fled) {
      const ago = this.#clock - fled.at;
      if (ago > (fled.keep ?? this.keepTime)) {
        this.#fled.delete(actor);
        continue;
      }
      if (present(actor) && present(fled.enemy)) {
        due.push({
          actor,
          enemy: fled.enemy,
          door: fled.door,
          modifier: fled.modifier,
          boost: fled.boost,
          ago,
        });
      }
    }
    return due;
  }

  /** Its fight was taken up (or ended otherwise: it died, a new fight began). */
  taken(actor: number): void {
    this.#fled.delete(actor);
  }

  clear(): void {
    this.#fled.clear();
  }
}
