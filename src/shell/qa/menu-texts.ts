// The QA harness's menu check (docs/qa.md, placeholder-text): a text field of an open menu that
// shows, visible, the placeholder its movie was authored with ("Dialogue Line 1") — a field
// neither the menu's code nor the engine set. The candidates are the movie's named text fields
// whose authored text is a placeholder (src/formats/swf/edit-text.ts; tools/menu-placeholders.ts
// lists them); each is read by its path while the menu is open.

import {
  isPlaceholder,
  plainText,
  textFieldPaths,
  textKey,
  type TextFieldPath,
} from '../../formats/swf/edit-text.ts';
import { readSwf } from '../../formats/swf/swf.ts';
import type { Menu } from '../../ui/menu-host.ts';
import type { Vfs } from '../../vfs/vfs.ts';

/** A placeholder seen on screen. */
export interface ShownPlaceholder {
  readonly movie: string;
  readonly path: string;
  readonly text: string;
}

export class MenuTextWatch {
  readonly #candidates = new Map<string, TextFieldPath[] | undefined>();

  /** A movie's placeholder fields (read once; none until read). */
  #of(vfs: Vfs, movie: string): TextFieldPath[] | undefined {
    if (this.#candidates.has(movie)) return this.#candidates.get(movie);
    this.#candidates.set(movie, undefined);
    void vfs
      .read(`interface\\${movie}`)
      .then((bytes) => {
        this.#candidates.set(
          movie,
          textFieldPaths(readSwf(bytes)).filter(({ field }) => isPlaceholder(plainText(field))),
        );
      })
      .catch(() => {
        this.#candidates.set(movie, []);
      });
    return undefined;
  }

  /** The open menus' visible fields that still show their authored placeholder. */
  check(vfs: Vfs, menus: Iterable<Menu>): ShownPlaceholder[] {
    const shown: ShownPlaceholder[] = [];
    for (const menu of menus) {
      const element = menu.element;
      if (!element || element.style.visibility === 'hidden' || element.hidden) continue;
      for (const { path, field } of this.#of(vfs, menu.movie) ?? []) {
        const text = menu.get(`${path}.text`);
        if (typeof text !== 'string') continue;
        const authored = plainText(field);
        if (textKey(text) !== textKey(authored) || !visible(menu, path)) continue;
        shown.push({ movie: menu.movie, path, text: authored });
      }
    }
    return shown;
  }
}

/** Whether a clip path is on screen: it and every clip above it visible, none transparent. */
function visible(menu: Menu, path: string): boolean {
  const parts = path.split('.');
  for (let end = parts.length; end > 1; end--) {
    const at = parts.slice(0, end).join('.');
    if (menu.get(`${at}._visible`) === false) return false;
    const alpha = menu.get(`${at}._alpha`);
    if (typeof alpha === 'number' && alpha <= 0) return false;
  }
  return true;
}
