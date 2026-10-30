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
/** Point lights an effect shader's pass names (its array of five, the directional light first). */
export const MAX_EFFECT_LIGHTS = 4;
/** Words of one draw's list: the count and seven light indices, 16 bits each. */
export const LIGHT_LIST_WORDS = 4;
/**
 * Floats per light key: position, radius, luminance, shadow (1: casts this frame), room, the
 * light's index among the frame's lights (what a list names), when it joined the scene and
 * whether it leaves land unlit (1).
 */
export const LIGHT_KEY_FLOATS = 10;

/** What selection needs of one light (packLightKey). */
export interface LightKeySource {
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly color: readonly [number, number, number];
  /** A portal-strict light's room (0 or undefined: every room). */
  readonly room?: number | undefined;
  /** When it joined the scene, lower first (undefined: before every ordered light). */
  readonly order?: number | undefined;
  /** False for a light whose reference does not light landscape (REFR 0x20000). */
  readonly lightsLand?: boolean | undefined;
}

/**
 * Whose list: a lighting shader's geometry, a land quadrant's (lighting geometry with the
 * landscape's shader), or an effect shader's (lit effects, particles).
 */
export type LightListKind = 'lighting' | 'land' | 'effect';

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
  keys[at + 8] = light.order ?? -1;
  keys[at + 9] = light.lightsLand === false ? 1 : 0;
}

const shadowIndex = new Int32Array(MAX_OBJECT_SHADOW_LIGHTS);
const shadowScore = new Float64Array(MAX_OBJECT_SHADOW_LIGHTS);
const plainIndex = new Int32Array(MAX_OBJECT_LIGHTS);
const plainScore = new Float64Array(MAX_OBJECT_LIGHTS);

/**
 * Inserts (index, score) into the first `capacity` entries of a list kept highest score first;
 * returns its new length.
 */
function insert(
  indices: Int32Array,
  scores: Float64Array,
  capacity: number,
  length: number,
  index: number,
  score: number,
): number {
  if (capacity <= 0) return 0;
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
 * As the original builds a geometry's pass (observed in it): a light is in the geometry's own
 * list when its sphere touches the bound (and it is not a portal-strict light of another room);
 * shadow lights never join that list but reach a lighting geometry through the frame's shadow
 * lights, named first in the frame's order (at most four); the list's lights follow in the
 * order they joined the scene, and the pass keeps the first seven in all, whatever their
 * strength. An effect (`kind` 'effect': lit effects and particle systems) names no shadow
 * light and at most four of its list's lights. A land quadrant (`kind` 'land': each quadrant of
 * a cell's landscape is a geometry of its own, with its own texture set and bound) is lighting
 * geometry whose shader is the landscape's: a light whose reference does not light landscape
 * neither joins its list nor reaches it as one of the frame's shadow lights.
 */
export function selectObjectLights(
  keys: Float32Array,
  count: number,
  center: readonly [number, number, number],
  radius: number,
  room: number,
  out: Uint32Array,
  at: number,
  kind: LightListKind = 'lighting',
): number {
  const effect = kind === 'effect';
  const maxShadows = effect ? 0 : MAX_OBJECT_SHADOW_LIGHTS;
  const maxLights = effect ? MAX_EFFECT_LIGHTS : MAX_OBJECT_LIGHTS;
  let shadows = 0;
  let plain = 0;
  for (let i = 0; i < count; i++) {
    const k = i * LIGHT_KEY_FLOATS;
    const lightRoom = keys[k + 6] ?? 0;
    if (lightRoom > 0 && room !== 0 && lightRoom !== room) continue;
    if (kind === 'land' && (keys[k + 9] ?? 0) > 0) continue;
    const dx = (keys[k] ?? 0) - center[0];
    const dy = (keys[k + 1] ?? 0) - center[1];
    const dz = (keys[k + 2] ?? 0) - center[2];
    const reach = keys[k + 3] ?? 0;
    if (reach <= 0) continue;
    if (dx * dx + dy * dy + dz * dz >= (reach + radius) * (reach + radius)) continue;
    if ((keys[k + 5] ?? 0) > 0) {
      // The frame's shadow lights in their order (the earlier key first).
      shadows = insert(shadowIndex, shadowScore, maxShadows, shadows, i, -i);
    } else {
      // The list's lights in the order they joined the scene (ties: the earlier key).
      const score = -(keys[k + 8] ?? 0) - i * 1e-7;
      plain = insert(plainIndex, plainScore, maxLights, plain, i, score);
    }
  }
  const total = Math.min(maxLights, shadows + plain);
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
