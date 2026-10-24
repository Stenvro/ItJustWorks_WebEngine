// Where a spell's impact on a surface may be placed (docs/gameplay.md, "A hand's cast"): not
// within its placement radius (IPCT DATA) of one of the same impact placed before and still
// showing (its effect's duration). A placed impact leaves its model, decal and hazard; one kept
// off only sounds. TODO(M13): inferred from the data (the dragons' fire impact, whose every
// spray would leave a 7-second fire, has 200 units; 649 of the 663 impacts 16); xEdit only
// names the field and the engine's own test is unread. Platform-independent.

type Vec3 = readonly [number, number, number];

/** What of an impact (IPCT) the placement reads. */
export interface PlacedImpactData {
  readonly formId: number;
  readonly placementRadius: number;
  /** Seconds its effect shows. */
  readonly duration: number;
}

export class ImpactPlacements {
  #placed: { readonly impact: number; readonly at: Vec3; readonly until: number }[] = [];

  /** Whether `impact` is placed at `at` (seconds `now` on any steady clock); placed: kept. */
  place(impact: PlacedImpactData, at: Vec3, now: number): boolean {
    this.#placed = this.#placed.filter((placed) => placed.until > now);
    const radius = impact.placementRadius;
    const near = this.#placed.some(
      (placed) =>
        placed.impact === impact.formId &&
        Math.hypot(placed.at[0] - at[0], placed.at[1] - at[1], placed.at[2] - at[2]) < radius,
    );
    if (radius > 0 && near) return false;
    if (impact.duration > 0)
      this.#placed.push({ impact: impact.formId, at: [...at], until: now + impact.duration });
    return true;
  }

  clear(): void {
    this.#placed = [];
  }
}
