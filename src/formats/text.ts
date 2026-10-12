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
 * Lowercases only A-Z, like the C runtime `tolower` the engine uses.
 * (`String#toLowerCase` would also convert accented letters.)
 */
export function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]+/g, (match) => match.toLowerCase());
}
