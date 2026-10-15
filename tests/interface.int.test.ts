// Integration test: the game's interface movies as the engine plays them, on the local game
// data: each menu translated (its translation keys replaced) and with the engine's bridge in
// its first frame still reads, and every branch and function of its ActionScript still lands
// on an action. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeAvm1 } from '../src/formats/swf/avm1.ts';
import { parseFontConfig } from '../src/formats/swf/fontconfig.ts';
import {
  allTags,
  readSwf,
  swfImports,
  SwfTagCode,
  tagBody,
  type SwfMovie,
} from '../src/formats/swf/swf.ts';
import { parseTranslations, type Translations } from '../src/formats/swf/translation.ts';
import { decodeUtf16le, decodeWindows1252 } from '../src/formats/text.ts';
import { buildFontLibrary } from '../src/ui/font-library.ts';
import { withBridge } from '../src/ui/menu-bridge.ts';
import { translateMovie } from '../src/ui/translate-movie.ts';
import { linkImports } from '../src/formats/swf/swf-link.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

/** Every action block of a movie: its branch targets and function ends that miss an action. */
function strayBranches(movie: SwfMovie): number {
  let stray = 0;
  for (const tag of allTags(movie.tags)) {
    if (tag.code !== SwfTagCode.doAction && tag.code !== SwfTagCode.doInitAction) continue;
    const body = tagBody(movie, tag);
    const code = tag.code === SwfTagCode.doInitAction ? body.subarray(2) : body;
    const actions = decodeAvm1(code, movie.header.version);
    const starts = new Set([...actions.map((action) => action.offset), code.length]);
    for (const action of actions) {
      if (action.target !== undefined && !starts.has(action.target)) stray++;
      if (action.bodyEnd !== undefined && !starts.has(action.bodyEnd)) stray++;
    }
  }
  return stray;
}

describe.skipIf(!hasGamedata())('the interface movies on the local game data', () => {
  let vfs: Vfs;
  let translations: Translations;
  let menus: string[];

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    translations = parseTranslations(
      decodeUtf16le(await vfs.read('interface\\translate_english.txt')),
    );
    menus = vfs
      .list('interface')
      .filter((path) => /\.swf$/i.test(path) && !/\\(fonts_|gfxfontlib)/i.test(path));
  }, 60_000);
  afterAll(async () => {
    await vfs.close();
  });

  it('reads the English translations', () => {
    expect(translations.size).toBeGreaterThan(800);
    expect(translations.translate('$NEW')).toBe('NEW');
  });

  it('translates every menu without breaking its scripts', async () => {
    const broken: string[] = [];
    for (const path of menus) {
      const original = readSwf(await vfs.read(path));
      const translated = readSwf(
        translateMovie(original.bytes, (text) => translations.translate(text)),
      );
      expect(translated.tags.length).toBe(original.tags.length);
      if (strayBranches(original) !== 0 || strayBranches(translated) !== 0) broken.push(path);
      readSwf(withBridge(translated.bytes, 'test'));
    }
    expect(broken).toEqual([]);
  }, 120_000);

  it('leaves no key of the start menu untranslated', async () => {
    const movie = readSwf(
      translateMovie(await vfs.read('interface\\startmenu.swf'), (text) =>
        translations.translate(text),
      ),
    );
    const strings = new Set<string>();
    for (const tag of allTags(movie.tags)) {
      if (tag.code !== SwfTagCode.doAction && tag.code !== SwfTagCode.doInitAction) continue;
      const body = tagBody(movie, tag);
      for (const action of decodeAvm1(
        tag.code === SwfTagCode.doInitAction ? body.subarray(2) : body,
        movie.header.version,
      )) {
        for (const text of action.pool ?? []) strings.add(text);
      }
    }
    expect(strings.has('NEW')).toBe(true);
    expect([...strings].filter((text) => translations.translate(text) !== undefined)).toEqual([]);
  });

  it('leaves no translation key as a string in any menu, clip actions included', async () => {
    const left = new Map<string, string[]>();
    for (const path of menus) {
      const movie = readSwf(
        translateMovie(await vfs.read(path), (text) => translations.translate(text)),
      );
      // Every null-terminated string in the movie's tags that is a key.
      const bytes = movie.bytes;
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 0) continue;
        if (i > start && bytes[start] === 0x24) {
          const text = new TextDecoder().decode(bytes.subarray(start, i));
          if (translations.translate(text) !== undefined) {
            left.set(path, [...(left.get(path) ?? []), text]);
          }
        }
        start = i + 1;
      }
    }
    expect(Object.fromEntries(left)).toEqual({});
  }, 120_000);

  it("links the menus' imported parts: every placed character is defined, no import left", async () => {
    const BACKSLASH = String.fromCharCode(92);
    const read = async (url: string): Promise<Uint8Array | undefined> => {
      const path = `interface${BACKSLASH}${url.replaceAll('/', BACKSLASH)}`.toLowerCase();
      return vfs.has(path) ? vfs.read(path) : undefined;
    };
    const problems: string[] = [];
    let linked = 0;
    for (const path of menus) {
      const original = readSwf(await vfs.read(path));
      const parts = swfImports(original).filter((entry) => !/gfxfontlib.swf$/i.test(entry.url));
      if (parts.length === 0) continue;
      linked++;
      const movie = readSwf(
        await linkImports(original.bytes, (url) => !/gfxfontlib.swf$/i.test(url), read),
      );
      const left = swfImports(movie).filter((entry) => !/gfxfontlib.swf$/i.test(entry.url));
      if (left.length > 0) problems.push(`${path}: imports left`);
      // Every character id a placement names is defined (or imported from the font library).
      const defined = new Set<number>();
      for (const tag of movie.tags) {
        const body = tagBody(movie, tag);
        if (tag.code === SwfTagCode.importAssets2) {
          for (const entry of swfImports({ ...movie, tags: [tag] }))
            for (const symbol of entry.symbols) defined.add(symbol.id);
        } else if (tag.code !== SwfTagCode.exportAssets && tag.code !== SwfTagCode.doInitAction) {
          if (body.length >= 2) defined.add((body[0] ?? 0) | ((body[1] ?? 0) << 8));
        }
      }
      for (const tag of allTags(movie.tags)) {
        if (tag.code !== SwfTagCode.placeObject2) continue;
        const body = tagBody(movie, tag);
        if (((body[0] ?? 0) & 0x02) === 0) continue;
        const id = (body[3] ?? 0) | ((body[4] ?? 0) << 8);
        if (!defined.has(id)) problems.push(`${path}: character ${String(id)} placed, not defined`);
      }
    }
    expect(linked).toBeGreaterThan(4);
    expect(problems.slice(0, 10)).toEqual([]);
  }, 120_000);

  it("links every menu with its fonts in it: no import left, each text field's font defined", async () => {
    // As InterfaceFiles serves the menus: their parts linked whole (each with its own fonts
    // first), the font library by the fonts imported.
    const BACKSLASH = String.fromCharCode(92);
    const config = parseFontConfig(decodeWindows1252(await vfs.read('interface\\fontconfig.txt')));
    const library = buildFontLibrary(
      config,
      await Promise.all(config.libraries.map(async (path) => readSwf(await vfs.read(path)))),
      readSwf(await vfs.read('interface\\gfxfontlib.swf')),
    ).movie;
    const isFontLibrary = (url: string): boolean => /gfxfontlib\.swf$/i.test(url);
    const serve = async (url: string): Promise<Uint8Array | undefined> => {
      if (isFontLibrary(url)) return library;
      const path = `interface${BACKSLASH}${url.replaceAll('/', BACKSLASH)}`.toLowerCase();
      if (!vfs.has(path)) return undefined;
      return linkImports(await vfs.read(path), () => true, serve, isFontLibrary);
    };
    const fontCodes = new Set<number>([
      10,
      SwfTagCode.defineFont2,
      SwfTagCode.defineFont3,
      SwfTagCode.defineFont4,
    ]);
    const problems: string[] = [];
    let fields = 0;
    for (const path of menus) {
      const bytes = await serve(path.slice('interface\\'.length));
      if (!bytes) continue;
      const movie = readSwf(bytes);
      if (swfImports(movie).length > 0) problems.push(`${path}: imports left`);
      const fonts = new Set<number>();
      for (const tag of movie.tags) {
        const body = tagBody(movie, tag);
        if (fontCodes.has(tag.code)) fonts.add((body[0] ?? 0) | ((body[1] ?? 0) << 8));
      }
      for (const tag of allTags(movie.tags)) {
        if (tag.code !== SwfTagCode.defineEditText) continue;
        // DefineEditText: id, bounds, flags; HasFont (0x01 of the first flags byte): its font.
        const body = tagBody(movie, tag);
        const flagsAt = 2 + Math.ceil((5 + 4 * ((body[2] ?? 0) >> 3)) / 8);
        if (((body[flagsAt] ?? 0) & 0x01) === 0) continue;
        fields++;
        const id = (body[flagsAt + 2] ?? 0) | ((body[flagsAt + 3] ?? 0) << 8);
        if (!fonts.has(id)) problems.push(`${path}: a text field's font ${String(id)} is missing`);
      }
    }
    expect(fields).toBeGreaterThan(100);
    expect(problems.slice(0, 10)).toEqual([]);
  }, 120_000);

  it('builds a font library with every font name a menu imports', async () => {
    const config = parseFontConfig(decodeWindows1252(await vfs.read('interface\\fontconfig.txt')));
    const libraries = await Promise.all(
      config.libraries.map(async (path) => readSwf(await vfs.read(path))),
    );
    const library = buildFontLibrary(
      config,
      libraries,
      readSwf(await vfs.read('interface\\gfxfontlib.swf')),
    );
    const asked = new Set<string>();
    for (const path of menus) {
      for (const entry of swfImports(readSwf(await vfs.read(path)))) {
        if (/gfxfontlib\.swf$/i.test(entry.url))
          for (const symbol of entry.symbols) asked.add(symbol.name);
      }
    }
    expect([...asked].filter((name) => !library.fonts.has(name))).toEqual([]);
  }, 60_000);
});
