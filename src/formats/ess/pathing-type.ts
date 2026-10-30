// The type ids the original saves its pathing and combat objects with (docs/formats/ess.md
// "Movement"). Platform-independent.

/**
 * The type a pathing or combat object is saved with: the CRC-32 (reflected, no final inversion)
 * of its class name, as the original's factories key their classes.
 */
export function pathingTypeId(name: string): number {
  let crc = 0;
  for (let i = 0; i < name.length; i++) {
    crc = (CRC_TABLE[(crc ^ name.charCodeAt(i)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return crc >>> 0;
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
