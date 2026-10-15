// The interface files the menus load while they play (the font library they import, shared
// components, other movies): Ruffle fetches them by URL, relative to the movie. They are
// served from the game's data on a URL prefix of their own, answered in the page from the
// virtual file system; no network request is made. The font library is built from
// fontconfig.txt (src/ui/font-library.ts).

import { parseFontConfig } from '../formats/swf/fontconfig.ts';
import { readSwf } from '../formats/swf/swf.ts';
import { decodeWindows1252 } from '../formats/text.ts';
import type { Vfs } from '../vfs/vfs.ts';
import { buildFontLibrary } from './font-library.ts';
import { parseTranslations, type Translations } from '../formats/swf/translation.ts';
import { decodeUtf16le } from '../formats/text.ts';
import { translateMovie } from './translate-movie.ts';
import { linkImports } from '../formats/swf/swf-link.ts';
import { patchMovie } from './movie-patches.ts';

/** Where the interface folder is served: a movie's base URL. */
export const INTERFACE_URL = '/@interface/';

const FONT_LIBRARY = 'gfxfontlib.swf';
const FONT_LIBRARY_URL = /gfxfontlib\.swf$/i;

export class InterfaceFiles {
  readonly #vfs: Vfs;
  #fontLibrary: Promise<Uint8Array> | undefined;
  #translations: Promise<Translations> | undefined;
  /** Movies as they play: translated (by path). */
  readonly #movies = new Map<string, Promise<Uint8Array>>();
  readonly #warn: (message: string) => void;
  /** Pictures the engine gives the menus by name (img://Local_Map): PNG bytes. */
  readonly #images = new Map<string, Promise<Uint8Array>>();

  constructor(vfs: Vfs, warn: (message: string) => void) {
    this.#vfs = vfs;
    this.#warn = warn;
  }

  /** A file of the interface folder by its path in it ("Inventory components/ItemCard.swf"). */
  async read(relative: string): Promise<Uint8Array | undefined> {
    const path = relative.replace(/^\/+/, '').replaceAll('/', '\\').toLowerCase();
    if (path === FONT_LIBRARY || path.endsWith(`\\${FONT_LIBRARY}`)) return this.fontLibrary();
    const full = `interface\\${path}`;
    if (!this.#vfs.has(full)) return undefined;
    if (!/\.(swf|gfx)$/.test(path) || path.startsWith('fonts_')) return this.#vfs.read(full);
    let movie = this.#movies.get(path);
    if (!movie) {
      movie = Promise.all([this.#vfs.read(full), this.translations()]).then(
        async ([bytes, table]) => {
          const translated = translateMovie(patchMovie(path, bytes), (text) =>
            table.translate(text),
          );
          // Movies it imports symbols from become part of it: a Flash player loads imports
          // after the frame that places them has run. Of the font library only the fonts it
          // imports come (Ruffle takes seconds to load the whole library as an import, each
          // time a menu opens; Scaleform loads it once).
          return linkImports(
            translated,
            () => true,
            (url) => this.read(url),
            (url) => FONT_LIBRARY_URL.test(url),
          ).catch((error: unknown) => {
            this.#warn(
              `${relative}: its imports are not linked: ${error instanceof Error ? error.message : String(error)}`,
            );
            return translated;
          });
        },
      );
      this.#movies.set(path, movie);
    }
    return movie;
  }

  /** The interface's translations (English; TODO(M13): the game's language setting). */
  translations(): Promise<Translations> {
    this.#translations ??= (async () => {
      const path = 'interface\\translate_english.txt';
      if (!this.#vfs.has(path)) {
        this.#warn(`${path} is missing: menus show their keys`);
        return parseTranslations('');
      }
      return parseTranslations(decodeUtf16le(await this.#vfs.read(path)));
    })();
    return this.#translations;
  }

  /** The menus' font library (built once). */
  fontLibrary(): Promise<Uint8Array> {
    this.#fontLibrary ??= (async () => {
      const config = parseFontConfig(
        decodeWindows1252(await this.#vfs.read('interface\\fontconfig.txt')),
      );
      const libraries = [];
      for (const path of config.libraries) {
        if (this.#vfs.has(path)) libraries.push(readSwf(await this.#vfs.read(path)));
        else this.#warn(`font library ${path} is missing`);
      }
      const shippedPath = `interface\\${FONT_LIBRARY}`;
      const shipped = this.#vfs.has(shippedPath)
        ? readSwf(await this.#vfs.read(shippedPath))
        : undefined;
      const library = buildFontLibrary(config, libraries, shipped);
      if (library.missing.length > 0) {
        this.#warn(`fonts without a font in the libraries: ${library.missing.join(', ')}`);
      }
      return library.movie;
    })();
    return this.#fontLibrary;
  }

  /**
   * A picture the menus load as img://<name> (the engine's render targets in the game): an
   * empty one (transparent, 1×1) where the engine draws under the movie itself.
   */
  emptyImage(name: string): void {
    if (this.#images.has(name.toLowerCase())) return;
    this.#images.set(
      name.toLowerCase(),
      new OffscreenCanvas(1, 1)
        .convertToBlob({ type: 'image/png' })
        .then(async (blob) => new Uint8Array(await blob.arrayBuffer())),
    );
  }

  /**
   * Answers the page's fetches of INTERFACE_URL from these files (Ruffle fetches through
   * window.fetch); other requests pass through. Returns the way back.
   */
  serve(): () => void {
    const original = window.fetch.bind(window);
    const read = (relative: string): Promise<Uint8Array | undefined> => this.read(relative);
    const images = this.#images;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.protocol === 'img:') {
        const image = await images.get(decodeURIComponent(url.href.slice(6)).toLowerCase());
        return image
          ? new Response(image.slice().buffer, {
              status: 200,
              headers: { 'Content-Type': 'image/png', 'Content-Length': String(image.length) },
            })
          : new Response(null, { status: 404, statusText: 'Not Found' });
      }
      if (url.origin !== location.origin || !url.pathname.startsWith(INTERFACE_URL)) {
        return original(input, init);
      }
      const relative = decodeURIComponent(url.pathname.slice(INTERFACE_URL.length));
      const bytes = await read(relative);
      if (!bytes) return new Response(null, { status: 404, statusText: 'Not Found' });
      return new Response(bytes.slice().buffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-shockwave-flash',
          'Content-Length': String(bytes.length),
        },
      });
    };
    return () => {
      window.fetch = original;
    };
  }
}
