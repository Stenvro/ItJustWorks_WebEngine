// Changes made to a few of the game's movies as they load, where the game draws its own picture
// inside a movie and the browser cannot. The map's local map is the engine's render target in
// the game (img://Local_Map, loaded into LocalMap.LocalMapHolder_mc), drawn by Scaleform over the
// local map's frame: an ornate border (grey) around a black field, at 80% (map.swf: LocalMap's
// unnamed clip below LocalMapHolder_mc). Here the engine draws the local map on its own canvas
// under the menus (src/render/menu-overlay.ts), with that black field under it; the movie keeps
// the border, its black fill made transparent (its DefineShape2 becomes a DefineShape3, every
// black fill alpha 0). A movie whose layout differs (a mod's) is left as it is.
// Platform-independent. Notes: docs/ui.md ("The map").

import { BinaryReader } from '../formats/binary-reader.ts';
import { readPlacement } from '../formats/swf/place-object.ts';
import { readSwf, swfExports, SwfTagCode, type SwfMovie, type SwfTag } from '../formats/swf/swf.ts';
import { concatBytes, encodeTag } from '../formats/swf/swf-writer.ts';

/** DefineShape and DefineShape2: RGB styles. DefineShape3: RGBA. */
const RGB_SHAPES: ReadonlySet<number> = new Set([SwfTagCode.defineShape, 22]);
const DEFINE_SHAPE3 = 32;

/** A movie as the engine plays it: patched where it must be, else the same bytes. */
export function patchMovie(path: string, bytes: Uint8Array): Uint8Array {
  const name = path.toLowerCase().replace(/^.*[\\/]/, '');
  if (name !== 'map.swf') return bytes;
  try {
    return patchLocalMapFrame(bytes) ?? bytes;
  } catch {
    return bytes;
  }
}

/** map.swf: the local map frame's black field made transparent (see above). */
function patchLocalMapFrame(bytes: Uint8Array): Uint8Array | undefined {
  const movie = readSwf(bytes);
  const localMap = swfExports(movie).find((symbol) => symbol.name === 'LocalMap')?.id;
  if (localMap === undefined) return undefined;
  const sprites = new Map<number, SwfTag>();
  const shapes = new Map<number, SwfTag>();
  for (const tag of movie.tags) {
    const id = characterId(movie, tag);
    if (tag.code === SwfTagCode.defineSprite) sprites.set(id, tag);
    if (RGB_SHAPES.has(tag.code)) shapes.set(id, tag);
  }
  // The clips placed under the holder of the local map's picture (not its hit rect).
  const placed = (sprites.get(localMap)?.children ?? [])
    .filter((tag) => tag.code === SwfTagCode.placeObject2 || tag.code === SwfTagCode.placeObject3)
    .map((tag) =>
      readPlacement(movie.bytes.subarray(tag.offset, tag.offset + tag.length), tag.code),
    );
  const holder = placed.find((placement) => placement.name === 'LocalMapHolder_mc');
  if (!holder) return undefined;
  const frames = placed.filter(
    (placement) =>
      placement.depth < holder.depth &&
      placement.name === undefined &&
      placement.character !== undefined,
  );
  const patched = new Map<number, Uint8Array>();
  for (const frame of frames) {
    const sprite = frame.character === undefined ? undefined : sprites.get(frame.character);
    for (const child of sprite?.children ?? []) {
      if (child.code !== SwfTagCode.placeObject2) continue;
      const { character } = readPlacement(
        movie.bytes.subarray(child.offset, child.offset + child.length),
        child.code,
      );
      const shape = character === undefined ? undefined : shapes.get(character);
      if (!shape || character === undefined) continue;
      const body = movie.bytes.subarray(shape.offset, shape.offset + shape.length);
      const clear = withAlpha(body, (rgb) => (rgb[0] + rgb[1] + rgb[2] === 0 ? 0 : 255));
      if (clear) patched.set(character, clear);
    }
  }
  if (patched.size === 0) return undefined;
  const rectBits = 5 + 4 * ((movie.bytes[8] ?? 0) >> 3);
  const header = movie.bytes.subarray(0, 8 + Math.ceil(rectBits / 8) + 4);
  const out = concatBytes([
    header,
    ...movie.tags.map((tag) => {
      const body = patched.get(characterId(movie, tag));
      return RGB_SHAPES.has(tag.code) && body
        ? encodeTag(DEFINE_SHAPE3, body)
        : encodeTag(tag.code, movie.bytes.subarray(tag.offset, tag.offset + tag.length));
    }),
  ]);
  out.set([0x46, 0x57, 0x53], 0);
  new DataView(out.buffer).setUint32(4, out.length, true);
  return out;
}

function characterId(movie: SwfMovie, tag: SwfTag): number {
  return (movie.bytes[tag.offset] ?? 0) | ((movie.bytes[tag.offset + 1] ?? 0) << 8);
}

/**
 * A DefineShape(2)'s body as a DefineShape3's, its solid fills and lines given an alpha by their
 * colour; undefined for a shape with gradient or bitmap fills, or with styles changed midway.
 */
export function withAlpha(
  body: Uint8Array,
  alphaOf: (rgb: readonly [number, number, number]) => number,
): Uint8Array | undefined {
  const rectBits = 5 + 4 * ((body[2] ?? 0) >> 3);
  let at = 2 + Math.ceil(rectBits / 8);
  const parts: Uint8Array[] = [body.subarray(0, at)];
  const reader = new BinaryReader(body, at);
  let fills = reader.u8();
  if (fills === 0xff) fills = reader.u16();
  parts.push(body.subarray(at, reader.offset));
  for (let i = 0; i < fills; i++) {
    const type = reader.u8();
    if (type !== 0) return undefined;
    const rgb = [reader.u8(), reader.u8(), reader.u8()] as const;
    parts.push(Uint8Array.of(type, ...rgb, alphaOf(rgb)));
  }
  at = reader.offset;
  let lines = reader.u8();
  if (lines === 0xff) lines = reader.u16();
  parts.push(body.subarray(at, reader.offset));
  for (let i = 0; i < lines; i++) {
    const width = reader.u16();
    const rgb = [reader.u8(), reader.u8(), reader.u8()] as const;
    parts.push(Uint8Array.of(width & 0xff, width >> 8, ...rgb, alphaOf(rgb)));
  }
  // The shape records (their style changes in a DefineShape2 carry no new styles here: a
  // record with them would hold RGB colours, read as RGBA in a DefineShape3).
  const records = body.subarray(reader.offset);
  if (hasNewStyles(records)) return undefined;
  parts.push(records);
  return concatBytes(parts);
}

/** Whether shape records change their styles midway (StyleChangeRecord's NewStyles). */
function hasNewStyles(records: Uint8Array): boolean {
  let bit = 0;
  const read = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = value * 2 + (((records[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return value;
  };
  const signed = (count: number): void => {
    read(count);
  };
  const fillBits = read(4);
  const lineBits = read(4);
  for (;;) {
    if (bit >> 3 >= records.length) return false;
    if (read(1) === 0) {
      const flags = read(5);
      if (flags === 0) return false;
      if (flags & 0x10) return true;
      if (flags & 0x01) signed(read(5) * 2);
      if (flags & 0x02) read(fillBits);
      if (flags & 0x04) read(fillBits);
      if (flags & 0x08) read(lineBits);
    } else if (read(1) === 1) {
      const size = read(4) + 2;
      if (read(1) === 1) signed(size * 2);
      else {
        read(1);
        signed(size);
      }
    } else {
      signed((read(4) + 2) * 4);
    }
  }
}
