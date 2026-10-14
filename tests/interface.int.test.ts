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
