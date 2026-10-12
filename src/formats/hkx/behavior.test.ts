import { describe, expect, it } from 'vitest';
import { PackfileBuilder } from '../../../tests/helpers/hkx-builder.ts';
import {
  characterBehaviorFile,
  graphStart,
  loadBehaviorGraph,
  parseBehaviorGraph,
  projectCharacterFile,
  type BehaviorGraph,
} from './behavior.ts';
import { Packfile } from './packfile.ts';

/** A sequence leaf (BGSGamebryoSequenceGenerator) playing `sequence`. */
function sequenceLeaf(
  builder: PackfileBuilder,
  sequence: string,
  blendMode = 0,
  percentVariable?: number,
): number {
  const leaf = builder.object('BGSGamebryoSequenceGenerator', 112);
  builder.string(leaf + 56, `${sequence}Generator`).string(leaf + 72, sequence);
  builder.u8(leaf + 80, blendMode).f32(leaf + 84, 1);
  if (percentVariable !== undefined) bind(builder, leaf, 'fPercent', percentVariable);
  return leaf;
}

/** Binds a member of an hkbBindable to a variable. */
function bind(builder: PackfileBuilder, bindable: number, member: string, variable: number): void {
  const set = builder.object('hkbVariableBindingSet', 40);
  builder.pointer(bindable + 16, set);
  const binding = builder.array(set + 16, 40, 1);
  builder
    .string(binding, member)
    .i32(binding + 28, variable)
    .u8(binding + 32, 0xff);
}

/** Transitions (event → state) as an hkbStateMachineTransitionInfoArray. */
function transitions(
  builder: PackfileBuilder,
  entries: readonly { event: number; to: number; flags: number }[],
): number {
  const array = builder.object('hkbStateMachineTransitionInfoArray', 32);
  const data = builder.array(array + 16, 72, entries.length);
  entries.forEach((entry, i) => {
    const at = data + i * 72;
    builder
      .i32(at + 48, entry.event)
      .i32(at + 52, entry.to)
      .i16(at + 66, entry.flags);
  });
  return array;
}

function state(
  builder: PackfileBuilder,
  id: number,
  name: string,
  generator: number,
  outgoing?: number,
): number {
  const info = builder.object('hkbStateMachineStateInfo', 120);
  builder.pointer(info + 88, generator).string(info + 96, name);
  builder
    .i32(info + 104, id)
    .f32(info + 108, 1)
    .u8(info + 112, 1);
  if (outgoing !== undefined) builder.pointer(info + 80, outgoing);
  return info;
}

/**
 * A graph like the generic ones: the start state comes from the variable iState (1); state 0
 * plays AutoPlay and moves to state 1 on "End"; state 1 blends partA (percent fToggle, 0.25)
 * and partB (weight 0); "StopEffect" returns to state 0 from anywhere.
 */
function buildGraph(): Uint8Array {
  const builder = new PackfileBuilder();
  const graph = builder.object('hkbBehaviorGraph', 160);
  builder.string(graph + 56, 'Behavior.hkb');
  const machine = builder.object('hkbStateMachine', 264);
  builder.pointer(graph + 128, machine).string(machine + 56, 'Root');
  bind(builder, machine, 'startStateId', 2);
  const blender = builder.object('hkbBlenderGenerator', 160);
  builder.string(blender + 56, 'Blend').f32(blender + 76, 1);
  const children = builder.array(blender + 96, 8, 2);
  [
    { weight: 1, leaf: sequenceLeaf(builder, 'partA', 1, 0) },
    { weight: 0, leaf: sequenceLeaf(builder, 'partB', 2, 0) },
  ].forEach(({ weight, leaf }, i) => {
    const child = builder.object('hkbBlenderGeneratorChild', 72);
    builder
      .pointer(child + 48, leaf)
      .f32(child + 64, weight)
      .f32(child + 68, 1);
    builder.pointer(children + i * 8, child);
  });
  const states = builder.array(machine + 144, 8, 2);
  const autoplay = sequenceLeaf(builder, 'AutoPlay');
  builder.pointer(
    states,
    state(builder, 0, 'Play', autoplay, transitions(builder, [{ event: 0, to: 1, flags: 0x100 }])),
  );
  builder.pointer(states + 8, state(builder, 1, 'Toggle', blender));
  builder.pointer(machine + 160, transitions(builder, [{ event: 1, to: 0, flags: 0x900 }]));
  const data = builder.object('hkbBehaviorGraphData', 128);
  builder.pointer(graph + 136, data);
  const infos = builder.array(data + 32, 6, 3);
  builder
    .u8(infos + 4, 4)
    .u8(infos + 10, 4)
    .u8(infos + 16, 3);
  const values = builder.object('hkbVariableValueSet', 64);
  builder.pointer(data + 112, values);
  const words = builder.array(values + 16, 4, 3);
  builder
    .f32(words, 0.25)
    .f32(words + 4, 0.5)
    .i32(words + 8, 1);
  const strings = builder.object('hkbBehaviorGraphStringData', 80);
  builder.pointer(data + 120, strings);
  const events = builder.array(strings + 16, 8, 2);
  builder.string(events, 'End').string(events + 8, 'StopEffect');
  const names = builder.array(strings + 48, 8, 3);
  builder
    .string(names, 'fToggle')
    .string(names + 8, 'fDamp')
    .string(names + 16, 'iState');
  return builder.build(graph);
}

describe('behavior graphs', () => {
  const graph: BehaviorGraph = parseBehaviorGraph(Packfile.parse(buildGraph()));

  it('reads the variables with their initial values and the event names', () => {
    expect(graph.name).toBe('Behavior.hkb');
    expect(graph.events).toEqual(['End', 'StopEffect']);
    expect(graph.variables).toEqual([
      { name: 'fToggle', type: 4, initial: 0.25 },
      { name: 'fDamp', type: 4, initial: 0.5 },
      { name: 'iState', type: 3, initial: 1 },
    ]);
  });

  it('reads state machines, transitions, blenders, bindings and sequence leaves', () => {
    const root = graph.root;
    if (root?.kind !== 'state-machine') throw new Error('no state machine');
    expect(root.startStateId).toEqual({ value: 0, variable: 2 });
    expect(root.states.map((s) => [s.id, s.name, s.enable])).toEqual([
      [0, 'Play', true],
      [1, 'Toggle', true],
    ]);
    expect(root.states[0]?.transitions).toEqual([
      { eventId: 0, toStateId: 1, priority: 0, flags: 0x100, conditional: false, duration: 0 },
    ]);
    expect(root.wildcardTransitions[0]).toMatchObject({ eventId: 1, toStateId: 0 });
    const blender = root.states[1]?.generator;
    if (blender?.kind !== 'blender') throw new Error('no blender');
    expect(blender.children.map((child) => child.weight.value)).toEqual([1, 0]);
    expect(blender.children[0]?.generator).toEqual({
      kind: 'gamebryo-sequence',
      name: 'partAGenerator',
      sequence: 'partA',
      blendMode: 1,
      percent: { value: 1, variable: 0 },
    });
  });

  it('starts in the state its variable names, with the weighted children of blenders', () => {
    expect(graphStart(graph)).toEqual({
      sequences: [{ sequence: 'parta', weight: 0.25 }],
      clips: [],
    });
  });

  it('follows a project to its character and behavior files', async () => {
    const project = new PackfileBuilder();
    const projectData = project.object('hkbProjectData', 48);
    const projectStrings = project.object('hkbProjectStringData', 120);
    project.pointer(projectData + 32, projectStrings);
    const characters = project.array(projectStrings + 48, 8, 1);
    project.string(characters, 'Characters\\Fire.hkx');
    const character = new PackfileBuilder();
    const characterData = character.object('hkbCharacterData', 176);
    const characterStrings = character.object('hkbCharacterStringData', 192);
    character.pointer(characterData + 152, characterStrings);
    character.string(characterStrings + 184, 'Behaviors\\..\\Behaviors\\Fire.hkx');
    const files = new Map([
      ['meshes\\fx\\fire.hkx', project.build(projectData)],
      ['meshes\\fx\\characters\\fire.hkx', character.build(characterData)],
      ['meshes\\fx\\behaviors\\fire.hkx', buildGraph()],
    ]);
    expect(
      projectCharacterFile(Packfile.parse(files.get('meshes\\fx\\fire.hkx') ?? new Uint8Array())),
    ).toBe('Characters\\Fire.hkx');
    expect(
      characterBehaviorFile(
        Packfile.parse(files.get('meshes\\fx\\characters\\fire.hkx') ?? new Uint8Array()),
      ),
    ).toBe('Behaviors\\..\\Behaviors\\Fire.hkx');
    const read = (path: string): Promise<Uint8Array> => {
      const bytes = files.get(path);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`missing ${path}`));
    };
    const loaded = await loadBehaviorGraph('Meshes\\FX\\Fire.hkx', read);
    expect(loaded.events).toEqual(['End', 'StopEffect']);
  });
});
