// A graph's state as the original's saves keep it (docs/formats/ess.md "Animation graphs"): its
// nodes and variables by name rather than by place, so a graph of ours finds them by the names
// its behavior files give them. An imported save's actors and objects resume from it.
// Platform-independent.

/** A graph's state keyed by names, as an original save keeps it. */
export interface NamedGraphState {
  /** [the behavior graph's name ("0_Master.hkb"), the state machine's name, its state id]. */
  readonly machines: readonly (readonly [string, string, number])[];
  /** [the behavior graph's name, the clip's name, its local time]: the clips playing. */
  readonly clips: readonly (readonly [string, string, number])[];
  /** [the graph's name, the generator's name, its time]: Gamebryo sequences playing. */
  readonly sequences?: readonly (readonly [string, string, number])[];
  /**
   * The word variables by name: their 32 bits as the graph keeps them (a real's float bits,
   * an integer's or bool's value), read by the variable's type where it is found.
   */
  readonly words: readonly (readonly [string, number])[];
}

const scratch = new DataView(new ArrayBuffer(4));

/**
 * A word variable's value as our graphs keep it (reals as floats, the others as integers), by
 * its hkbVariableInfo type (behavior.ts BehaviorVariable.type): undefined for a type with no
 * word value (pointers, vectors).
 */
export function wordValue(bits: number, type: number): number | undefined {
  switch (type) {
    case 0: // bool
      return (bits & 0xff) !== 0 ? 1 : 0;
    case 1: // int8
      return (bits << 24) >> 24;
    case 2: // int16
      return (bits << 16) >> 16;
    case 3: // int32
      return bits | 0;
    case 4: // real
      scratch.setUint32(0, bits >>> 0, true);
      return scratch.getFloat32(0, true);
    default:
      return undefined;
  }
}

/**
 * The machines, clips and sequences of one behavior graph (by its name, any case), keyed by
 * their nodes' names in lower case.
 */
export function namedOf(
  named: NamedGraphState,
  graph: string,
): {
  machines: Map<string, number>;
  clips: Map<string, number>;
  sequences: Map<string, number>;
} {
  const key = graph.toLowerCase();
  const pick = (list: readonly (readonly [string, string, number])[] | undefined) => {
    const out = new Map<string, number>();
    for (const [owner, node, value] of list ?? []) {
      const name = node.toLowerCase();
      if (owner.toLowerCase() === key && !out.has(name)) out.set(name, value);
    }
    return out;
  };
  return {
    machines: pick(named.machines),
    clips: pick(named.clips),
    sequences: pick(named.sequences),
  };
}
