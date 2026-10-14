import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { LocationType, parsePackage, TargetType } from './package-records.ts';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const i32s = (...values: number[]): Uint8Array => new Uint8Array(Int32Array.from(values).buffer);
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
      onBegin: 0x99,
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
    expect(pack.onBegin).toBeUndefined();
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
});
