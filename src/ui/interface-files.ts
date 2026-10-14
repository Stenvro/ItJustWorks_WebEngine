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

/** Where the interface folder is served: a movie's base URL. */
export const INTERFACE_URL = '/@interface/';

const FONT_LIBRARY = 'gfxfontlib.swf';

export class InterfaceFiles {
  readonly #vfs: Vfs;
  #fontLibrary: Promise<Uint8Array> | undefined;
  readonly #warn: (message: string) => void;

  constructor(vfs: Vfs, warn: (message: string) => void) {
    this.#vfs = vfs;
    this.#warn = warn;
  }

  /** A file of the interface folder by its path in it ("Inventory components/ItemCard.swf"). */
  async read(relative: string): Promise<Uint8Array | undefined> {
    const path = relative.replace(/^\/+/, '').replaceAll('/', '\\').toLowerCase();
    if (path === FONT_LIBRARY || path.endsWith(`\\${FONT_LIBRARY}`)) return this.fontLibrary();
    const full = `interface\\${path}`;
    return this.#vfs.has(full) ? this.#vfs.read(full) : undefined;
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
   * Answers the page's fetches of INTERFACE_URL from these files (Ruffle fetches through
   * window.fetch); other requests pass through. Returns the way back.
   */
  serve(): () => void {
    const original = window.fetch.bind(window);
    const read = (relative: string): Promise<Uint8Array | undefined> => this.read(relative);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
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
