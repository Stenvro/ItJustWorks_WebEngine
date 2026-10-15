import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../binary-reader.ts';
import { linkImports } from './swf-link.ts';
import { readSwf, readSwfString, SwfTagCode, tagBody } from './swf.ts';
import { concatBytes, encodeSwfString, u16Bytes, writeSwf } from './swf-writer.ts';

const DEFINE_FONT_NAME = 88;

/** A font definition the linker carries whole: its id, then bytes it does not read. */
const font = (id: number): { code: number; body: Uint8Array } => ({
  code: SwfTagCode.defineFont3,
  body: concatBytes([u16Bytes(id), Uint8Array.of(0, 0, 0)]),
});

const symbols = (entries: readonly (readonly [number, string])[]): Uint8Array =>
  concatBytes([
    u16Bytes(entries.length),
    ...entries.flatMap(([id, name]) => [u16Bytes(id), encodeSwfString(name)]),
  ]);

/** A font library: fonts 1 ($A) and 2 ($B), named and exported. */
const LIBRARY = writeSwf([
  font(1),
  { code: DEFINE_FONT_NAME, body: concatBytes([u16Bytes(1), encodeSwfString('$A')]) },
  font(2),
  { code: DEFINE_FONT_NAME, body: concatBytes([u16Bytes(2), encodeSwfString('$B')]) },
  {
    code: SwfTagCode.exportAssets,
    body: symbols([
      [1, '$A'],
      [2, '$B'],
    ]),
  },
]);

/** A menu importing $A from the library as its character 7. */
const MENU = writeSwf([
  {
    code: SwfTagCode.importAssets2,
    body: concatBytes([
      encodeSwfString('gfxfontlib.swf'),
      Uint8Array.of(1, 0),
      symbols([[7, '$A']]),
    ]),
  },
  { code: SwfTagCode.showFrame, body: new Uint8Array(0) },
]);

/** The ids the movie's tags of a code define or name first. */
function ids(bytes: Uint8Array, code: number): number[] {
  const movie = readSwf(bytes);
  return movie.tags
    .filter((tag) => tag.code === code)
    .map((tag) => new BinaryReader(tagBody(movie, tag)).u16());
}

function exports(bytes: Uint8Array): string[] {
  const movie = readSwf(bytes);
  const names: string[] = [];
  for (const tag of movie.tags.filter((entry) => entry.code === SwfTagCode.exportAssets)) {
    const reader = new BinaryReader(tagBody(movie, tag));
    const count = reader.u16();
    for (let i = 0; i < count; i++) {
      const id = reader.u16();
      names.push(`${String(id)} ${readSwfString(reader, movie.header.version)}`);
    }
  }
  return names;
}

describe('linking imports', () => {
  const source = (url: string): Promise<Uint8Array | undefined> =>
    Promise.resolve(url === 'gfxfontlib.swf' ? LIBRARY : undefined);

  it('brings the whole imported movie, the symbol taking the id the import gave it', async () => {
    const linked = await linkImports(MENU, () => true, source);
    expect(ids(linked, SwfTagCode.importAssets2)).toEqual([]);
    expect(ids(linked, SwfTagCode.defineFont3)).toEqual([7, 8]);
    expect(exports(linked)).toEqual(['7 $A', '8 $B']);
  });

  it('brings only the symbols imported where the library is linked by its symbols', async () => {
    const linked = await linkImports(
      MENU,
      () => true,
      source,
      (url) => url === 'gfxfontlib.swf',
    );
    expect(ids(linked, SwfTagCode.importAssets2)).toEqual([]);
    expect(ids(linked, SwfTagCode.defineFont3)).toEqual([7]);
    expect(ids(linked, DEFINE_FONT_NAME)).toEqual([7]);
    expect(exports(linked)).toEqual(['7 $A']);
  });

  it('leaves the imports it is not to link', async () => {
    const linked = await linkImports(MENU, () => false, source);
    expect(ids(linked, SwfTagCode.defineFont3)).toEqual([]);
    expect(readSwf(linked).tags.some((tag) => tag.code === SwfTagCode.importAssets2)).toBe(true);
  });
});
