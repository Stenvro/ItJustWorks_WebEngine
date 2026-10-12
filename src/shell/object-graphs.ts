// Every placed object whose mesh has a behavior graph runs its own copy of it, started when
// the object is placed (its 3D loads), on the renderer's clock.

import { ObjectGraph } from '../animation/object-graph.ts';
import type { GpuModel } from '../render/scene-renderer.ts';

/** Seconds on the renderer's clock (main.ts renders with requestAnimationFrame's time). */
const clock = (): number => performance.now() / 1000;

/**
 * A placed object's run of its model's behavior graph, or undefined if the model has none.
 * `seed` (the reference's form id) makes random start states the same every time it loads.
 */
export function startObjectGraph(model: GpuModel, seed: number): ObjectGraph | undefined {
  if (!model.graph || !model.sequences) return undefined;
  return new ObjectGraph(model.graph, model.sequences.byName, clock(), seededRandom(seed));
}

/** Mulberry32: a small deterministic generator in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
