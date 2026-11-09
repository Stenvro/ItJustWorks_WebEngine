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

/**
 * An entering use is in its furniture when its graph says it reached the furniture's state
 * (idleChairSitting: ChairEnterHandler, idleBedSleeping: BedEnterHandler; src/shell/
 * actor-furniture.ts graphEntered); one whose graph has not said so this long after its enter's
 * root motion ended is in it all the same (seconds). TODO(M13): the engine waits for the graph
 * alone; this covers graphs whose enters our runtime does not play to the event (inferred, as
 * the exit's grace).
 */
export const ENTER_GRACE = 1.5;

/**
 * Where an entering use stands by the seconds `left` of its enter's root motion: moving by it
 * (and the tween to the marker at its end), then at its marker waiting for its graph's word,
 * then in its furniture without it after ENTER_GRACE. Its graph's enter event puts it in at
 * any time.
 */
export function enterStep(left: number): 'moving' | 'waiting' | 'in' {
  if (left > 0) return 'moving';
  return left <= -ENTER_GRACE ? 'in' : 'waiting';
}
