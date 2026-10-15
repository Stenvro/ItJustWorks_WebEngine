// The Flash key codes (Key.getCode, the menus' InputDetails.code) of the keys a page reports
// by KeyboardEvent.code: the Windows virtual-key codes Flash uses. Platform-independent.

const NAMED: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumLock: 144,
  ScrollLock: 145,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
};

/** A key's Flash key code by its KeyboardEvent.code ("KeyE" 69, "ArrowDown" 40), if it has one. */
export function flashKeyCode(code: string): number | undefined {
  const named = NAMED[code];
  if (named !== undefined) return named;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) return letter.charCodeAt(0);
  const digit = /^Digit(\d)$/.exec(code)?.[1];
  if (digit) return 48 + Number(digit);
  const numpad = /^Numpad(\d)$/.exec(code)?.[1];
  if (numpad) return 96 + Number(numpad);
  const fn = /^F(\d{1,2})$/.exec(code)?.[1];
  if (fn && Number(fn) >= 1 && Number(fn) <= 24) return 111 + Number(fn);
  return undefined;
}
