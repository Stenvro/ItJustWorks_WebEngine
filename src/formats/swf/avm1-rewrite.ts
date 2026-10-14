// Rewrites the strings of an ActionScript 2 block (ConstantPool entries and pushed strings),
// re-encoding it with every relative branch and block size moved along: If and Jump offsets,
// DefineFunction / DefineFunction2 body sizes, With and Try block sizes. Other actions are
// copied byte for byte. Used to put the game's translations into its menus (src/ui/
// translate-movie.ts). Notes: docs/formats/swf.md.

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { decodeUtf8, decodeWindows1252, encodeUtf8 } from '../text.ts';

/** A string's replacement, or undefined to keep it. */
export type StringRewrite = (text: string) => string | undefined;

interface RawAction {
  readonly offset: number;
  readonly code: number;
  /** The payload (empty for actions under 0x80). */
  readonly payload: Uint8Array;
  /** Offset just past the action. */
  readonly end: number;
}

function readActions(bytes: Uint8Array): RawAction[] {
  const reader = new BinaryReader(bytes);
  const actions: RawAction[] = [];
  while (reader.remaining > 0) {
    const offset = reader.offset;
    const code = reader.u8();
    if (code < 0x80) {
      actions.push({ offset, code, payload: new Uint8Array(0), end: reader.offset });
      continue;
    }
    const length = reader.u16();
    const payload = reader.bytes(length);
    actions.push({ offset, code, payload, end: reader.offset });
  }
  return actions;
}

function decodeString(bytes: Uint8Array, version: number): string {
  return version >= 6 ? (decodeUtf8(bytes) ?? decodeWindows1252(bytes)) : decodeWindows1252(bytes);
}

/** A string's bytes up to its terminator, from `at`; returns them and the offset past it. */
function cString(payload: Uint8Array, at: number): { bytes: Uint8Array; next: number } {
  const end = payload.indexOf(0, at);
  if (end < 0) throw new FormatError('unterminated string', at);
  return { bytes: payload.subarray(at, end), next: end + 1 };
}

/** Push value sizes after the type byte (strings are null-terminated). */
const PUSH_SIZES: Record<number, number> = { 1: 4, 2: 0, 3: 0, 4: 1, 5: 1, 6: 8, 7: 4, 8: 1, 9: 2 };

function rewritePayload(
  action: RawAction,
  version: number,
  rewrite: StringRewrite,
): Uint8Array | undefined {
  const replaced = (bytes: Uint8Array): Uint8Array | undefined => {
    const text = decodeString(bytes, version);
    const next = rewrite(text);
    return next === undefined || next === text ? undefined : encodeUtf8(next);
  };
  if (action.code === 0x88) {
    const count = (action.payload[0] ?? 0) | ((action.payload[1] ?? 0) << 8);
    const parts: number[] = [action.payload[0] ?? 0, action.payload[1] ?? 0];
    let at = 2;
    let changed = false;
    for (let i = 0; i < count; i++) {
      const { bytes, next } = cString(action.payload, at);
      const swapped = replaced(bytes);
      if (swapped) changed = true;
      parts.push(...(swapped ?? bytes), 0);
      at = next;
    }
    return changed ? Uint8Array.from(parts) : undefined;
  }
  if (action.code === 0x96) {
    const parts: number[] = [];
    let at = 0;
    let changed = false;
    while (at < action.payload.length) {
      const type = action.payload[at] ?? 0;
      parts.push(type);
      at++;
      if (type === 0) {
        const { bytes, next } = cString(action.payload, at);
        const swapped = replaced(bytes);
        if (swapped) changed = true;
        parts.push(...(swapped ?? bytes), 0);
        at = next;
        continue;
      }
      const size = PUSH_SIZES[type];
      if (size === undefined) throw new FormatError(`unknown push type ${String(type)}`, at - 1);
      parts.push(...action.payload.subarray(at, at + size));
      at += size;
    }
    return changed ? Uint8Array.from(parts) : undefined;
  }
  return undefined;
}

/**
 * The block with its strings rewritten; the same bytes when nothing changed.
 * `version`: the movie's SWF version (string encoding).
 */
export function rewriteAvm1Strings(
  code: Uint8Array,
  version: number,
  rewrite: StringRewrite,
): Uint8Array {
  const actions = readActions(code);
  const payloads = actions.map((action) => rewritePayload(action, version, rewrite));
  if (payloads.every((payload) => payload === undefined)) return code;

  // New offsets of every action start and of the block's end.
  const moved = new Map<number, number>();
  let at = 0;
  for (const [i, action] of actions.entries()) {
    moved.set(action.offset, at);
    const payload = payloads[i] ?? action.payload;
    at += action.code < 0x80 ? 1 : 3 + payload.length;
  }
  moved.set(code.length, at);
  const newOffset = (old: number): number => {
    const offset = moved.get(old);
    if (offset === undefined) throw new FormatError(`a branch lands inside an action`, old);
    return offset;
  };

  const out = new Uint8Array(at);
  const view = new DataView(out.buffer);
  for (const [i, action] of actions.entries()) {
    const start = newOffset(action.offset);
    out[start] = action.code;
    if (action.code < 0x80) continue;
    const payload = Uint8Array.from(payloads[i] ?? action.payload);
    const payloadView = new DataView(payload.buffer);
    const newEnd = start + 3 + payload.length;
    // A span after the action, of `size` bytes in the old block: its new size.
    const span = (size: number, from = action.end): number =>
      newOffset(from + size) - newOffset(from);
    switch (action.code) {
      case 0x99: // Jump
      case 0x9d: {
        // If: relative to the end of the action.
        const target = action.end + payloadView.getInt16(0, true);
        payloadView.setInt16(0, newOffset(target) - newEnd, true);
        break;
      }
      case 0x9b: // DefineFunction: the body size is the payload's last u16.
      case 0x8e: {
        // DefineFunction2
        const sizeAt = payload.length - 2;
        payloadView.setUint16(sizeAt, span(payloadView.getUint16(sizeAt, true)), true);
        break;
      }
      case 0x94: // With
        payloadView.setUint16(0, span(payloadView.getUint16(0, true)), true);
        break;
      case 0x8f: {
        // Try: try, catch and finally blocks follow one another.
        const trySize = payloadView.getUint16(1, true);
        const catchSize = payloadView.getUint16(3, true);
        const finallySize = payloadView.getUint16(5, true);
        payloadView.setUint16(1, span(trySize), true);
        payloadView.setUint16(3, span(catchSize, action.end + trySize), true);
        payloadView.setUint16(5, span(finallySize, action.end + trySize + catchSize), true);
        break;
      }
      default:
        break;
    }
    view.setUint16(start + 1, payload.length, true);
    out.set(payload, start + 3);
  }
  return out;
}
