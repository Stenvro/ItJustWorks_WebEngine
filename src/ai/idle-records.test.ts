import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  behaviorGraphKey,
  IdleCollectionFlag,
  IdleFlag,
  IdleTree,
  parseAction,
  parseIdle,
  parseIdleMarker,
  type ActionRecord,
  type IdleRecord,
} from './idle-records.ts';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const record = (fields: [string, Uint8Array][], formId = 0x100, flags = 0) => ({
  formId,
  editorId: new TextDecoder().decode(fields.find(([type]) => type === 'EDID')?.[1]).slice(0, -1),
  flags,
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});
/** A CTDA: GetRandomPercent (77) < 30, OR-flagged when `or`. */
const randomBelow = (value: number, or = false): Uint8Array => {
  const data = new Uint8Array(32);
  const v = new DataView(data.buffer);
  data[0] = (4 << 5) | (or ? 1 : 0);
  v.setFloat32(4, value, true);
  v.setUint16(8, 77, true);
  return data;
};

const MASTER = 'Actors\\Character\\Behaviors\\0_Master.hkx';
const DOG = 'Actors\\Canine\\Behaviors\\DogBehavior.hkx';

/** A tree idle for tests: only what the tree reads. */
const idle = (
  formId: number,
  parent: number | undefined,
  previous: number | undefined,
  extra: Partial<IdleRecord> = {},
): IdleRecord => ({
  formId,
  editorId: `Idle${formId.toString(16)}`,
  conditions: [],
  behaviorGraph: undefined,
  event: `event${formId.toString(16)}`,
  parent,
  previous,
  loopMin: 0,
  loopMax: 0,
  flags: 0,
  animationGroupSection: 0,
  replayDelay: 0,
  ...extra,
});
const action = (formId: number, editorId: string): ActionRecord => ({
  formId,
  editorId,
  color: [0, 0, 0, 0],
});
const ids = (idles: readonly IdleRecord[]): number[] => idles.map((entry) => entry.formId);
const master = behaviorGraphKey(MASTER);

describe('IDLE, AACT and IDLM records', () => {
  it('read an idle: conditions, graph, event, parent and previous, data', () => {
    const parsed = parseIdle(
      record([
        ['EDID', text('IdleCowLookRight')],
        ['CTDA', randomBelow(30, true)],
        ['CTDA', randomBelow(60)],
        ['DNAM', text('Actors\\Cow\\Behaviors\\H-CowBehavior.hkx')],
        ['ENAM', text('idleCowLookRightStart')],
        ['ANAM', u32s(0x798f9, 0x798fa)],
        ['DATA', bytes(10, 30, IdleFlag.noAttacking, 0x72, 15, 0)],
      ]),
    );
    expect(parsed).toMatchObject({
      editorId: 'IdleCowLookRight',
      behaviorGraph: 'Actors\\Cow\\Behaviors\\H-CowBehavior.hkx',
      event: 'idleCowLookRightStart',
      parent: 0x798f9,
      previous: 0x798fa,
      loopMin: 10,
      loopMax: 30,
      flags: IdleFlag.noAttacking,
      animationGroupSection: 0x72,
      replayDelay: 15,
    });
    expect(parsed.conditions).toHaveLength(2);
    expect(parsed.conditions[0]).toMatchObject({ function: 77, operator: 4, or: true });
    expect(parsed.conditions[1]).toMatchObject({ comparand: 60, or: false });
  });

  it('read a group and a loose idle: no event, no graph, null links', () => {
    const group = parseIdle(
      record([
        ['EDID', text('NonCombatIdles')],
        ['ANAM', u32s(0x13ac8, 0)],
        ['DATA', bytes(0, 0, 0, 0, 0, 0)],
      ]),
    );
    expect(group).toMatchObject({
      event: undefined,
      behaviorGraph: undefined,
      previous: undefined,
    });
    const loose = parseIdle(
      record([
        ['EDID', text('IdleNervous')],
        ['ENAM', text('IdleNervous')],
        ['ANAM', u32s(0, 0)],
        ['DATA', bytes(0, 0, IdleFlag.loose, 0, 0, 0)],
      ]),
    );
    expect(loose).toMatchObject({ parent: undefined, previous: undefined, flags: IdleFlag.loose });
  });

  it('read an action and an idle marker', () => {
    expect(
      parseAction(
        record([
          ['EDID', text('ActionIdle')],
          ['CNAM', bytes(255, 128, 0, 0)],
        ]),
      ),
    ).toEqual({ formId: 0x100, editorId: 'ActionIdle', color: [255, 128, 0, 0] });
    const marker = parseIdleMarker(
      record(
        [
          ['EDID', text('BookReadingIdleMarker')],
          ['OBND', new Uint8Array(12)],
          ['IDLF', bytes(IdleCollectionFlag.looseOnly)],
          ['IDLC', bytes(2)],
          ['IDLT', new Uint8Array(Float32Array.of(15).buffer)],
          ['IDLA', u32s(0x7872c, 0x7872d)],
          ['MODL', text('Marker_Idle.nif')],
        ],
        0x7872b,
        0x20000000,
      ),
    );
    expect(marker).toEqual({
      formId: 0x7872b,
      editorId: 'BookReadingIdleMarker',
      childCanUse: true,
      model: 'Marker_Idle.nif',
      flags: IdleCollectionFlag.looseOnly,
      count: 2,
      timer: 15,
      idles: [0x7872c, 0x7872d],
    });
  });

  it('compare behavior graph paths as the projects name them', () => {
    expect(behaviorGraphKey(MASTER)).toBe('actors\\character\\behaviors\\0_master.hkx');
    expect(behaviorGraphKey('meshes/Actors/Character/Behaviors/0_Master.hkx')).toBe(master);
  });
});

describe('the idle tree', () => {
  it('orders siblings by their previous links, per behavior graph', () => {
    // Under the action: a dog root and a character root, each the first of its graph.
    const tree = new IdleTree(
      [action(1, 'ActionIdle')],
      [
        idle(0x13, 0x10, 0x12),
        idle(0x10, 1, undefined, { behaviorGraph: MASTER, event: undefined }),
        idle(0x20, 1, undefined, { behaviorGraph: DOG, event: undefined }),
        idle(0x11, 0x10, undefined),
        idle(0x12, 0x10, 0x11),
      ],
    );
    expect(ids(tree.children(1, master))).toEqual([0x10]);
    expect(ids(tree.children(1))).toEqual([0x10, 0x20]);
    expect(tree.graphsUnder(1)).toEqual([master, behaviorGraphKey(DOG)]);
    // Idles without DNAM are for their parent's graph.
    expect(tree.graph(0x13)).toBe(master);
    expect(ids(tree.children(0x10, master))).toEqual([0x11, 0x12, 0x13]);
    expect(tree.rootAction(0x13)?.editorId).toBe('ActionIdle');
    expect(tree.action('actionidle')?.formId).toBe(1);
    expect(tree.problems).toEqual([]);
  });

  it('puts a later plugin’s idle first where two name the same previous', () => {
    // 0x31 (vanilla) and 0x41 (a DLC, later) both follow 0x30; 0x42 follows the DLC's.
    const tree = new IdleTree(
      [action(1, 'ActionActivate')],
      [
        idle(0x30, 1, undefined, { behaviorGraph: MASTER }),
        idle(0x31, 1, 0x30, { behaviorGraph: MASTER }),
        idle(0x32, 1, 0x31, { behaviorGraph: MASTER }),
        idle(0x41, 1, 0x30, { behaviorGraph: MASTER }),
        idle(0x42, 1, 0x41, { behaviorGraph: MASTER }),
      ],
    );
    expect(ids(tree.children(1))).toEqual([0x30, 0x41, 0x42, 0x31, 0x32]);
    expect(tree.problems).toEqual([
      { idle: 0x41, problem: 'previous shared' },
      { idle: 0x31, problem: 'previous shared' },
    ]);
  });

  it('keeps loose idles apart and reports links that do not hold', () => {
    const tree = new IdleTree(
      [action(1, 'ActionIdle')],
      [
        idle(0x50, undefined, undefined, { flags: IdleFlag.loose }),
        idle(0x51, 0x999, undefined),
        idle(0x52, 1, undefined),
        idle(0x53, 1, 0x998),
        idle(0x54, 1, 0x50),
        idle(0x55, 1, 0x56),
        idle(0x56, 1, 0x55),
      ],
    );
    expect(ids(tree.loose)).toEqual([0x50]);
    // Unreached siblings follow the chain in load order.
    expect(ids(tree.children(1))).toEqual([0x52, 0x53, 0x54, 0x55, 0x56]);
    expect(tree.problems).toEqual([
      { idle: 0x51, problem: 'parent missing' },
      { idle: 0x53, problem: 'previous missing' },
      { idle: 0x54, problem: 'previous not a sibling' },
      { idle: 0x55, problem: 'cycle' },
    ]);
    expect(tree.rootAction(0x50)).toBeUndefined();
  });

  // ActionDraw for characters: DrawSheathRoot > [MountedDraw > [...], NonMountedDraw >
  // [DrawMagic, DefaultDrawWeapon]]; a dog's root beside it.
  const drawTree = (): IdleTree =>
    new IdleTree(
      [action(1, 'ActionDraw')],
      [
        idle(0x20, 1, undefined, { behaviorGraph: DOG, event: 'dogDraw' }),
        idle(0x10, 1, undefined, { behaviorGraph: MASTER, event: undefined }),
        idle(0x11, 0x10, undefined, { editorId: 'MountedDraw', event: undefined }),
        idle(0x12, 0x11, undefined, { event: 'WeapEquip' }),
        idle(0x13, 0x10, 0x11, { editorId: 'NonMountedDraw', event: undefined }),
        idle(0x14, 0x13, undefined, { event: 'Magic_Equip' }),
        idle(0x15, 0x13, 0x14, { event: 'WeapEquip' }),
        idle(0x16, 0x10, 0x13, { event: 'fallback' }),
      ],
    );

  it('resolves an action to the first idle whose conditions hold, down the tree', () => {
    const tree = drawTree();
    const holds =
      (...passing: number[]) =>
      (entry: IdleRecord): boolean =>
        passing.includes(entry.formId);
    expect(tree.resolve(1, master, holds(0x10, 0x13, 0x14, 0x15))?.formId).toBe(0x14);
    expect(tree.resolve(1, master, holds(0x10, 0x13, 0x15))?.formId).toBe(0x15);
    // Only the actor's graph: the dog's root comes first but is not a character's.
    expect(tree.resolve(1, behaviorGraphKey(DOG), () => true)?.event).toBe('dogDraw');
    // A group taken, none of its children: the group, which plays nothing; its next sibling
    // is not tried.
    const group = tree.resolve(1, master, holds(0x10, 0x11, 0x16));
    expect(group?.formId).toBe(0x11);
    expect(group?.event).toBeUndefined();
    // Nothing under the action qualifies.
    expect(tree.resolve(1, master, holds())).toBeUndefined();
  });

  it('checks an idle with the idles above it', () => {
    const tree = drawTree();
    const leaf = tree.idles.get(0x15);
    if (!leaf) throw new Error('no idle');
    expect(tree.holdsWithParents(leaf, () => true)).toBe(true);
    expect(tree.holdsWithParents(leaf, (entry) => entry.formId !== 0x10)).toBe(false);
  });
});
