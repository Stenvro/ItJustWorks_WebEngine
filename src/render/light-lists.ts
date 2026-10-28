// Per-object light lists. The engine does not light a geometry with every light around it: each
// geometry keeps its own list of the lights that touch its bound, and its lighting pass takes the
// directional light, then the shadow lights touching it, then the other lights of its list, up to
// what the lighting shader's technique can name: seven point lights, at most four of them
// shadowed (observed in the original, see docs/rendering.md "Per-object light lists").
// Lights past the seventh are left out of that object, however bright.
//
// Here each draw gets such a list once per frame (the lights of the frame, packed as keys), and
// the lighting and effect shaders loop over it instead of over every light of the frame.

/** Point lights a lighting pass names (the technique's light count, the directional light apart). */
export const MAX_OBJECT_LIGHTS = 7;
/** Of them, shadow-casting lights (the technique's shadow light count). */
export const MAX_OBJECT_SHADOW_LIGHTS = 4;
/** Words of one draw's list: the count and seven light indices, 16 bits each. */
export const LIGHT_LIST_WORDS = 4;
/**
 * Floats per light key: position, radius, luminance, shadow (1: casts this frame), room, and
 * the light's index among the frame's lights (what a list names).
 */
export const LIGHT_KEY_FLOATS = 8;

/** What selection needs of one light (packLightKey). */
export interface LightKeySource {
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly color: readonly [number, number, number];
  /** A portal-strict light's room (0 or undefined: every room). */
  readonly room?: number | undefined;
}

/**
 * Writes a light's key at `index` (`shadowed`: it casts a shadow this frame; `lightIndex`: its
 * index among the frame's lights, by default `index`).
 */
export function packLightKey(
  keys: Float32Array,
  index: number,
  light: LightKeySource,
  shadowed: boolean,
  lightIndex = index,
): void {
  const at = index * LIGHT_KEY_FLOATS;
  const [r, g, b] = light.color;
  keys[at] = light.position[0];
  keys[at + 1] = light.position[1];
  keys[at + 2] = light.position[2];
  keys[at + 3] = light.radius;
  keys[at + 4] = 0.2125 * r + 0.7154 * g + 0.0721 * b;
  keys[at + 5] = shadowed ? 1 : 0;
  keys[at + 6] = light.room ?? 0;
  keys[at + 7] = lightIndex;
}

const shadowIndex = new Int32Array(MAX_OBJECT_SHADOW_LIGHTS);
const shadowScore = new Float32Array(MAX_OBJECT_SHADOW_LIGHTS);
const plainIndex = new Int32Array(MAX_OBJECT_LIGHTS);
const plainScore = new Float32Array(MAX_OBJECT_LIGHTS);

/** Inserts (index, score) into a list kept highest score first; returns its new length. */
function insert(
  indices: Int32Array,
  scores: Float32Array,
  length: number,
  index: number,
  score: number,
): number {
  const capacity = indices.length;
  if (length === capacity && score <= (scores[capacity - 1] ?? 0)) return length;
  let at = Math.min(length, capacity - 1);
  while (at > 0 && (scores[at - 1] ?? 0) < score) {
    indices[at] = indices[at - 1] ?? 0;
    scores[at] = scores[at - 1] ?? 0;
    at--;
  }
  indices[at] = index;
  scores[at] = score;
  return Math.min(length + 1, capacity);
}

/**
 * The lights of an object with the bounding sphere (center, radius) standing in `room` (0: none),
 * written as its list at `out[at..at + 4]`: the count in the low 16 bits of the first word, then
 * the light indices, 16 bits each. Returns the count.
 *
 * A light is in the list when its sphere touches the bound and it is not a portal-strict light of
 * another room. Shadow lights come first (at most four), then the others, up to seven in all;
 * when more touch the object, the strongest at the bound win: the light's luminance times its
 * falloff (1 − (d/r)²) at the bound's nearest point. TODO(M13): the engine's own order of a
 * geometry's list (the order lights reach it) is unread; strongest first is our choice.
 */
export function selectObjectLights(
  keys: Float32Array,
  count: number,
  center: readonly [number, number, number],
  radius: number,
  room: number,
  out: Uint32Array,
  at: number,
): number {
  let shadows = 0;
  let plain = 0;
  for (let i = 0; i < count; i++) {
    const k = i * LIGHT_KEY_FLOATS;
    const lightRoom = keys[k + 6] ?? 0;
    if (lightRoom > 0 && room !== 0 && lightRoom !== room) continue;
    const dx = (keys[k] ?? 0) - center[0];
    const dy = (keys[k + 1] ?? 0) - center[1];
    const dz = (keys[k + 2] ?? 0) - center[2];
    const reach = keys[k + 3] ?? 0;
    if (reach <= 0) continue;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance >= reach + radius) continue;
    const nearest = Math.max(0, distance - radius) / reach;
    // Ties (lights equally strong) keep the earlier light: a small bias by index.
    const score = (keys[k + 4] ?? 0) * (1 - nearest * nearest) + 1e-6 / (i + 1);
    if ((keys[k + 5] ?? 0) > 0) {
      shadows = insert(shadowIndex, shadowScore, shadows, i, score);
    } else {
      plain = insert(plainIndex, plainScore, plain, i, score);
    }
  }
  const total = Math.min(MAX_OBJECT_LIGHTS, shadows + plain);
  let word = total;
  for (let n = 0; n < MAX_OBJECT_LIGHTS; n++) {
    const key =
      n >= total ? -1 : n < shadows ? (shadowIndex[n] ?? 0) : (plainIndex[n - shadows] ?? 0);
    const index = key < 0 ? 0 : (keys[key * LIGHT_KEY_FLOATS + 7] ?? 0);
    // Slot n + 1 of the eight 16-bit halves (the count is slot 0).
    const half = n + 1;
    if (half % 2 === 0) {
      word = index & 0xffff;
    } else {
      out[at + (half >> 1)] = (word | ((index & 0xffff) << 16)) >>> 0;
    }
  }
  return total;
}

/** The light indices of a list written by selectObjectLights (for tests and tools). */
export function unpackObjectLights(list: Uint32Array, at = 0): number[] {
  const count = (list[at] ?? 0) & 0xffff;
  const indices: number[] = [];
  for (let n = 0; n < count; n++) {
    const half = n + 1;
    const word = list[at + (half >> 1)] ?? 0;
    indices.push(half % 2 === 0 ? word & 0xffff : word >>> 16);
  }
  return indices;
}
