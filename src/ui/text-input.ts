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
