// Windows-1252: the code page of Skyrim's file names, plugins.txt and English records.
// Mapping per the WHATWG Encoding Standard (same as TextDecoder('windows-1252')).

const HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
] as const;

const ENCODE_HIGH = new Map<number, number>(HIGH.map((codePoint, i) => [codePoint, 0x80 + i]));

export function decodeWindows1252(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let result = '';
  for (let i = start; i < end; i++) {
    const byte = bytes[i] ?? 0;
    result += String.fromCharCode(byte >= 0x80 && byte < 0xa0 ? (HIGH[byte - 0x80] ?? byte) : byte);
  }
  return result;
}

/** Characters that do not exist in Windows-1252 become `?`, as with Windows' ANSI APIs. */
export function encodeWindows1252(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i] =
      code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : (ENCODE_HIGH.get(code) ?? 0x3f);
  }
  return bytes;
}

/**
 * Strict UTF-8 decoding; `undefined` if the bytes are not valid UTF-8 (overlong forms,
 * surrogates and truncated sequences are rejected).
 */
export function decodeUtf8(bytes: Uint8Array, start = 0, end = bytes.length): string | undefined {
  const codeUnits: number[] = [];
  let i = start;
  while (i < end) {
    const b0 = bytes[i] ?? 0;
    if (b0 < 0x80) {
      codeUnits.push(b0);
      i++;
      continue;
    }
    const length = b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc2 ? 2 : 0;
    if (length === 0 || b0 > 0xf4 || i + length > end) return undefined;
    let codePoint = b0 & (0xff >> (length + 1));
    for (let k = 1; k < length; k++) {
      const byte = bytes[i + k] ?? 0;
      if ((byte & 0xc0) !== 0x80) return undefined;
      codePoint = (codePoint << 6) | (byte & 0x3f);
    }
    const minimum = length === 2 ? 0x80 : length === 3 ? 0x800 : 0x10000;
    if (
      codePoint < minimum ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return undefined;
    }
    if (codePoint >= 0x10000) {
      codePoint -= 0x10000;
      codeUnits.push(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
    } else {
      codeUnits.push(codePoint);
    }
    i += length;
  }
  let result = '';
  for (let k = 0; k < codeUnits.length; k += 8192) {
    result += String.fromCharCode(...codeUnits.slice(k, k + 8192));
  }
  return result;
}

/** UTF-8 bytes of a string (lone surrogates become U+FFFD, as TextEncoder does). */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 where valid, otherwise Windows-1252 (Skyrim SE string tables mix both). */
export function decodeGameText(bytes: Uint8Array, start = 0, end = bytes.length): string {
  return decodeUtf8(bytes, start, end) ?? decodeWindows1252(bytes, start, end);
}

/**
 * Lowercases only A-Z, like the C runtime `tolower` the engine uses.
 * (`String#toLowerCase` would also convert accented letters.)
 */
export function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]+/g, (match) => match.toLowerCase());
}
