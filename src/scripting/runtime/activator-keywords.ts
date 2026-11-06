// The keyword an activator asks of what comes to it (docs/scripting.md, "Triggers"). Observed in
// the original: a trigger volume or a trap whose base is an activator with a keyword takes notice
// only of references that have that keyword: no OnTriggerEnter, no count, no trap hit for others.
// The data shows which keyword (ACTI KNAM): defaultSetStageTRIGOnLeavePlayerOnly and 62 more
// carry PlayerKeyword, dunDustmansCairnNoCompanionTrigger C01Companion. Platform-independent.

export class ActivatorKeywords {
  readonly #keywordOf: (reference: number) => Promise<number | undefined>;
  readonly #has: (who: number, keyword: number) => Promise<boolean>;
  /** By trigger or trap: its base's keyword (null: none). */
  readonly #keywords = new Map<number, number | null>();
  readonly #asked = new Map<string, boolean>();
  readonly #asking = new Set<string>();

  constructor(
    keywordOf: (reference: number) => Promise<number | undefined>,
    has: (who: number, keyword: number) => Promise<boolean>,
  ) {
    this.#keywordOf = keywordOf;
    this.#has = has;
  }

  /** Whether a reference is known to ask for no keyword (nothing to wait for). */
  asksNothing(reference: number): boolean {
    return this.#keywords.get(reference) === null;
  }

  /** Whether a trigger or trap takes notice of `who`. */
  async admits(reference: number, who: number): Promise<boolean> {
    let keyword = this.#keywords.get(reference);
    if (keyword === undefined) {
      keyword = (await this.#keywordOf(reference)) ?? null;
      this.#keywords.set(reference, keyword);
    }
    return keyword === null || this.#has(who, keyword);
  }

  /**
   * admits, now, for one that cannot wait (a contact each physics step): what it found when last
   * asked, and yes meanwhile (a short contact is not lost on the asking; the vanilla traps ask
   * for no keyword).
   */
  admitsNow(reference: number, who: number): boolean {
    if (this.asksNothing(reference)) return true;
    const key = `${String(reference)}:${String(who)}`;
    const known = this.#asked.get(key);
    if (known !== undefined) return known;
    if (!this.#asking.has(key)) {
      this.#asking.add(key);
      void this.admits(reference, who)
        .catch(() => true)
        .then((admitted) => {
          this.#asked.set(key, admitted);
          this.#asking.delete(key);
        });
    }
    return true;
  }
}
