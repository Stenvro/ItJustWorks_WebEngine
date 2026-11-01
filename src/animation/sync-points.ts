// Sync points: how a syncing blender (hkbBlenderGenerator FLAG_SYNC) keeps its children in step
// by their clips' sync points (docs/animation.md, "Syncing blenders"). A clip's sync points are
// the events its graph flags as sync points (EVENT_FLAGS.syncPoint: SyncLeft, SyncRight,
// FootLeft, FootRight, ...) at its triggers and annotations, by their place in its cycle. The
// blender's cycle has a layout of them (its sync master's, else its children's weighted), and
// each child plays at the place between its own sync points that the blender's phase has
// between the layout's of the same name: a walk whose left foot falls at a third of its cycle
// and a run whose falls at a half both have it down as the blend passes SyncLeft (Havok's
// generator sync info, hkbGeneratorSyncInfo, matches sync points by their event's id).

/** A sync point of a cycle: its event (lower case) and its place in the cycle (0..1). */
export interface SyncPoint {
  readonly name: string;
  readonly at: number;
}

/** A cycle's sync points by key: the event's name and which of that name it is (#0, #1). */
function keyed(points: readonly SyncPoint[]): Map<string, number> {
  const out = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const point of [...points].sort((a, b) => a.at - b.at)) {
    const n = counts.get(point.name) ?? 0;
    counts.set(point.name, n + 1);
    out.set(`${point.name}#${n}`, point.at);
  }
  return out;
}

const wrap = (value: number): number => ((value % 1) + 1) % 1;

/**
 * The layout of a syncing blender's cycle: the sync points its children with sync points share,
 * each at the weighted mean of their places (taken round the cycle: 0.98 and 0.02 meet at 0).
 * Children without sync points leave it alone; none sharing any: empty.
 */
export function syncLayout(
  children: readonly { readonly points: readonly SyncPoint[]; readonly weight: number }[],
): SyncPoint[] {
  const sets = children
    .filter((child) => child.weight > 0 && child.points.length > 0)
    .map((child) => ({ points: keyed(child.points), weight: child.weight }));
  const first = sets[0];
  if (!first) return [];
  const out: SyncPoint[] = [];
  for (const [key, reference] of first.points) {
    let total = 0;
    let sum = 0;
    let shared = true;
    for (const set of sets) {
      const at = set.points.get(key);
      if (at === undefined) {
        shared = false;
        break;
      }
      // Its place nearest the first child's, round the cycle.
      const near = at - Math.round(at - reference);
      sum += near * set.weight;
      total += set.weight;
    }
    if (shared && total > 0)
      out.push({ name: key.slice(0, key.lastIndexOf('#')), at: wrap(sum / total) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The phase a child plays at for a blender's `phase` (0..1) in a cycle laid out as `layout`
 * (syncLayout): between the two layout sync points around the phase, at the same
 * share of the way between its own of those keys. With one shared sync point it is shifted by
 * that point's difference; with none, the blender's phase.
 */
export function alignPhase(
  phase: number,
  layout: readonly SyncPoint[],
  own: readonly SyncPoint[],
): number {
  if (layout.length === 0 || own.length === 0) return phase;
  const mine = keyed(own);
  const pairs: { readonly from: number; readonly to: number }[] = [];
  for (const [key, from] of keyed(layout)) {
    const at = mine.get(key);
    if (at !== undefined) pairs.push({ from, to: at });
  }
  const only = pairs[0];
  if (!only) return phase;
  if (pairs.length === 1) return wrap(phase - only.from + only.to);
  // The segment of the layout the phase is in (the last one wraps round to the first).
  let index = pairs.length - 1;
  for (let i = 0; i < pairs.length; i++) {
    if ((pairs[i]?.from ?? 0) <= phase) index = i;
  }
  const a = pairs[index] ?? only;
  const b = pairs[(index + 1) % pairs.length] ?? only;
  const span = wrap(b.from - a.from) || 1;
  const share = wrap(phase - a.from) / span;
  const ownSpan = wrap(b.to - a.to) || 1;
  return wrap(a.to + share * ownSpan);
}
