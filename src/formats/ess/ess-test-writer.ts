// Writes synthetic .ess files for the tests (no real save is ever in the repo): the same
// layout readEss reads (docs/formats/ess.md), the body as one LZ4 block of literals.

export class EssWriter {
  readonly #bytes: number[] = [];

  get length(): number {
    return this.#bytes.length;
  }

  u8(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value).u8(value >>> 8);
  }

  u32(value: number): this {
    return this.u16(value & 0xffff).u16(value >>> 16);
  }

  i32(value: number): this {
    return this.u32(value >>> 0);
  }

  f32(value: number): this {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return this.u32(view.getUint32(0, true));
  }

  u64(value: bigint): this {
    return this.u32(Number(value & 0xffffffffn)).u32(Number(value >> 32n));
  }

  bytes(bytes: ArrayLike<number>): this {
    for (const byte of Array.from(bytes)) this.u8(byte);
    return this;
  }

  wstring(text: string): this {
    this.u16(text.length);
    for (let i = 0; i < text.length; i++) this.u8(text.charCodeAt(i));
    return this;
  }

  vsval(value: number): this {
    if (value < 0x40) return this.u8(value << 2);
    if (value < 0x4000) return this.u16((value << 2) | 1);
    return this.u32(((value << 2) | 2) >>> 0);
  }

  /** A reference id: kind (RefIdKind) and value. */
  refId(kind: number, value: number): this {
    const raw = ((kind << 22) | (value & 0x3fffff)) >>> 0;
    return this.u8(raw >>> 16)
      .u8(raw >>> 8)
      .u8(raw);
  }

  done(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

/** One LZ4 block that is only literals (a valid block: the last sequence has no match). */
export function lz4Literals(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  const length = data.length;
  out.push(Math.min(length, 15) << 4);
  if (length >= 15) {
    let rest = length - 15;
    while (rest >= 255) {
      out.push(255);
      rest -= 255;
    }
    out.push(rest);
  }
  for (const byte of data) out.push(byte);
  return Uint8Array.from(out);
}

export interface SyntheticChangeForm {
  readonly refId: readonly [number, number];
  readonly flags: number;
  readonly type: number;
  readonly data: Uint8Array;
  /** zlib-compressed data and its uncompressed length, if compressed. */
  readonly compressed?: { readonly bytes: Uint8Array; readonly length: number };
}

export interface SyntheticSave {
  readonly playerName: string;
  readonly playerLevel: number;
  readonly location: string;
  readonly plugins: readonly string[];
  readonly lightPlugins?: readonly string[];
  readonly globalData1: readonly { readonly type: number; readonly data: Uint8Array }[];
  readonly globalData2?: readonly { readonly type: number; readonly data: Uint8Array }[];
  readonly globalData3: readonly { readonly type: number; readonly data: Uint8Array }[];
  readonly changeForms: readonly SyntheticChangeForm[];
  readonly formIds: readonly number[];
  /** Write table 3's count one short, as the game does. */
  readonly shortTable3Count?: boolean;
}

export function writeSyntheticEss(save: SyntheticSave): Uint8Array {
  const body = new EssWriter().u8(78);
  const plugins = new EssWriter().u8(save.plugins.length);
  for (const name of save.plugins) plugins.wstring(name);
  plugins.u16(save.lightPlugins?.length ?? 0);
  for (const name of save.lightPlugins ?? []) plugins.wstring(name);
  const pluginBytes = plugins.done();
  body.u32(pluginBytes.length).bytes(pluginBytes);
  const table2 = save.globalData2 ?? [];
  body
    .u32(0)
    .u32(0)
    .u32(0)
    .u32(0)
    .u32(0)
    .u32(0)
    .u32(save.globalData1.length)
    .u32(table2.length)
    .u32(save.globalData3.length - (save.shortTable3Count ? 1 : 0))
    .u32(save.changeForms.length);
  for (let i = 0; i < 15; i++) body.u32(0);
  const global = (entry: { type: number; data: Uint8Array }): void => {
    body.u32(entry.type).u32(entry.data.length).bytes(entry.data);
  };
  save.globalData1.forEach(global);
  table2.forEach(global);
  for (const form of save.changeForms) {
    const stored = form.compressed?.bytes ?? form.data;
    const size = Math.max(stored.length, form.compressed?.length ?? 0);
    const lengthSize = size < 0x100 ? 0 : size < 0x10000 ? 1 : 2;
    body
      .refId(form.refId[0], form.refId[1])
      .u32(form.flags)
      .u8((lengthSize << 6) | form.type);
    body.u8(0);
    const length = (value: number): void => {
      if (lengthSize === 0) body.u8(value);
      else if (lengthSize === 1) body.u16(value);
      else body.u32(value);
    };
    length(stored.length);
    length(form.compressed?.length ?? 0);
    body.bytes(stored);
  }
  save.globalData3.forEach(global);
  body.u32(save.formIds.length);
  for (const id of save.formIds) body.u32(id);
  body.u32(0); // visited worldspaces
  body.u32(4).u32(0); // unknown table 3
  const plain = body.done();
  const compressed = lz4Literals(plain);

  const header = new EssWriter()
    .u32(12)
    .u32(7)
    .wstring(save.playerName)
    .u32(save.playerLevel)
    .wstring(save.location)
    .wstring('000.08.00')
    .wstring('NordRace')
    .u16(0)
    .f32(10)
    .f32(200)
    .u64(133000000000000000n)
    .u32(2)
    .u32(1)
    .u16(2)
    .done();
  const file = new EssWriter().bytes(Array.from('TESV_SAVEGAME', (c) => c.charCodeAt(0)));
  file.u32(header.length).bytes(header);
  file.bytes([1, 2, 3, 4, 5, 6, 7, 8]); // a 2x1 RGBA screenshot
  file.u32(plain.length).u32(compressed.length).bytes(compressed);
  return file.done();
}
