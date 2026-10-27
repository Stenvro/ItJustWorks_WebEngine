// An effect shader's particles (EFSH's particle shader: src/world/effect-shader-records.ts) off
// an actor's surfaces: born at points of its skin as its pose has them now (its skinned shapes'
// vertices, sampled; on an object without a skeleton, its rigid shapes' vertices where its model
// places them), at the shader's birth rate (ramping up, full, ramping down, then its
// persistent count a second), moving off along the surface normal and with the shader's
// velocity and acceleration, sized by its two scale keys and coloured by its three colour keys
// over their lives, turning, in frames of its texture's atlas. A ParticleSource for the scene
// renderer (its ParticleSystemData only carries the material and the atlas).

import type { ActorPose } from '../animation/skeleton.ts';
import { PALETTE_BONE_FLOATS, writePaletteBone } from '../render/bone-palette.ts';
import type { Mat4 } from '../render/math.ts';
import type { AlphaState, EffectMaterial, ModelPart } from '../render/model-data.ts';
import type { ParticleSystemData } from '../render/particle-data.ts';
import {
  PARTICLE_FLOATS,
  type ParticleContext,
  type ParticleSource,
} from '../render/particle-sim.ts';
import { fromHalf } from '../render/skinning.ts';
import { EffectShaderFlag, type EffectShaderRecord } from '../world/effect-shader-records.ts';

/** A body particles are born on: its shapes, its pose (none: an object's rigid shapes), its placement. */
export interface ParticleBody {
  readonly parts: readonly ModelPart[];
  readonly pose: ActorPose | undefined;
  readonly world: Mat4;
  /**
   * Without a pose: where a rigid shape is now under `world` (a held weapon's shape on its hand
   * node); undefined, or none given: where its model places it.
   */
  readonly hang?: (part: ModelPart) => Mat4 | undefined;
}

/** Most particles alive at once per shader on one body. */
const MAX_PARTICLES = 512;
/** Points of the skin sampled to be born at. */
const SAMPLES = 96;
/** Floats per particle: position, velocity, normal, age, life, frame, angle, spin. */
const STRIDE = 14;

const DEGREES = Math.PI / 180;

/** The material of an effect shader's particles (its texture, palette, blending, z test). */
export function particleMaterial(shader: EffectShaderRecord): {
  material: EffectMaterial;
  alpha: AlphaState;
} {
  const p = shader.particles;
  const flags = shader.flags;
  // SLSF1: greyscale to palette colour 0x10 / alpha 0x20; the z test 0x80000000 unless the
  // shader always shows (z test function 8, Detect Life's through walls).
  let flags1 = 0;
  if ((flags & EffectShaderFlag.particleGreyscaleColor) !== 0) flags1 |= 0x10;
  if ((flags & EffectShaderFlag.particleGreyscaleAlpha) !== 0) flags1 |= 0x20;
  if (p.zTest !== Z_TEST_ALWAYS) flags1 |= 0x80000000;
  return {
    material: {
      kind: 'effect',
      flags1,
      flags2: (flags & EffectShaderFlag.lighting) !== 0 ? 0x40000000 : 0,
      uvOffset: [0, 0],
      uvScale: [1, 1],
      sourceTexture: texturePath(shader.particleTexture),
      greyscaleTexture: texturePath(shader.particlePalette),
      baseColor: [1, 1, 1, 1],
      baseColorScale: shader.colorScale,
      falloff: [1, 0, 1, 1],
      lightingInfluence: (flags & EffectShaderFlag.lighting) !== 0 ? 1 : 0,
      softFalloffDepth: 0,
      textureClampMode: 3,
    },
    alpha: { flags: alphaFlags(p.sourceBlend, p.destBlend), threshold: 0 },
  };
}

/** EFSH z test function: always shown (xEdit wbZTestFuncEnum 8). */
export const Z_TEST_ALWAYS = 8;

/** A path under textures\ as the texture cache reads it ('' for none). */
export function texturePath(path: string): string {
  if (path === '') return '';
  const normal = path.replaceAll('/', '\\').toLowerCase();
  return normal.startsWith('textures\\') ? normal : `textures\\${normal}`;
}

/**
 * NiAlphaProperty flags of an EFSH blend (D3D modes 1 zero, 2 one, 3 source colour ... 11
 * source alpha saturate) with blending on: their NiAlphaProperty functions. The destination's
 * alpha is taken as 0 (the engine's scene target keeps none): destination alpha blends as zero,
 * inverse destination alpha as one (FireFXShader's particles add their light). TODO(M13): the
 * engine's target alpha is inferred from how the vanilla shaders look.
 */
export function alphaFlags(source: number, dest: number): number {
  const FUNCTIONS = [6, 1, 0, 2, 3, 6, 7, 1, 0, 4, 5, 10];
  const src = FUNCTIONS[source] ?? 6;
  const dst = FUNCTIONS[dest] ?? 0;
  return 0x1 | (src << 1) | (dst << 5);
}

/** The particle system data the renderer draws an effect shader's particles with. */
export function particleSystem(shader: EffectShaderRecord): ParticleSystemData {
  const { material, alpha } = particleMaterial(shader);
  const u = Math.max(1, shader.particles.textureCountU);
  const v = Math.max(1, shader.particles.textureCountV);
  const subtextures: [number, number, number, number][] = [];
  for (let row = 0; row < v; row++)
    for (let column = 0; column < u; column++)
      subtextures.push([column / u, row / v, 1 / u, 1 / v]);
  return {
    name: shader.editorId,
    block: -1,
    worldSpace: true,
    maxParticles: MAX_PARTICLES,
    subtextures,
    aspectRatio: 1,
    velocityOriented: false,
    material,
    alpha,
    shader: -1,
    alphaProperty: -1,
    strip: undefined,
    emitters: [],
    modifiers: {
      spawnOnDeath: false,
      spawn: undefined,
      gravity: [],
      drag: [],
      bombs: [],
      colliders: [],
      rotation: undefined,
      color: undefined,
      scales: undefined,
      subTexture: undefined,
      recycleBound: undefined,
      inheritVelocity: undefined,
      wind: 0,
      lod: undefined,
      inactive: [],
    },
    tracks: [],
    sequenceTracks: new Map(),
    objects: new Map(),
    billboards: new Map(),
  };
}

/** A point of the skin: its shape and vertex. */
interface Sample {
  readonly part: ModelPart;
  readonly vertex: number;
  /** The pose's node of each of the shape's bones. */
  readonly nodes: Int16Array;
}

export class SurfaceParticles implements ParticleSource {
  readonly data: ParticleSystemData;
  count = 0;
  readonly center: [number, number, number] = [0, 0, 0];
  radius = 0;
  readonly #shader: EffectShaderRecord;
  readonly #body: () => ParticleBody | undefined;
  readonly #state = new Float32Array(MAX_PARTICLES * STRIDE);
  #samples: Sample[] = [];
  #sampledFor: ParticleBody | undefined;
  /** Seconds since the shader began, and since it was told to stop (undefined: on). */
  #age = 0;
  #stopping: number | undefined;
  #births = 0;
  readonly #random: () => number;
  readonly #bone = new Float32Array(PALETTE_BONE_FLOATS);

  constructor(
    shader: EffectShaderRecord,
    body: () => ParticleBody | undefined,
    random: () => number = Math.random,
  ) {
    this.#shader = shader;
    this.#body = body;
    this.#random = random;
    this.data = particleSystem(shader);
  }

  get instanceCount(): number {
    return this.count;
  }

  /** No more are born; those alive live out their lives. */
  stop(): void {
    this.#stopping ??= 0;
  }

  /** Whether it has stopped and its last particle has died. */
  get finished(): boolean {
    return this.#stopping !== undefined && this.count === 0;
  }

  /** Particles born a second `t` seconds after the shader began (its birth ramps). */
  birthRate(t: number): number {
    const p = this.#shader.particles;
    const full = p.fullBirthRatio;
    if (t < p.birthRampUp) return p.birthRampUp > 0 ? (full * t) / p.birthRampUp : full;
    t -= p.birthRampUp;
    if (t < p.fullBirthTime) return full;
    t -= p.fullBirthTime;
    if (t < p.birthRampDown)
      return full + ((p.persistentCount - full) * t) / Math.max(p.birthRampDown, 1e-6);
    return p.persistentCount;
  }

  update(context: ParticleContext): void {
    const dt = context.dt;
    if (dt <= 0) return;
    const p = this.#shader.particles;
    const s = this.#state;
    // The living age and move.
    let alive = 0;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      const age = (s[o + 9] ?? 0) + dt;
      if (age >= (s[o + 10] ?? 0)) continue;
      const nx = s[o + 6] ?? 0;
      const ny = s[o + 7] ?? 0;
      const nz = s[o + 8] ?? 0;
      const ax = p.acceleration[0] + nx * p.accelerationAlongNormal;
      const ay = p.acceleration[1] + ny * p.accelerationAlongNormal;
      const az = p.acceleration[2] + nz * p.accelerationAlongNormal;
      const t = alive * STRIDE;
      for (let k = 0; k < STRIDE; k++) s[t + k] = s[o + k] ?? 0;
      s[t + 3] = (s[t + 3] ?? 0) + ax * dt;
      s[t + 4] = (s[t + 4] ?? 0) + ay * dt;
      s[t + 5] = (s[t + 5] ?? 0) + az * dt;
      s[t] = (s[t] ?? 0) + (s[t + 3] ?? 0) * dt;
      s[t + 1] = (s[t + 1] ?? 0) + (s[t + 4] ?? 0) * dt;
      s[t + 2] = (s[t + 2] ?? 0) + (s[t + 5] ?? 0) * dt;
      s[t + 9] = age;
      alive++;
    }
    this.count = alive;
    this.#age += dt;
    if (this.#stopping !== undefined) {
      this.#stopping += dt;
      return;
    }
    const body = this.#body();
    if (!body) return;
    if (body !== this.#sampledFor) this.#sample(body);
    if (this.#samples.length === 0) return;
    this.#births += this.birthRate(this.#age) * dt;
    while (this.#births >= 1 && this.count < MAX_PARTICLES) {
      this.#births -= 1;
      this.#born(body);
    }
    if (this.#births >= 1) this.#births = 0;
  }

  /** Picks the points of the skin particles are born at. */
  #sample(body: ParticleBody): void {
    this.#sampledFor = body;
    // An actor's skinned shapes; an object's (no pose) rigid ones.
    const pose = body.pose;
    const skinned = body.parts.filter((part) =>
      pose
        ? part.skin !== undefined && (part.layout.skinning ?? -1) >= 0 && part.vertexCount > 0
        : part.skin === undefined && part.vertexCount > 0 && part.billboard === undefined,
    );
    const samples: Sample[] = [];
    const total = skinned.reduce((sum, part) => sum + part.vertexCount, 0);
    if (total === 0) {
      this.#samples = [];
      return;
    }
    const nodes = new Map<ModelPart, Int16Array>();
    for (const part of skinned) {
      nodes.set(
        part,
        Int16Array.from(
          part.skin?.names ?? [],
          (name) => pose?.skeleton.nodeByName.get(name.toLowerCase()) ?? -1,
        ),
      );
    }
    for (let i = 0; i < SAMPLES; i++) {
      // Each shape by its share of the vertices.
      let pick = Math.floor(this.#random() * total);
      for (const part of skinned) {
        if (pick < part.vertexCount) {
          samples.push({ part, vertex: pick, nodes: nodes.get(part) ?? new Int16Array() });
          break;
        }
        pick -= part.vertexCount;
      }
    }
    this.#samples = samples;
  }

  /** One particle born at a point of the skin as the pose has it now. */
  #born(body: ParticleBody): void {
    const sample = this.#samples[Math.floor(this.#random() * this.#samples.length)];
    if (!sample) return;
    const point = this.#skinned(body, sample);
    if (!point) return;
    const p = this.#shader.particles;
    const random = this.#random;
    const o = this.count * STRIDE;
    const s = this.#state;
    const [x, y, z, nx, ny, nz] = point;
    const along = p.speedAlongNormal + (random() * 2 - 1) * p.speedAlongNormalVariation;
    s[o] = x;
    s[o + 1] = y;
    s[o + 2] = z;
    s[o + 3] = p.velocity[0] + nx * along;
    s[o + 4] = p.velocity[1] + ny * along;
    s[o + 5] = p.velocity[2] + nz * along;
    s[o + 6] = nx;
    s[o + 7] = ny;
    s[o + 8] = nz;
    s[o + 9] = 0;
    s[o + 10] = Math.max(0.05, p.lifetime + (random() * 2 - 1) * p.lifetimeVariation);
    s[o + 11] = Math.floor(random() * this.data.subtextures.length);
    s[o + 12] = (p.rotation + (random() * 2 - 1) * p.rotationVariation) * DEGREES;
    s[o + 13] = (p.rotationSpeed + (random() * 2 - 1) * p.rotationSpeedVariation) * DEGREES;
    this.count++;
  }

  /** A sample's place and normal in the world: its vertex skinned by the pose, then placed. */
  #skinned(
    body: ParticleBody,
    sample: Sample,
  ): [number, number, number, number, number, number] | undefined {
    const { part, vertex, nodes } = sample;
    const skin = part.skin;
    const skinning = part.layout.skinning;
    const view = new DataView(
      part.vertices.buffer,
      part.vertices.byteOffset,
      part.vertices.byteLength,
    );
    const base = vertex * part.layout.stride;
    const px = view.getFloat32(base, true);
    const py = view.getFloat32(base + 4, true);
    const pz = view.getFloat32(base + 8, true);
    const normal = normalAt(view, base + part.layout.normal, part.layout.normal >= 0);
    const worlds = body.pose?.worlds;
    // A rigid shape: its vertex where the model places the shape.
    if (!worlds) return placed(body.world, body.hang?.(part) ?? part.world, [px, py, pz], normal);
    if (!skin || skinning === undefined) return undefined;
    let x = 0;
    let y = 0;
    let z = 0;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let total = 0;
    const bone = this.#bone;
    for (let k = 0; k < 4; k++) {
      const weight = fromHalf(view.getUint16(base + skinning + k * 2, true));
      if (!(weight > 0)) continue;
      const index = view.getUint8(base + skinning + 8 + k);
      const node = nodes[index] ?? -1;
      if (node >= 0) writePaletteBone(bone, 0, worlds, node * 16, skin.bind, index * 16);
      else writePaletteBone(bone, 0, skin.rest, index * 16, skin.bind, index * 16);
      x +=
        weight * ((bone[0] ?? 0) * px + (bone[1] ?? 0) * py + (bone[2] ?? 0) * pz + (bone[3] ?? 0));
      y +=
        weight * ((bone[4] ?? 0) * px + (bone[5] ?? 0) * py + (bone[6] ?? 0) * pz + (bone[7] ?? 0));
      z +=
        weight *
        ((bone[8] ?? 0) * px + (bone[9] ?? 0) * py + (bone[10] ?? 0) * pz + (bone[11] ?? 0));
      nx +=
        weight *
        ((bone[0] ?? 0) * normal[0] + (bone[1] ?? 0) * normal[1] + (bone[2] ?? 0) * normal[2]);
      ny +=
        weight *
        ((bone[4] ?? 0) * normal[0] + (bone[5] ?? 0) * normal[1] + (bone[6] ?? 0) * normal[2]);
      nz +=
        weight *
        ((bone[8] ?? 0) * normal[0] + (bone[9] ?? 0) * normal[1] + (bone[10] ?? 0) * normal[2]);
      total += weight;
    }
    if (total <= 0) return undefined;
    return placed(body.world, IDENTITY, [x / total, y / total, z / total], [nx, ny, nz]);
  }

  write(out: Float32Array, offset: number): number {
    const p = this.#shader.particles;
    const s = this.#state;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let written = 0;
    const capacity = Math.floor((out.length - offset) / PARTICLE_FLOATS);
    for (let i = 0; i < this.count && written < capacity; i++) {
      const o = i * STRIDE;
      const age = s[o + 9] ?? 0;
      const life = s[o + 10] ?? 1;
      const t = Math.min(1, age / life);
      const size = scaleAt(p.scaleKeys, p.scaleTimes, t) / 2;
      const [r, g, b, a] = colorAt(p.colors, t);
      const frame = this.data.subtextures[s[o + 11] ?? 0] ?? [0, 0, 1, 1];
      const base = offset + written * PARTICLE_FLOATS;
      out[base] = s[o] ?? 0;
      out[base + 1] = s[o + 1] ?? 0;
      out[base + 2] = s[o + 2] ?? 0;
      out[base + 3] = size;
      out[base + 4] = r;
      out[base + 5] = g;
      out[base + 6] = b;
      out[base + 7] = a;
      out.set(frame, base + 8);
      out[base + 12] = 0;
      out[base + 13] = 0;
      out[base + 14] = 0;
      out[base + 15] = (s[o + 12] ?? 0) + (s[o + 13] ?? 0) * age;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] ?? 0, (s[o + k] ?? 0) - size);
        max[k] = Math.max(max[k] ?? 0, (s[o + k] ?? 0) + size);
      }
      written++;
    }
    if (written > 0) {
      for (let k = 0; k < 3; k++) this.center[k] = ((min[k] ?? 0) + (max[k] ?? 0)) / 2;
      this.radius = Math.hypot(
        (max[0] ?? 0) - this.center[0],
        (max[1] ?? 0) - this.center[1],
        (max[2] ?? 0) - this.center[2],
      );
    } else this.radius = 0;
    return written;
  }
}

/** A vertex normal (byte-packed signed, as the NIF vertex data stores it), or straight up. */
function normalAt(view: DataView, at: number, has: boolean): [number, number, number] {
  if (!has) return [0, 0, 1];
  const byte = (k: number): number => view.getUint8(at + k) / 127.5 - 1;
  return [byte(0), byte(1), byte(2)];
}

/** The size between the two scale keys (their times as shares of the life). */
export function scaleAt(
  keys: readonly [number, number],
  times: readonly [number, number],
  t: number,
): number {
  const [a, b] = keys;
  const [ta, tb] = times;
  if (t <= ta || tb <= ta) return t <= ta ? a : b;
  if (t >= tb) return b;
  return a + ((b - a) * (t - ta)) / (tb - ta);
}

/** The colour and alpha between the colour keys (their times as shares of the life). */
export function colorAt(
  keys: readonly {
    readonly color: readonly [number, number, number];
    readonly alpha: number;
    readonly time: number;
  }[],
  t: number,
): [number, number, number, number] {
  const first = keys[0];
  if (!first) return [1, 1, 1, 1];
  if (t <= first.time) return [...first.color, first.alpha];
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    const before = keys[i - 1];
    if (!key || !before) continue;
    if (t <= key.time && key.time > before.time) {
      const s = (t - before.time) / (key.time - before.time);
      const mix = (x: number, y: number): number => x + (y - x) * s;
      return [
        mix(before.color[0], key.color[0]),
        mix(before.color[1], key.color[1]),
        mix(before.color[2], key.color[2]),
        mix(before.alpha, key.alpha),
      ];
    }
  }
  const last = keys[keys.length - 1] ?? first;
  return [...last.color, last.alpha];
}

const IDENTITY: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A point and its normal through a shape's place in its model, then the model's in the world. */
function placed(
  world: Mat4,
  local: Mat4,
  point: readonly [number, number, number],
  normal: readonly [number, number, number],
): [number, number, number, number, number, number] {
  const at = (m: Mat4, v: readonly number[], w: number): [number, number, number] => {
    const [x = 0, y = 0, z = 0] = v;
    return [
      (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0) * w,
      (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0) * w,
      (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0) * w,
    ];
  };
  const [wx, wy, wz] = at(world, at(local, point, 1), 1);
  const [tx, ty, tz] = at(world, at(local, normal, 0), 0);
  const length = Math.hypot(tx, ty, tz) || 1;
  return [wx, wy, wz, tx / length, ty / length, tz / length];
}
