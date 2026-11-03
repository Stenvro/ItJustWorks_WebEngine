// Which of a furniture's markers an actor may take (docs/ai.md, "Furniture markers").
// Platform-independent: the stage's furniture (src/shell/actor-furniture.ts) chooses by it.

/**
 * How an actor ranks a marker by its keyword (FURN FNMK): undefined, it may not take it (the
 * marker has a keyword the actor lacks); 0, its own marker (it has the marker's keyword), taken
 * before the others; 1, a marker with no keyword. `held`: the markers' keywords the actor has
 * (undefined: no actor is asked; every marker ranks 1). TODO(M13): the original's own rule is
 * not read; this is the field's plain reading and its data's (the chopping block's markers:
 * the headsman's isExecutioner, the guard's isExecutionerGuard, the prisoner's none; the
 * headsmen and the Helgen officer carry those keywords).
 */
export function markerRank(
  keyword: number | undefined,
  held: ReadonlySet<number> | undefined,
): 0 | 1 | undefined {
  if (keyword === undefined || held === undefined) return 1;
  return held.has(keyword) ? 0 : undefined;
}
