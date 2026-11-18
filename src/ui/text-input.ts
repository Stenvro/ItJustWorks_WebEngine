// Whether the keys go to a text field: the control map's count of what allows text input now
// (CommonLib's ControlMap::AllowTextInput), each allowing raising it and each taking back
// lowering it: a byte, raised without a bound (past 255 it wraps to 0) and lowered no further
// than 0, as observed in the original. SKSE's UI.IsTextInputEnabled asks it above 0.
// Platform-independent. Notes: docs/ui.md ("The menu stack").

export class TextInputCount {
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /** One more (true) or one fewer (false) allows text input; returns the count now. */
  allow(allow: boolean): number {
    if (allow) this.#count = (this.#count + 1) & 0xff;
    else if (this.#count > 0) this.#count--;
    return this.#count;
  }

  /**
   * Allows text input while something is open: once from `opened` until `closed` (each later
   * `opened` before a `closed` changes nothing; `closed` without one changes nothing).
   */
  whileOpen(): { opened(): void; closed(): void } {
    let release: (() => void) | undefined;
    return {
      opened: () => {
        release ??= this.hold();
      },
      closed: () => {
        release?.();
        release = undefined;
      },
    };
  }

  /** Allows text input until the returned function is called (once). */
  hold(): () => void {
    this.allow(true);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.allow(false);
    };
  }
}

/**
 * The race menu's name box's calls to the game: SetAllowTextInput (the field took the focus)
 * allows text input, once more each call whatever its arguments; each name ChangeName sends
 * takes one allowing back (observed in the original). The menu host gives the focused field
 * the keys.
 */
export function nameBoxHandlers<M>(
  textInput: TextInputCount,
  changeName: (menu: M, name: unknown) => void,
): Record<string, (menu: M, args: readonly unknown[]) => unknown> {
  return {
    ChangeName: (menu, args) => {
      textInput.allow(false);
      changeName(menu, args[1]);
    },
    SetAllowTextInput: () => {
      textInput.allow(true);
    },
    // Consoles' on-screen keyboard; the PC types into the name box.
    ShowVirtualKeyboard: () => undefined,
  };
}

/** The crafting menu's movie (its `_root.Menu`), as far as its name field goes. */
export interface ItemNameField {
  invoke(path: string, ...args: unknown[]): unknown;
}

/**
 * The crafting menu's name field opened (EditItemName with the name and its longest length):
 * text input is allowed until the movie's EndItemRename (observed in the original).
 */
export function editItemName(
  menu: ItemNameField,
  textInput: TextInputCount,
  name: string,
  maxLength: number,
): void {
  textInput.allow(true);
  menu.invoke('_root.Menu.EditItemName', name, maxLength);
}

/**
 * The movie's EndItemRename (its arguments: whether a name was accepted, the name): takes back
 * what EditItemName allowed; `rename` gets the name accepted (undefined: none).
 */
export function endItemRename(
  textInput: TextInputCount,
  rename: ((name: string | undefined) => void) | undefined,
  args: readonly unknown[],
): void {
  textInput.allow(false);
  rename?.(args[1] === true && typeof args[2] === 'string' ? args[2] : undefined);
}
