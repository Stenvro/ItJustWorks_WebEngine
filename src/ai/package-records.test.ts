import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  BranchFlag,
  InterruptFlag,
  LocationType,
  PackageFlag,
  PackageIdleFlag,
  parsePackage,
  TargetType,
} from './package-records.ts';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const i32s = (...values: number[]): Uint8Array => new Uint8Array(Int32Array.from(values).buffer);
const u16s = (...values: number[]): Uint8Array => new Uint8Array(Uint16Array.from(values).buffer);
const f32s = (...values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const record = (fields: [string, Uint8Array][]) => ({
  formId: 0x100,
  editorId: 'Test',
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});
/** A CTDA: GetStageDone (59) of quest 0x50 stage 10 == 0. */
const stageNotDone = (): Uint8Array => {
  const data = new Uint8Array(32);
  const v = new DataView(data.buffer);
  v.setFloat32(4, 0, true);
  v.setUint16(8, 59, true);
  v.setUint32(12, 0x50, true);
  v.setInt32(16, 10, true);
  return data;
};

describe('AI packages', () => {
  it('read a package: flags, schedule, conditions, template and data inputs by id', () => {
    const pack = parsePackage(
      record([
        ['EDID', text('GuardPatrolDay')],
        ['PKDT', u32s(0x2000, 0x12, 0)],
        // 07:00 for 720 minutes, any day.
        ['PSDT', bytes(0xff, 0xff, 0, 7, 0, 0, 0, 0, ...u32s(720))],
        ['CTDA', stageNotDone()],
        ['PKCU', u32s(6, 0x17723, 0)],
        ['ANAM', text('SingleRef')],
        ['PTDA', i32s(TargetType.linkedReference, 0, 0)],
        ['ANAM', text('Float')],
        ['CNAM', new Uint8Array(Float32Array.of(144).buffer)],
        ['ANAM', text('Location')],
        ['PLDT', i32s(LocationType.inCell, 0x580a2, 0)],
        ['ANAM', text('Bool')],
        ['CNAM', bytes(1)],
        ['UNAM', bytes(0)],
        ['UNAM', bytes(1)],
        ['UNAM', bytes(12)],
        ['UNAM', bytes(2)],
        ['XNAM', bytes(0)],
        ['POBA', new Uint8Array(0)],
        ['INAM', u32s(0x99)],
      ]),
    );
    expect(pack).toMatchObject({
      editorId: 'Test',
      flags: 0x2000,
      type: 0x12,
      schedule: { month: -1, dayOfWeek: -1, date: 0, hour: 7, minute: 0, duration: 720 },
      template: 0x17723,
      inputCount: 6,
      onBegin: { idle: 0x99, topic: undefined },
    });
    expect(pack.conditions).toHaveLength(1);
    expect(pack.conditions[0]).toMatchObject({ function: 59, form: 0x50, param2: 10 });
    expect(pack.inputs).toEqual([
      {
        id: 0,
        type: 'SingleRef',
        value: {
          kind: 'singleRef',
          target: { type: TargetType.linkedReference, value: 0, count: 0 },
        },
      },
      { id: 1, type: 'Float', value: { kind: 'float', value: 144 } },
      {
        id: 12,
        type: 'Location',
        value: {
          kind: 'location',
          location: { type: LocationType.inCell, form: 0x580a2, radius: 0 },
        },
      },
      { id: 2, type: 'Bool', value: { kind: 'bool', value: true } },
    ]);
    expect(pack.tree).toBeUndefined();
  });

  it('read a procedure tree by its branches’ child counts, and the input names', () => {
    // SitTarget: Sequence [Sit, Simultaneous [Sit, Wait]].
    const procedure = (name: string, ...inputs: number[]): [string, Uint8Array][] => [
      ['ANAM', text('Procedure')],
      ['CITC', u32s(0)],
      ['PNAM', text(name)],
      ['FNAM', u32s(name === 'Wait' ? 0 : 1)],
      ...inputs.map((id): [string, Uint8Array] => ['PKC2', bytes(id)]),
    ];
    const pack = parsePackage(
      record([
        ['PKDT', u32s(0, 0x13, 0)],
        ['XNAM', bytes(0)],
        ['ANAM', text('Sequence')],
        ['CITC', u32s(0)],
        ['PRCB', u32s(2, 0)],
        ...procedure('Sit', 16),
        ['ANAM', text('Simultaneous')],
        ['CITC', u32s(1)],
        ['CTDA', stageNotDone()],
        ['PRCB', u32s(2, 2)],
        ...procedure('Sit', 16),
        ...procedure('Wait', 3, 4),
        ['UNAM', bytes(3)],
        ['BNAM', text('Wait Time')],
        ['PNAM', u32s(0)],
        ['UNAM', bytes(16)],
        ['BNAM', text('Target')],
        ['PNAM', u32s(1)],
        ['POBA', new Uint8Array(0)],
        ['INAM', u32s(0)],
      ]),
    );
    const tree = pack.tree;
    expect(tree?.type).toBe('Sequence');
    expect(tree?.children.map((child) => child.procedure ?? child.type)).toEqual([
      'Sit',
      'Simultaneous',
    ]);
    const both = tree?.children[1];
    expect(both?.conditions).toHaveLength(1);
    expect(both?.children.map((child) => [child.procedure, child.inputs, child.flags])).toEqual([
      ['Sit', [16], 1],
      ['Wait', [3, 4], 0],
    ]);
    expect(pack.inputNames).toEqual([
      { id: 3, name: 'Wait Time', public: false },
      { id: 16, name: 'Target', public: true },
    ]);
    expect(pack.onBegin).toEqual({ idle: undefined, topic: undefined });
  });

  it('read a package with its own single procedure', () => {
    const pack = parsePackage(
      record([
        ['ANAM', text('SingleRef')],
        ['PTDA', i32s(TargetType.linkedReference, 0, 0)],
        ['UNAM', bytes(22)],
        ['XNAM', bytes(0)],
        ['ANAM', text('Procedure')],
        ['CITC', u32s(0)],
        ['PNAM', text('Sleep')],
        ['FNAM', u32s(0)],
        ['PKC2', bytes(22)],
        ['UNAM', bytes(22)],
        ['BNAM', text('Target')],
        ['PNAM', u32s(1)],
      ]),
    );
    expect(pack.tree).toMatchObject({ type: 'Procedure', procedure: 'Sleep', inputs: [22] });
    expect(pack.inputs.map((input) => input.id)).toEqual([22]);
    expect(pack.template).toBeUndefined();
  });

  it('read idles, combat style, interrupt flags, flag overrides and the events’ topics', () => {
    // A plugin's record: its form ids are remapped by the load order, alias ids are not.
    const plugin = (fields: [string, Uint8Array][]) => ({
      ...record(fields),
      formIdAt: (data: Uint8Array, offset = 0) => {
        const raw = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
          offset,
          true,
        );
        return raw === 0 ? 0 : raw + 0x01000000;
      },
    });
    const pdto = (kind: number, value: Uint8Array): Uint8Array => bytes(...u32s(kind), ...value);
    const pack = parsePackage(
      plugin([
        // Interrupt flags u16 0x16d; the 2 bytes after them are garbage.
        ['PKDT', bytes(...u32s(0), 19, 0, 2, 0x63, ...u16s(0x16d, 0x2c65))],
        ['IDLF', bytes(PackageIdleFlag.runInSequence | 0x8)],
        ['IDLC', bytes(2)],
        ['IDLT', f32s(3)],
        ['IDLA', u32s(0xefc64, 0xf3a99)],
        ['CNAM', u32s(0x10ff34)],
        ['QNAM', u32s(0x2610a)],
        ['PKCU', u32s(2, 0, 10)],
        ['ANAM', text('Location')],
        ['PLDT', i32s(LocationType.aliasLocation, 3, 0)],
        ['ANAM', text('Topic')],
        ['PDTO', pdto(1, text('HELO').subarray(0, 4))],
        ['UNAM', bytes(0)],
        ['UNAM', bytes(1)],
        ['XNAM', bytes(2)],
        ['ANAM', text('Sequence')],
        ['CITC', u32s(0)],
        ['PRCB', u32s(2, BranchFlag.repeatWhenComplete)],
        ['ANAM', text('Procedure')],
        ['CITC', u32s(0)],
        ['PNAM', text('Travel')],
        ['FNAM', u32s(0)],
        ['PKC2', bytes(0)],
        // Run while it travels, with the aggro radius off.
        [
          'PFO2',
          bytes(
            ...u32s(PackageFlag.preferredSpeed, 0),
            ...u16s(0, InterruptFlag.aggroRadiusBehavior),
            2,
            0x74,
            0x42,
            0x24,
          ),
        ],
        ['ANAM', text('Procedure')],
        ['CITC', u32s(0)],
        ['PNAM', text('Wait')],
        ['FNAM', u32s(1)],
        ['PFOR', bytes(...u32s(PackageFlag.ignoreCombat, 0), ...u16s(0, 0))],
        ['UNAM', bytes(0)],
        ['BNAM', text('Place to Travel')],
        ['PNAM', u32s(1)],
        ['POBA', new Uint8Array(0)],
        ['INAM', u32s(0)],
        ['SCHR', new Uint8Array(20)],
        ['SCTX', new Uint8Array(0)],
        ['PDTO', pdto(0, u32s(0xddcf4))],
        ['POEA', new Uint8Array(0)],
        ['INAM', u32s(0xbe2b1)],
        ['PDTO', pdto(0, u32s(0))],
        ['POCA', new Uint8Array(0)],
        ['INAM', u32s(0)],
        ['QNAM', u32s(0x2610a)],
        ['TNAM', u32s(0)],
        ['PDTO', pdto(1, text('GBYE').subarray(0, 4))],
      ]),
    );
    expect(pack).toMatchObject({
      type: 19,
      preferredSpeed: 2,
      interruptFlags: 0x16d,
      idles: {
        flags: PackageIdleFlag.runInSequence | 0x8,
        timer: 3,
        idles: [0x010efc64, 0x010f3a99],
      },
      combatStyle: 0x0110ff34,
      ownerQuest: 0x0102610a,
      template: undefined,
      inputCount: 2,
      version: 10,
      onBegin: { idle: undefined, topic: 0x010ddcf4 },
      onEnd: { idle: 0x010be2b1, topic: undefined },
      onChange: { idle: undefined, topic: 'GBYE' },
    });
    expect(pack.inputs.map((input) => input.value)).toEqual([
      // An alias location's value is the alias id, not a form.
      { kind: 'location', location: { type: LocationType.aliasLocation, form: 3, radius: 0 } },
      { kind: 'topic', topic: 'HELO' },
    ]);
    expect(pack.tree?.branchFlags).toBe(BranchFlag.repeatWhenComplete);
    expect(pack.tree?.children.map((child) => child.flagOverride)).toEqual([
      {
        setFlags: PackageFlag.preferredSpeed,
        clearFlags: 0,
        setInterruptFlags: 0,
        clearInterruptFlags: InterruptFlag.aggroRadiusBehavior,
        preferredSpeed: 2,
      },
      {
        setFlags: PackageFlag.ignoreCombat,
        clearFlags: 0,
        setInterruptFlags: 0,
        clearInterruptFlags: 0,
        preferredSpeed: undefined,
      },
    ]);
  });
});
