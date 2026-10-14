import { describe, expect, it } from 'vitest';
import { PackfileBuilder } from '../../../tests/helpers/hkx-builder.ts';
import { FormatError } from '../binary-reader.ts';
import { Packfile } from './packfile.ts';

describe('Havok packfile', () => {
  const builder = new PackfileBuilder();
  const root = builder.object('hkRootLevelContainer', 16);
  const data = builder.object('hkbProjectData', 48);
  const strings = builder.object('hkbProjectStringData', 120);
  builder
    .pointer(data + 32, strings)
    .f32(data + 16, 0.5)
    .i32(data + 24, -7)
    .u8(data + 40, 2);
  const names = builder.array(strings + 48, 8, 2);
  builder.string(names, 'Characters\\Character.hkx').string(names + 8, 'Second');
  builder.string(strings + 80, 'Animations');
  const parents = builder.array(root, 8, 2);
  builder.pointer(parents, data);
  const file = Packfile.parse(builder.build(root));

  it('reads the header and every object with its class', () => {
    expect(file.version).toBe('hk_2010.2.0-r1');
    expect(file.root?.className).toBe('hkRootLevelContainer');
    expect([...file.objects.values()].map((object) => object.className)).toEqual([
      'hkRootLevelContainer',
      'hkbProjectData',
      'hkbProjectStringData',
    ]);
    expect(file.objectsOf('hkbProjectData')[0]?.offset).toBe(data);
  });

  it('resolves object pointers, strings and arrays through the fixups', () => {
    expect(file.object(data + 32)?.className).toBe('hkbProjectStringData');
    expect(file.object(data + 40)).toBeUndefined();
    expect(file.stringArray(strings + 48)).toEqual(['Characters\\Character.hkx', 'Second']);
    expect(file.string(strings + 80)).toBe('Animations');
    expect(file.string(strings + 88)).toBeUndefined();
    expect(file.objectArray(root).map((object) => object?.className)).toEqual([
      'hkbProjectData',
      undefined,
    ]);
    expect(file.array(strings + 16)).toEqual({ data: 0, size: 0 });
  });

  it('reads plain members', () => {
    expect(file.f32(data + 16)).toBeCloseTo(0.5);
    expect(file.i32(data + 24)).toBe(-7);
    expect(file.u8(data + 40)).toBe(2);
    expect(file.bool(data + 40)).toBe(true);
  });

  it('rejects broken tagfiles, 32-bit packfiles and reads outside the data', () => {
    const tagfile = new Uint8Array(72);
    new DataView(tagfile.buffer).setUint32(0, 0xcab00d1e, true);
    new DataView(tagfile.buffer).setUint32(4, 0xd011face, true);
    expect(() => Packfile.parse(tagfile)).toThrow(FormatError);
    const bytes = new PackfileBuilder();
    const small = bytes.object('hkRootLevelContainer', 16);
    const built = bytes.build(small);
    built[16] = 4;
    expect(() => Packfile.parse(built)).toThrow(/32-bit/);
    expect(() => file.i32(1_000_000)).toThrow(FormatError);
  });
});
