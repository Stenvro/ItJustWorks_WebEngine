// The animation graphs' state a reference's change form keeps (CHANGE_REFR_ANIMATION, docs/formats/
// ess.md "Animation graphs"): for each of its behavior graphs the active state machines' states,
// the playing clips' and sequence generators' local times and every variable by name; for a
// reference with no graph the NIF sequence it plays. Platform-independent.

import { essReader, type EssReader, type EssSource } from './ess-reader.ts';

/** The name the variables' list ends with (a variable's name never is this). */
const END_OF_VARIABLES = '$-NoMoreVariables-$';

/** One active state machine: its node's name, the state it is in. */
export interface EssGraphMachine {
  /** The behavior graph's name and the machine's node name ("0_Master.hkb/Master_Behavior"). */
  readonly graph: string;
  readonly node: string;
  readonly stateId: number;
  readonly stateName: string;
  /** Two values after the state's name (TODO(M13): their meaning; 0 or small integers). */
  readonly values: readonly [number, number];
}

/** A playing clip or sequence generator and its local time (seconds). */
export interface EssGraphClip {
  readonly graph: string;
  readonly node: string;
  readonly time: number;
}

/** A behavior graph's saved state. */
export interface EssAnimationGraph {
  /** The graph's class ("BShkbAnimationGraph" in every save read). */
  readonly className: string;
  readonly machines: readonly EssGraphMachine[];
  /** The clip generators playing (hkbClipGenerator). */
  readonly clips: readonly EssGraphClip[];
  /** The other generators with a time of their own (Gamebryo sequences, an idle's generator). */
  readonly generators: readonly EssGraphClip[];
  /** The word variables: their 32 bits as the graph keeps them (a real's float bits). */
  readonly words: readonly (readonly [string, number])[];
  /** The quad variables (vectors, quaternions): x, y, z, w. */
  readonly quads: readonly (readonly [string, number, number, number, number])[];
  /**
   * The event-driven modifiers (BSEventDrivenModifier) listed after the variables: each one's
   * name and whether it is active (the event that turns it on came).
   */
  readonly eventModifiers: readonly (readonly [string, boolean])[];
}

export interface EssAnimationGraphs {
  readonly graphs: readonly EssAnimationGraph[];
  /** A reference without a graph: the NIF sequence it plays ("Open", "Close"). */
  readonly sequence?: string;
}

/** Splits "File.hkb/Node" into the graph's name and the node's (the first '/'). */
function split(name: string): { graph: string; node: string } {
  const at = name.indexOf('/');
  return at < 0
    ? { graph: '', node: name }
    : { graph: name.slice(0, at), node: name.slice(at + 1) };
}

function readClips(reader: EssReader): EssGraphClip[] {
  const clips: EssGraphClip[] = [];
  for (let n = reader.u32(), i = 0; i < n; i++) {
    const name = split(reader.wstring());
    clips.push({ ...name, time: reader.f32() });
  }
  return clips;
}

/**
 * Reads one graph from its class name to its event-driven modifiers. What follows them (12
 * bytes, then a u32 count of look-at modifiers: each its name, u32 bones, u32 eye bones and
 * their quaternions, then more) is not read: a second graph is found by its class name
 * (TODO(M13): the rest's layout; the look-at turns to its target again within a few frames).
 */
function readGraph(reader: EssReader): EssAnimationGraph {
  const className = reader.wstring();
  const machines: EssGraphMachine[] = [];
  for (let n = reader.u32(), i = 0; i < n; i++) {
    const name = split(reader.wstring());
    const stateId = reader.u32();
    const stateName = reader.wstring();
    machines.push({ ...name, stateId, stateName, values: [reader.u32(), reader.u32()] });
  }
  const clips = readClips(reader);
  const generators = readClips(reader);
  const words: [string, number][] = [];
  const quads: [string, number, number, number, number][] = [];
  for (;;) {
    const name = reader.wstring();
    if (name === END_OF_VARIABLES) break;
    // 1: a word (4 bytes), 0: a quad (16 bytes).
    if (reader.u8() === 1) words.push([name, reader.u32()]);
    else quads.push([name, reader.f32(), reader.f32(), reader.f32(), reader.f32()]);
  }
  const eventModifiers: (readonly [string, boolean])[] = [];
  for (let n = reader.u32(), i = 0; i < n; i++) {
    eventModifiers.push([reader.wstring(), reader.u8() !== 0]);
  }
  return { className, machines, clips, generators, words, quads, eventModifiers };
}

/** Where the next graph's class name (a u16 length and the name) stands, from `from`. */
function findClassName(bytes: Uint8Array, from: number, name: string): number {
  const length = name.length;
  outer: for (let at = from; at + 2 + length <= bytes.length; at++) {
    if (bytes[at] !== (length & 0xff) || bytes[at + 1] !== length >>> 8) continue;
    for (let i = 0; i < length; i++) {
      if (bytes[at + 2 + i] !== name.charCodeAt(i)) continue outer;
    }
    return at;
  }
  return -1;
}

/** Reads a change form's animation block (the bytes its vsval size covers). */
export function readAnimationGraphs(source: EssSource): EssAnimationGraphs {
  const reader = essReader(source);
  if (reader.u8() === 0) return { graphs: [], sequence: reader.wstring() };
  const count = reader.u32();
  const graphs: EssAnimationGraph[] = [];
  const start = reader.offset;
  const bytes = reader.bytes(reader.remaining);
  reader.seek(start);
  for (let i = 0; i < count; i++) {
    const graph = readGraph(reader);
    graphs.push(graph);
    if (i + 1 === count) break;
    const next = findClassName(bytes, reader.offset - start, graph.className);
    if (next < 0) break;
    reader.seek(start + next);
  }
  return { graphs };
}
