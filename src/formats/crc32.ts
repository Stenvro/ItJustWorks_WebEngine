// The CRC-32 Bethesda's engine names things by (BSCRC32): the reflected polynomial 0xEDB88320
// like zlib's, but starting at 0 and without the final inversion. Material ids (MATT) and the
// animation set data's cached clip paths use it.

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** BSCRC32 of a string's bytes (one byte per character, as ASCII), unsigned. */
export function bsCrc32(text: string): number {
  let crc = 0;
  for (let i = 0; i < text.length; i++) {
    crc = ((TABLE[(crc ^ (text.charCodeAt(i) & 0xff)) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return crc;
}
