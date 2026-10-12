import { describe, expect, it } from 'vitest';
import { parseVmad, referencedForms } from './vmad.ts';

/** Little-endian byte builder for synthetic VMAD fields. */
class Bytes {
  readonly #out: number[] = [];

  u8(value: number): this {
    this.#out.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value).u8(value >> 8);
  }

  u32(value: number): this {
    return this.u16(value & 0xffff).u16(value >>> 16);
  }

  f32(value: number): this {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) this.u8(view.getUint8(i));
    return this;
  }

  wstring(text: string): this {
    this.u16(text.length);
    for (const char of text) this.u8(char.charCodeAt(0));
    return this;
  }

  /** Object value in object format 2: unused, alias, form id. */
  object(formId: number, alias = -1): this {
    return this.u16(0)
      .u16(alias & 0xffff)
      .u32(formId);
  }

  get data(): Uint8Array {
    return Uint8Array.from(this.#out);
  }
}

/** Header (version 5, object format 2) and one script with the given properties. */
function script(bytes: Bytes, name: string, properties: (b: Bytes) => number): Bytes {
  bytes.wstring(name).u8(0);
  const countAt = bytes.data.length;
  bytes.u16(0);
  const count = properties(bytes);
  const data = bytes.data;
  data[countAt] = count;
  const rebuilt = new Bytes();
  for (const byte of data) rebuilt.u8(byte);
  return rebuilt;
}

describe('VMAD', () => {
  it('reads script properties of every type', () => {
    let bytes = new Bytes().u16(5).u16(2).u16(1);
    bytes = script(bytes, 'HousePurchaseScript', (b) => {
      b.wstring('Marker').u8(1).u8(1).object(0x01000abc);
      b.wstring('Name').u8(2).u8(1).wstring('Breezehome');
      b.wstring('Cost').u8(3).u8(1).u32(5000);
      b.wstring('Scale').u8(4).u8(1).f32(1.5);
      b.wstring('Owned').u8(5).u8(1).u8(1);
      b.wstring('Rooms').u8(11).u8(1).u32(2).object(0x10).object(0);
      b.wstring('Tags').u8(12).u8(1).u32(1).wstring('a');
      b.wstring('Ints').u8(13).u8(1).u32(2).u32(1).u32(0xffffffff);
      b.wstring('Floats').u8(14).u8(1).u32(1).f32(0.25);
      b.wstring('Flags').u8(15).u8(1).u32(2).u8(0).u8(1);
      return 10;
    });
    const vmad = parseVmad(bytes.data, 'ACTI');
    expect(vmad.version).toBe(5);
    expect(vmad.fragmentScript).toBeUndefined();
    const [attached] = vmad.scripts;
    expect(attached?.name).toBe('HousePurchaseScript');
    expect(attached?.properties.map((p) => [p.name, p.value.value])).toEqual([
      ['Marker', { formId: 0x01000abc, alias: -1 }],
      ['Name', 'Breezehome'],
      ['Cost', 5000],
      ['Scale', 1.5],
      ['Owned', true],
      [
        'Rooms',
        [
          { formId: 0x10, alias: -1 },
          { formId: 0, alias: -1 },
        ],
      ],
      ['Tags', ['a']],
      ['Ints', [1, -1]],
      ['Floats', [0.25]],
      ['Flags', [false, true]],
    ]);
    expect(attached && referencedForms(attached)).toEqual([0x01000abc, 0x10]);
  });

  it('reads the fragment script of a dialogue response', () => {
    let bytes = new Bytes().u16(5).u16(2).u16(1);
    bytes = script(bytes, 'TIF__000C6E1F', (b) => {
      b.wstring('DiningRoom').u8(1).u8(1).object(0x11);
      return 1;
    });
    bytes.u8(2).u8(0b01).wstring('TIF__000C6E1F');
    bytes.u8(0).wstring('TIF__000C6E1F').wstring('Fragment_0');
    const vmad = parseVmad(bytes.data, 'INFO');
    expect(vmad.fragmentScript).toBe('TIF__000C6E1F');
    expect(vmad.fragments).toEqual([
      { stage: 'begin', logEntry: 0, script: 'TIF__000C6E1F', function: 'Fragment_0' },
    ]);
  });

  it('reads quest stage fragments and alias scripts', () => {
    let bytes = new Bytes().u16(5).u16(2).u16(1);
    bytes = script(bytes, 'QF_MS11_0001F7A3', (b) => {
      b.wstring('Chest').u8(1).u8(1).object(0x22);
      return 1;
    });
    bytes.u8(2).u16(1).wstring('QF_MS11_0001F7A3');
    bytes.u16(10).u16(0).u32(2).u8(1).wstring('QF_MS11_0001F7A3').wstring('Fragment_3');
    bytes.u16(1).object(0, 4).u16(5).u16(2).u16(1);
    bytes = script(bytes, 'AliasScript', (b) => {
      b.wstring('Target').u8(1).u8(1).object(0x33);
      return 1;
    });
    const vmad = parseVmad(bytes.data, 'QUST');
    expect(vmad.fragmentScript).toBe('QF_MS11_0001F7A3');
    expect(vmad.fragments).toEqual([
      { stage: 10, logEntry: 2, script: 'QF_MS11_0001F7A3', function: 'Fragment_3' },
    ]);
    expect(vmad.aliases).toEqual([
      {
        alias: 4,
        scripts: [
          {
            name: 'AliasScript',
            properties: [
              { name: 'Target', value: { type: 'object', value: { formId: 0x33, alias: -1 } } },
            ],
          },
        ],
      },
    ]);
  });

  it('rejects unknown versions and property types', () => {
    expect(() => parseVmad(new Bytes().u16(9).u16(2).u16(0).data, 'ACTI')).toThrow();
    let bytes = new Bytes().u16(5).u16(2).u16(1);
    bytes = script(bytes, 'S', (b) => {
      b.wstring('Struct').u8(6).u8(1);
      return 1;
    });
    expect(() => parseVmad(bytes.data, 'ACTI')).toThrow(/property type 6/);
  });
});
