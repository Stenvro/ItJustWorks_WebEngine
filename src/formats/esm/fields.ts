// Typed access to a record's fields.

import { FormatError } from '../binary-reader.ts';
import { decodeGameText } from '../text.ts';
import type { Field } from './record.ts';

export class Fields {
  readonly list: readonly Field[];

  constructor(list: readonly Field[]) {
    this.list = list;
  }

  first(type: string): Uint8Array | undefined {
    return this.list.find((field) => field.type === type)?.data;
  }

  all(type: string): Uint8Array[] {
    return this.list.filter((field) => field.type === type).map((field) => field.data);
  }

  has(type: string): boolean {
    return this.list.some((field) => field.type === type);
  }

  /** Null-terminated string field. */
  zstring(type: string): string | undefined {
    const data = this.first(type);
    return data && zstring(data);
  }

  u32(type: string): number | undefined {
    const data = this.first(type);
    return data && data.length >= 4 ? view(data).getUint32(0, true) : undefined;
  }

  f32(type: string): number | undefined {
    const data = this.first(type);
    return data && data.length >= 4 ? view(data).getFloat32(0, true) : undefined;
  }
}

export function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function zstring(data: Uint8Array): string {
  const end = data.indexOf(0);
  return decodeGameText(data, 0, end < 0 ? data.length : end);
}

/** Throws a FormatError unless `data` has at least `size` bytes. */
export function requireSize(data: Uint8Array, size: number, what: string): DataView {
  if (data.length < size)
    throw new FormatError(`${what}: ${data.length} bytes, expected ${size}`, 0);
  return view(data);
}
