/* eslint-disable @typescript-eslint/no-non-null-assertion -- hot loop; grenzen worden expliciet bewaakt */

// xxHash32, gebruikt voor de checksums in LZ4-frames.
// https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md

const PRIME1 = 0x9e3779b1;
const PRIME2 = 0x85ebca77;
const PRIME3 = 0xc2b2ae3d;
const PRIME4 = 0x27d4eb2f;
const PRIME5 = 0x165667b1;

function rotl(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

function round(acc: number, lane: number): number {
  return Math.imul(rotl((acc + Math.imul(lane, PRIME2)) | 0, 13), PRIME1);
}

export function xxhash32(
  data: Uint8Array,
  start = 0,
  length = data.length - start,
  seed = 0,
): number {
  if (start < 0 || length < 0 || start + length > data.length) {
    throw new RangeError(`xxhash32: bereik ${start}+${length} buiten ${data.length} bytes`);
  }
  const end = start + length;
  const u32 = (p: number): number =>
    data[p]! | (data[p + 1]! << 8) | (data[p + 2]! << 16) | (data[p + 3]! << 24);

  let p = start;
  let hash: number;
  if (length >= 16) {
    let v1 = (seed + PRIME1 + PRIME2) | 0;
    let v2 = (seed + PRIME2) | 0;
    let v3 = seed | 0;
    let v4 = (seed - PRIME1) | 0;
    for (const limit = end - 16; p <= limit; p += 16) {
      v1 = round(v1, u32(p));
      v2 = round(v2, u32(p + 4));
      v3 = round(v3, u32(p + 8));
      v4 = round(v4, u32(p + 12));
    }
    hash = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else {
    hash = (seed + PRIME5) | 0;
  }

  hash = (hash + length) | 0;
  for (; p + 4 <= end; p += 4) {
    hash = Math.imul(rotl((hash + Math.imul(u32(p), PRIME3)) | 0, 17), PRIME4);
  }
  for (; p < end; p++) {
    hash = Math.imul(rotl((hash + Math.imul(data[p]!, PRIME5)) | 0, 11), PRIME1);
  }

  hash ^= hash >>> 15;
  hash = Math.imul(hash, PRIME2);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, PRIME3);
  hash ^= hash >>> 16;
  return hash >>> 0;
}
