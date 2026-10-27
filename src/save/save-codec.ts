// The save file's container (docs/formats/save.md): a small header anyone can read without
// unpacking the rest (for the save list), a thumbnail, and the game's state as tagged JSON,
// deflated. The tagged JSON keeps what plain JSON loses: Maps, Sets, typed arrays, undefined,
// non-finite numbers and the Papyrus values (object handles, arrays).
// Platform-independent but for CompressionStream (browsers and Node alike).

import { ObjectHandle, PapyrusArray } from '../scripting/values.ts';

/** "IJWS": the file's magic. */
const MAGIC = 0x53574a49;
/** The container's version: bumped when its layout or the body's schema changes. */
export const SAVE_VERSION = 1;

/** What the save list shows of a save (the original's save header, in our words). */
export interface SaveHeader {
  readonly version: number;
  /** The save's name (its key in the store): "Save 3", "Quicksave", "Autosave 1". */
  readonly name: string;
  readonly kind: 'save' | 'quicksave' | 'autosave';
  /** Its number in the list (the original numbers saves as they are made). */
  readonly number: number;
  readonly playerName: string;
  readonly playerLevel: number;
  /** Where the player is (the location's or cell's name). */
  readonly location: string;
  /** Game days passed. */
  readonly gameDays: number;
  /** Real milliseconds since 1970 when it was made. */
  readonly realTime: number;
  /** The plugins it was made with, in load order (a load warns about missing ones). */
  readonly plugins: readonly string[];
}

export interface SaveFile {
  readonly header: SaveHeader;
  /** A small JPEG of the screen (empty for none). */
  readonly thumbnail: Uint8Array;
  readonly body: unknown;
}

// --- Tagged values ------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const TYPED = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
} as const;
type TypedName = keyof typeof TYPED;

function typedName(value: ArrayBufferView): TypedName | undefined {
  for (const [name, type] of Object.entries(TYPED) as [TypedName, (typeof TYPED)[TypedName]][]) {
    if (value instanceof type) return name;
  }
  return undefined;
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * A value as tagged JSON. Functions and class instances other than the known ones are an
 * error (state the save would silently lose): `where` names the path for the message.
 */
export function encodeValue(value: unknown, where = '$'): Json {
  if (value === null) return null;
  if (value === undefined) return { $u: 1 };
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    return { $n: String(value) };
  }
  if (typeof value === 'bigint') return { $b: value.toString() };
  if (Array.isArray(value))
    return value.map((item, i) => encodeValue(item, `${where}[${String(i)}]`));
  if (value instanceof Map) {
    return {
      $m: [...value].map(([key, item], i) => [
        encodeValue(key, `${where}<key ${String(i)}>`),
        encodeValue(item, `${where}<${String(key)}>`),
      ]),
    };
  }
  if (value instanceof Set) {
    return { $s: [...value].map((item, i) => encodeValue(item, `${where}{${String(i)}}`)) };
  }
  if (value instanceof ObjectHandle) return { $h: [value.formId, value.type, value.alias] };
  if (value instanceof PapyrusArray) {
    return { $a: value.items.map((item, i) => encodeValue(item, `${where}[${String(i)}]`)) };
  }
  if (ArrayBuffer.isView(value)) {
    const name = typedName(value);
    if (!name) throw new Error(`save: ${where} is a ${value.constructor.name}`);
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { $t: name, d: toBase64(bytes) };
  }
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`save: ${where} is a ${(value as object).constructor.name}`);
    }
    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = encodeValue(item, `${where}.${key}`);
    }
    // A plain object whose own keys could read as a tag is wrapped.
    return Object.keys(out).some((key) => key.startsWith('$')) ? { $o: out } : out;
  }
  throw new Error(`save: ${where} is a ${typeof value}`);
}

export function decodeValue(json: unknown): unknown {
  if (json === null || typeof json !== 'object') return json;
  if (Array.isArray(json)) return json.map(decodeValue);
  const tagged = json as { [key: string]: unknown };
  if ('$u' in tagged) return undefined;
  if ('$n' in tagged) return Number(tagged.$n);
  if ('$b' in tagged) return BigInt(String(tagged.$b));
  if ('$m' in tagged) {
    return new Map(
      (tagged.$m as unknown[][]).map(([key, item]) => [decodeValue(key), decodeValue(item)]),
    );
  }
  if ('$s' in tagged) return new Set((tagged.$s as unknown[]).map(decodeValue));
  if ('$h' in tagged) {
    const [formId, type, alias] = tagged.$h as [number, string, number];
    return new ObjectHandle(formId, type, alias);
  }
  if ('$a' in tagged) {
    return new PapyrusArray((tagged.$a as unknown[]).map(decodeValue) as PapyrusArray['items']);
  }
  if ('$t' in tagged) {
    const bytes = fromBase64(String(tagged.d));
    const type = TYPED[tagged.$t as TypedName];
    const copy = new Uint8Array(bytes);
    return new type(copy.buffer, 0, copy.byteLength / type.BYTES_PER_ELEMENT);
  }
  const plain = '$o' in tagged ? (tagged.$o as { [key: string]: unknown }) : tagged;
  const out: { [key: string]: unknown } = {};
  for (const [key, item] of Object.entries(plain)) out[key] = decodeValue(item);
  return out;
}

// --- The container -------------------------------------------------------------------------

async function transform(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const source = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

/**
 * The save file: "IJWS", u32 version, u32 header length, header (UTF-8 JSON), u32 thumbnail
 * length, thumbnail, then the body as tagged JSON, deflated (raw deflate), to the end.
 */
export async function writeSave(file: SaveFile): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const header = encoder.encode(JSON.stringify(file.header));
  const body = await transform(
    encoder.encode(JSON.stringify(encodeValue(file.body))),
    new CompressionStream('deflate-raw'),
  );
  const out = new Uint8Array(16 + header.length + file.thumbnail.length + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, SAVE_VERSION, true);
  view.setUint32(8, header.length, true);
  out.set(header, 12);
  let at = 12 + header.length;
  view.setUint32(at, file.thumbnail.length, true);
  out.set(file.thumbnail, at + 4);
  at += 4 + file.thumbnail.length;
  out.set(body, at);
  return out;
}

function readParts(bytes: Uint8Array): {
  header: SaveHeader;
  thumbnail: Uint8Array;
  body: Uint8Array;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || view.getUint32(0, true) !== MAGIC) throw new Error('not a save file');
  const version = view.getUint32(4, true);
  if (version > SAVE_VERSION) {
    throw new Error(`save version ${String(version)} is newer than this engine's`);
  }
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(12, 12 + headerLength)),
  ) as SaveHeader;
  let at = 12 + headerLength;
  const thumbnailLength = view.getUint32(at, true);
  const thumbnail = bytes.slice(at + 4, at + 4 + thumbnailLength);
  at += 4 + thumbnailLength;
  return { header, thumbnail, body: bytes.subarray(at) };
}

/** The header and thumbnail alone (the save list). */
export function readSaveHeader(bytes: Uint8Array): { header: SaveHeader; thumbnail: Uint8Array } {
  const { header, thumbnail } = readParts(bytes);
  return { header, thumbnail };
}

export async function readSave(bytes: Uint8Array): Promise<SaveFile> {
  const { header, thumbnail, body } = readParts(bytes);
  const json = await transform(body, new DecompressionStream('deflate-raw'));
  return { header, thumbnail, body: decodeValue(JSON.parse(new TextDecoder().decode(json))) };
}
