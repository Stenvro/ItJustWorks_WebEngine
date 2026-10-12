// Minimal matrix math. Matrices are 4x4, column-major (WGSL layout), in Float32Arrays.
// World space is Skyrim's: right-handed, Z up, 1 unit ≈ 1.43 cm.

export type Mat4 = Float32Array;
export type Vec3 = readonly [number, number, number];

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** out = a · b (b is applied first). */
export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  const result = out === a || out === b ? new Float32Array(16) : out;
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      result[col * 4 + row] = sum;
    }
  }
  if (result !== out) out.set(result);
  return out;
}

/**
 * Builds T·R·S from a NIF transform. `rotation` holds 9 floats row by row
 * (Gamebryo streams m[row][col] and applies v' = R·v).
 */
export function fromNifTransform(
  translation: Vec3,
  rotation: readonly number[],
  scale: number,
): Mat4 {
  const m = identity();
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      m[col * 4 + row] = (rotation[row * 3 + col] ?? (row === col ? 1 : 0)) * scale;
    }
  }
  m[12] = translation[0];
  m[13] = translation[1];
  m[14] = translation[2];
  return m;
}

export function transformPoint(m: Mat4, p: Vec3): [number, number, number] {
  const [x, y, z] = p;
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

/** Largest axis scale of the upper 3x3 (for transforming bounding sphere radii). */
export function maxScale(m: Mat4): number {
  const axis = (i: number): number => Math.hypot(m[i] ?? 0, m[i + 1] ?? 0, m[i + 2] ?? 0);
  return Math.max(axis(0), axis(4), axis(8));
}

/**
 * Perspective projection with reversed Z (near → 1, far → 0) and an infinite far plane,
 * for WebGPU's 0..1 depth range. Gives good depth precision over Skyrim's view distances.
 */
export function perspectiveReversedZ(fovY: number, aspect: number, near: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[11] = -1;
  m[14] = near;
  return m;
}

/** Right-handed view matrix looking from `eye` at `target`, with `up` as up direction. */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const normalize = (a: Vec3): Vec3 => {
    const length = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / length, a[1] / length, a[2] / length];
  };
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const forward = normalize(sub(target, eye));
  const right = normalize(cross(forward, up));
  const trueUp = cross(right, forward);
  const m = identity();
  m[0] = right[0];
  m[4] = right[1];
  m[8] = right[2];
  m[1] = trueUp[0];
  m[5] = trueUp[1];
  m[9] = trueUp[2];
  m[2] = -forward[0];
  m[6] = -forward[1];
  m[10] = -forward[2];
  m[12] = -dot(right, eye);
  m[13] = -dot(trueUp, eye);
  m[14] = dot(forward, eye);
  return m;
}

/** Converts a float to IEEE 754 half precision (round to nearest). */
export function toHalf(value: number): number {
  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);
  floatView[0] = value;
  const bits = intView[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;

  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0); // Inf / NaN
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00; // overflow → Inf
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign; // underflow → 0
    mantissa |= 0x800000;
    const shift = 14 - halfExponent;
    return sign | ((mantissa + (1 << (shift - 1))) >>> shift);
  }
  const rounded = mantissa + 0x1000;
  if (rounded & 0x800000) return sign | ((halfExponent + 1) << 10); // mantissa overflow
  return sign | (halfExponent << 10) | (rounded >>> 13);
}
