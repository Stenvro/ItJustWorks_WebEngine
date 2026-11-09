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

/** The fights a fled actor's flight is taken up in (src/shell/actor-combat.ts). */
export interface FledCombat {
  targetOf(actor: number): number | undefined;
  startCombat(actor: number, target: number, options: { modifier?: number | undefined }): void;
  /** Its flight goes on; false while its fight has not taken hold yet. */
  resumeFlight(actor: number, fight: FledFightDue): boolean;
}

/**
 * The fled actors' fights and their taking up: each frame a fled actor placed again with its
 * enemy here has its fight started again, then flees on once that fight took hold. All of it
 * belongs to the game being played: a load or a New Game drops it (`clear`), so no fight carried
 * from the game that was left is forced on the one loaded.
 */
export class FledFlights {
  readonly #fled: FledThroughDoors;
  /** Those whose fight has been started again, waiting for it to take hold. */
  readonly #starting = new Set<number>();

  constructor(fled = new FledThroughDoors()) {
    this.#fled = fled;
  }

  /** An actor fled through a door: its fight goes with it. */
  went(actor: number, fight: FledFight): void {
    this.#fled.went(actor, fight);
  }

  /** One frame (seconds): the fights whose actor and enemy are both here are taken up. */
  update(seconds: number, present: (reference: number) => boolean, combat: FledCombat): void {
    for (const actor of this.#starting) {
      if (!this.#fled.carries(actor)) this.#starting.delete(actor);
    }
    for (const due of this.#fled.update(seconds, present)) {
      if (combat.targetOf(due.actor) !== due.enemy) {
        if (this.#starting.has(due.actor)) continue;
        this.#starting.add(due.actor);
        combat.startCombat(due.actor, due.enemy, { modifier: due.modifier });
      }
      if (combat.resumeFlight(due.actor, due)) {
        this.#fled.taken(due.actor);
        this.#starting.delete(due.actor);
      }
    }
  }

  /** The game was left (a load, a New Game, the view closed): every carried fight is dropped. */
  clear(): void {
    this.#fled.clear();
    this.#starting.clear();
  }
}
