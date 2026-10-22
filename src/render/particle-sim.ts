// Simulates one placed particle system (particle-data.ts) the way Gamebryo's NiPSys
// modifiers do: emitters driven by their controllers, age and death (with spawning), gravity,
// bombs, drag, wind, colliders, position updates and recycle bounds; colour, size, rotation
// and atlas frame are evaluated from each particle's age when it is drawn.
// Platform-independent (no GPU); the renderer uploads what `write` produces.
// Notes: docs/formats/nif.md ("Particles").

import type { Ref } from '../formats/nif/types.ts';
import { controllerTime, sampleBool, sampleFloat } from './animation.ts';
import { billboardWorld } from './billboard.ts';
import { invert } from './frustum.ts';
import { identity, maxScale, multiply, type Mat4, type Vec3 } from './math.ts';
import type {
  ParticleEmitter,
  ParticleParam,
  ParticleSystemData,
  ParticleTrack,
} from './particle-data.ts';

/** Floats per drawn particle: position, size, RGBA, atlas rect, axis, rotation. */
export const PARTICLE_FLOATS = 16;

/** What a system needs from the frame it is updated in. */
export interface ParticleContext {
  /** Seconds since the object was loaded (controller time). */
  readonly seconds: number;
  /** Seconds since the last update (clamped by the caller). */
  readonly dt: number;
  /** Placement of the model in the world. */
  readonly instanceWorld: Mat4;
  /** Model-space matrices of animated objects this frame (others keep their rest pose). */
  readonly animated: ReadonlyMap<Ref, Mat4> | undefined;
  readonly camera: Vec3;
  /** Wind velocity in world units per second (BSWindModifier scales it). */
  readonly wind: Vec3;
  /**
   * The sequences the object's behavior graph plays (lower-case name, start on the same
   * clock as `seconds`): their tracks drive the manager-controlled controllers.
   */
  readonly sequences?: readonly { readonly sequence: string; readonly start: number }[];
}

/**
 * What a scene's particle draw runs each frame: a NIF system's simulation, or particles another
 * part of the engine makes (an effect shader's off an actor's surfaces: src/shell/actor-effects.ts).
 */
export interface ParticleSource {
  readonly data: ParticleSystemData;
  /** Particles alive, and the instances `write` writes for them. */
  readonly count: number;
  readonly instanceCount: number;
  /** World-space bounds of the live particles after the last `write`. */
  readonly center: readonly [number, number, number];
  readonly radius: number;
  update(context: ParticleContext): void;
  /** Writes the instances (PARTICLE_FLOATS each) at `offset`; returns how many. */
  write(out: Float32Array, offset: number, context: ParticleContext): number;
}

/** Floats of per-particle state (see the S_* offsets). */
const STRIDE = 24;
const S_POS = 0;
const S_VEL = 3;
const S_AGE = 6;
const S_LIFE = 7;
const S_RADIUS = 8;
const S_ANGLE = 9;
const S_SPIN = 10;
const S_FRAME_START = 11;
const S_FRAME_COUNT = 12;
const S_LOOP_START = 13;
/** Fixed atlas frame (no BSPSysSubTexModifier), or −1. */
const S_FRAME_FIXED = 14;
const S_GENERATION = 15;
const S_COLOR = 16;
/** Strips: seconds since the last recorded point, recorded points, newest point's slot. */
const S_STRIP_TIME = 20;
const S_STRIP_COUNT = 21;
const S_STRIP_HEAD = 22;

/** Drag percentages are per frame of the 30 fps the effects were authored at. */
const DRAG_FRAME_RATE = 30;
/** Seconds simulated when a system first runs, so fires do not start empty. */
const WARM_UP_SECONDS = 1.5;
const WARM_UP_STEP = 1 / 15;

/** Deterministic random numbers (mulberry32): the same seed gives the same effect. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (m: Mat4, i: number): number => m[i] ?? 0;

/** Rotates (and scales) a vector by a matrix's upper 3×3. */
function rotate(m: Mat4, x: number, y: number, z: number, out: number[]): number[] {
  out[0] = at(m, 0) * x + at(m, 4) * y + at(m, 8) * z;
  out[1] = at(m, 1) * x + at(m, 5) * y + at(m, 9) * z;
  out[2] = at(m, 2) * x + at(m, 6) * y + at(m, 10) * z;
  return out;
}

function point(m: Mat4, x: number, y: number, z: number, out: number[]): number[] {
  rotate(m, x, y, z, out);
  out[0] = (out[0] ?? 0) + at(m, 12);
  out[1] = (out[1] ?? 0) + at(m, 13);
  out[2] = (out[2] ?? 0) + at(m, 14);
  return out;
}

function normalize(v: number[]): number[] {
  const length = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  if (length > 1e-9) {
    v[0] = (v[0] ?? 0) / length;
    v[1] = (v[1] ?? 0) / length;
    v[2] = (v[2] ?? 0) / length;
  }
  return v;
}

/** Direction at a declination from Z and a planar angle around it (from X). */
function spherical(declination: number, planar: number, out: number[]): number[] {
  const sin = Math.sin(declination);
  out[0] = sin * Math.cos(planar);
  out[1] = sin * Math.sin(planar);
  out[2] = Math.cos(declination);
  return out;
}

/** Linear interpolation through evenly spaced keys over 0..1. */
export function evenKeys(keys: readonly number[], t: number): number {
  if (keys.length === 0) return 1;
  if (keys.length === 1) return keys[0] ?? 1;
  const x = Math.min(1, Math.max(0, t)) * (keys.length - 1);
  const i = Math.min(keys.length - 2, Math.floor(x));
  const a = keys[i] ?? 1;
  const b = keys[i + 1] ?? a;
  return a + (b - a) * (x - i);
}

/**
 * BSPSysSimpleColorModifier at a fraction of the particle's life: colour 1 until
 * `color1End`, blending to colour 2 by `color1Start`, colour 2 until `color2End`, blending
 * to colour 3 by `color2Start`; alpha rises from colour 1's to colour 2's until `fadeIn` and
 * falls to colour 3's from `fadeOut`.
 */
export function simpleColor(
  color: NonNullable<ParticleSystemData['modifiers']['color']>,
  t: number,
  out: number[],
): number[] {
  const c = color.colors;
  const channel = (index: number, k: number): number => c[index * 4 + k] ?? 1;
  const blend = (from: number, to: number, s: number): void => {
    const u = Math.min(1, Math.max(0, s));
    for (let k = 0; k < 3; k++) out[k] = channel(from, k) + (channel(to, k) - channel(from, k)) * u;
  };
  if (t <= color.color1End) blend(0, 0, 0);
  else if (t < color.color1Start) {
    blend(0, 1, (t - color.color1End) / (color.color1Start - color.color1End));
  } else if (t <= color.color2End) blend(1, 1, 0);
  else if (t < color.color2Start) {
    blend(1, 2, (t - color.color2End) / (color.color2Start - color.color2End));
  } else blend(2, 2, 0);
  const a0 = channel(0, 3);
  const a1 = channel(1, 3);
  const a2 = channel(2, 3);
  if (t < color.fadeIn && color.fadeIn > 0) out[3] = a0 + (a1 - a0) * (t / color.fadeIn);
  else if (t > color.fadeOut && color.fadeOut < 1) {
    out[3] = a1 + (a2 - a1) * Math.min(1, (t - color.fadeOut) / (1 - color.fadeOut));
  } else out[3] = a1;
  return out;
}

/**
 * BSPSysSubTexModifier: the atlas frame at a fraction of the particle's life. Frames run
 * from `start` at `count` frames per life; past `end` they loop from `loopStart` (a loop
 * start at the end frame holds it).
 */
export function subTextureFrame(
  start: number,
  count: number,
  loopStart: number,
  end: number,
  t: number,
): number {
  const frame = Math.floor(start + t * count);
  if (frame <= end) return Math.max(0, frame);
  const first = Math.min(loopStart, end);
  const span = end - first + 1;
  return first + ((frame - end - 1) % span);
}

export class ParticleSimulation implements ParticleSource {
  readonly data: ParticleSystemData;
  /** Particles alive. */
  count = 0;
  /** World-space bounds of the live particles after the last `write`. */
  readonly center: [number, number, number] = [0, 0, 0];
  radius = 0;
  readonly #state: Float32Array;
  readonly #strip: Float32Array | undefined;
  readonly #random: () => number;
  readonly #emitAccumulator: Float64Array;
  /** Animated parameters this update, by `${target}|${param}`. */
  readonly #params = new Map<string, number>();
  #started = false;
  #lodEmit = 1;
  #lodSize = 1;
  // Matrices of the current update.
  readonly #toSim = identity();
  readonly #simToWorld = identity();
  readonly #objectToSim = identity();
  /** Where each object was last update (sim space), for BSPSysInheritVelocityModifier. */
  readonly #objectPositions = new Map<Ref, [number, number, number]>();
  readonly #objectVelocity: [number, number, number] = [0, 0, 0];
  // Scratch vectors.
  readonly #a: number[] = [0, 0, 0];
  readonly #b: number[] = [0, 0, 0];
  readonly #c: number[] = [0, 0, 0, 0];

  constructor(data: ParticleSystemData, seed: number) {
    this.data = data;
    this.#state = new Float32Array(data.maxParticles * STRIDE);
    this.#strip = data.strip
      ? new Float32Array(data.maxParticles * data.strip.maxPoints * 3)
      : undefined;
    this.#random = random(seed);
    this.#emitAccumulator = new Float64Array(data.emitters.length);
  }

  /** Advances the system to `context.seconds` (the first call warms it up). */
  update(context: ParticleContext): void {
    if (!this.#started) {
      this.#started = true;
      for (let t = WARM_UP_SECONDS; t > 0; t -= WARM_UP_STEP) {
        this.#step({ ...context, seconds: context.seconds - t, dt: WARM_UP_STEP });
      }
    }
    if (context.dt > 0) this.#step(context);
  }

  /**
   * Writes the live particles (or strip segments) as instance data from `offset` (in floats)
   * and returns how many were written; updates the world bounds.
   */
  write(out: Float32Array, offset: number, context: ParticleContext): number {
    const data = this.data;
    const s = this.#state;
    const toWorld = this.#simToWorldFor(context);
    const worldScale = maxScale(toWorld) * this.#lodSize;
    const color = data.modifiers.color;
    const subTexture = data.modifiers.subTexture;
    const frames = data.subtextures;
    const p = this.#a;
    const v = this.#b;
    const c = this.#c;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let written = 0;
    const capacity = Math.floor((out.length - offset) / PARTICLE_FLOATS);
    for (let i = 0; i < this.count && written < capacity; i++) {
      const o = i * STRIDE;
      const life = s[o + S_LIFE] ?? 1;
      const age = s[o + S_AGE] ?? 0;
      const t = life > 0 ? Math.min(1, age / life) : 1;
      if (color) simpleColor(color, t, c);
      else for (let k = 0; k < 4; k++) c[k] = s[o + S_COLOR + k] ?? 1;
      const scale = data.modifiers.scales ? evenKeys(data.modifiers.scales, t) : 1;
      const size = (s[o + S_RADIUS] ?? 0) * scale * worldScale;
      let frame = s[o + S_FRAME_FIXED] ?? -1;
      if (frame < 0 && subTexture) {
        frame = subTextureFrame(
          s[o + S_FRAME_START] ?? 0,
          s[o + S_FRAME_COUNT] ?? 0,
          s[o + S_LOOP_START] ?? 0,
          subTexture.endFrame,
          t,
        );
      }
      const rect = frames[Math.min(frames.length - 1, Math.max(0, frame))] ?? [0, 0, 1, 1];
      point(toWorld, s[o + S_POS] ?? 0, s[o + S_POS + 1] ?? 0, s[o + S_POS + 2] ?? 0, p);

      const emitSegment = (
        x0: number,
        y0: number,
        z0: number,
        x1: number,
        y1: number,
        z1: number,
        v0: number,
        v1: number,
      ): void => {
        if (written >= capacity) return;
        const base = offset + written * PARTICLE_FLOATS;
        out[base] = x0;
        out[base + 1] = y0;
        out[base + 2] = z0;
        out[base + 3] = size;
        out[base + 4] = c[0] ?? 1;
        out[base + 5] = c[1] ?? 1;
        out[base + 6] = c[2] ?? 1;
        out[base + 7] = c[3] ?? 1;
        out[base + 8] = rect[0];
        out[base + 9] = rect[1] + rect[3] * v0;
        out[base + 10] = rect[2];
        out[base + 11] = rect[3] * (v1 - v0);
        out[base + 12] = x1 - x0;
        out[base + 13] = y1 - y0;
        out[base + 14] = z1 - z0;
        out[base + 15] = 0;
        written++;
      };

      const strip = this.#strip;
      if (strip && data.strip) {
        // The ribbon from the oldest recorded point to the particle.
        const points = data.strip.maxPoints;
        const recorded = s[o + S_STRIP_COUNT] ?? 0;
        const head = s[o + S_STRIP_HEAD] ?? 0;
        const total = recorded + 1;
        let previous: number[] | undefined;
        const q = [0, 0, 0];
        for (let k = recorded - 1; k >= -1; k--) {
          if (k >= 0) {
            const slot = (((head - k) % points) + points) % points;
            const base = (i * points + slot) * 3;
            point(toWorld, strip[base] ?? 0, strip[base + 1] ?? 0, strip[base + 2] ?? 0, q);
          } else {
            q[0] = p[0] ?? 0;
            q[1] = p[1] ?? 0;
            q[2] = p[2] ?? 0;
          }
          const index = recorded - 1 - k;
          if (previous) {
            emitSegment(
              previous[0] ?? 0,
              previous[1] ?? 0,
              previous[2] ?? 0,
              q[0] ?? 0,
              q[1] ?? 0,
              q[2] ?? 0,
              (index - 1) / Math.max(1, total - 1),
              index / Math.max(1, total - 1),
            );
          }
          previous = [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0];
        }
      } else {
        const base = offset + written * PARTICLE_FLOATS;
        out[base] = p[0] ?? 0;
        out[base + 1] = p[1] ?? 0;
        out[base + 2] = p[2] ?? 0;
        out[base + 3] = size;
        out[base + 4] = c[0] ?? 1;
        out[base + 5] = c[1] ?? 1;
        out[base + 6] = c[2] ?? 1;
        out[base + 7] = c[3] ?? 1;
        out.set(rect, base + 8);
        if (data.velocityOriented) {
          rotate(toWorld, s[o + S_VEL] ?? 0, s[o + S_VEL + 1] ?? 0, s[o + S_VEL + 2] ?? 0, v);
          out[base + 12] = v[0] ?? 0;
          out[base + 13] = v[1] ?? 0;
          out[base + 14] = v[2] ?? 0;
        } else {
          out[base + 12] = 0;
          out[base + 13] = 0;
          out[base + 14] = 0;
        }
        out[base + 15] = (s[o + S_ANGLE] ?? 0) + (s[o + S_SPIN] ?? 0) * age;
        written++;
      }
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] ?? 0, (p[k] ?? 0) - size);
        max[k] = Math.max(max[k] ?? 0, (p[k] ?? 0) + size);
      }
    }
    if (this.count > 0) {
      for (let k = 0; k < 3; k++) this.center[k] = ((min[k] ?? 0) + (max[k] ?? 0)) / 2;
      this.radius = Math.hypot(
        (max[0] ?? 0) - this.center[0],
        (max[1] ?? 0) - this.center[1],
        (max[2] ?? 0) - this.center[2],
      );
    } else {
      this.radius = 0;
    }
    return written;
  }

  /** How many instances `write` produces at most for the live particles. */
  get instanceCount(): number {
    return this.data.strip ? this.count * this.data.strip.maxPoints : this.count;
  }

  #simToWorldFor(context: ParticleContext): Mat4 {
    if (this.data.worldSpace) return identity();
    return multiply(context.instanceWorld, this.#objectWorld(context, this.data.block));
  }

  #objectWorld(context: ParticleContext, ref: Ref): Mat4 {
    const animated = context.animated?.get(ref);
    if (animated) return animated;
    const billboard = this.data.billboards.get(ref);
    if (billboard) {
      // Billboards turn in the world (towards the camera): back to model space.
      const node = multiply(context.instanceWorld, billboard.node);
      const world = multiply(billboardWorld(node, billboard.mode, context.camera), billboard.local);
      return multiply(invert(context.instanceWorld) ?? identity(), world);
    }
    return (
      this.data.objects.get(ref) ??
      context.animated?.get(this.data.block) ??
      this.data.objects.get(this.data.block) ??
      identity()
    );
  }

  /** Model space → simulation space of an object's frame. */
  #objectFrame(context: ParticleContext, ref: Ref): Mat4 {
    return multiply(this.#toSim, this.#objectWorld(context, ref), this.#objectToSim);
  }

  #param(target: string, param: ParticleParam, fallback: number): number {
    return this.#params.get(`${target}|${param}`) ?? fallback;
  }

  #active(name: string): boolean {
    const value = this.#params.get(`${name}|modifierActive`);
    return value !== undefined ? value !== 0 : !this.data.modifiers.inactive.includes(name);
  }

  #step(context: ParticleContext): void {
    const data = this.data;
    const dt = context.dt;
    const s = this.#state;
    const rand = this.#random;

    // Controllers.
    this.#params.clear();
    const apply = (track: ParticleTrack, seconds: number): void => {
      const time = controllerTime(track.timing, seconds);
      const value =
        track.kind === 'float'
          ? sampleFloat(track.source, time)
          : sampleBool(track.source, time)
            ? 1
            : 0;
      this.#params.set(`${track.target}|${track.param}`, value);
    };
    for (const track of data.tracks) apply(track, context.seconds);
    for (const playing of context.sequences ?? []) {
      for (const track of data.sequenceTracks.get(playing.sequence) ?? []) {
        apply(track, context.seconds - playing.start);
      }
    }

    // Spaces: particles live in world space or in the system's own frame.
    const systemWorld = this.#objectWorld(context, data.block);
    if (data.worldSpace) {
      this.#toSim.set(context.instanceWorld);
      this.#simToWorld.set(identity());
    } else {
      this.#toSim.set(invert(systemWorld) ?? identity());
      multiply(context.instanceWorld, systemWorld, this.#simToWorld);
    }

    // Distance LOD.
    const lod = data.modifiers.lod;
    this.#lodEmit = 1;
    this.#lodSize = 1;
    if (lod) {
      const position = multiply(context.instanceWorld, systemWorld);
      const distance = Math.hypot(
        at(position, 12) - context.camera[0],
        at(position, 13) - context.camera[1],
        at(position, 14) - context.camera[2],
      );
      const t =
        lod.end > lod.begin
          ? Math.min(1, Math.max(0, (distance - lod.begin) / (lod.end - lod.begin)))
          : distance >= lod.end
            ? 1
            : 0;
      this.#lodEmit = 1 + (lod.endEmitScale - 1) * t;
      this.#lodSize = 1 + (lod.endSize - 1) * t;
    }

    // Age and death.
    const spawn = data.modifiers.spawn;
    for (let i = 0; i < this.count;) {
      const o = i * STRIDE;
      const age = (s[o + S_AGE] ?? 0) + dt;
      s[o + S_AGE] = age;
      if (age >= (s[o + S_LIFE] ?? 0)) {
        if (data.modifiers.spawnOnDeath && spawn) this.#spawnFrom(i);
        this.#kill(i);
      } else {
        i++;
      }
    }

    this.#applyForces(context, dt);
    this.#collide(context, dt);

    // Position update (and strip points).
    const strip = data.strip;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      for (let k = 0; k < 3; k++)
        s[o + S_POS + k] = (s[o + S_POS + k] ?? 0) + (s[o + S_VEL + k] ?? 0) * dt;
      if (strip && this.#strip) {
        const since = (s[o + S_STRIP_TIME] ?? 0) + dt;
        if (since >= strip.updateDelta) {
          this.#recordStripPoint(i);
          s[o + S_STRIP_TIME] = since % strip.updateDelta;
        } else {
          s[o + S_STRIP_TIME] = since;
        }
      }
    }

    // Emission (after the update, with each new particle's age within this step).
    this.#updateObjectVelocity(context, dt);
    data.emitters.forEach((emitter, index) => {
      const rate = this.#param(emitter.name, 'birthRate', NaN);
      const on = this.#param(emitter.name, 'emitterActive', 1) !== 0;
      if (!Number.isFinite(rate) || rate <= 0 || !on || !this.#active(emitter.name)) {
        this.#emitAccumulator[index] = 0;
        return;
      }
      const total = (this.#emitAccumulator[index] ?? 0) + rate * this.#lodEmit * dt;
      const count = Math.floor(total);
      this.#emitAccumulator[index] = total - count;
      for (let k = 0; k < count; k++) this.#emit(context, emitter, (dt * (k + rand())) / count);
    });

    this.#recycle(context);
  }

  #kill(index: number): void {
    const last = this.count - 1;
    if (index !== last) {
      this.#state.copyWithin(index * STRIDE, last * STRIDE, (last + 1) * STRIDE);
      const strip = this.#strip;
      const points = this.data.strip?.maxPoints ?? 0;
      if (strip) {
        strip.copyWithin(index * points * 3, last * points * 3, (last + 1) * points * 3);
      }
    }
    this.count = last;
  }

  #recordStripPoint(index: number): void {
    const strip = this.#strip;
    const points = this.data.strip?.maxPoints ?? 0;
    if (!strip || points === 0) return;
    const s = this.#state;
    const o = index * STRIDE;
    const head = ((s[o + S_STRIP_HEAD] ?? 0) + 1) % points;
    const base = (index * points + head) * 3;
    strip[base] = s[o + S_POS] ?? 0;
    strip[base + 1] = s[o + S_POS + 1] ?? 0;
    strip[base + 2] = s[o + S_POS + 2] ?? 0;
    s[o + S_STRIP_HEAD] = head;
    s[o + S_STRIP_COUNT] = Math.min(points - 1, (s[o + S_STRIP_COUNT] ?? 0) + 1);
  }

  /** A new particle slot, or −1 when the system is full. */
  #allocate(): number {
    if (this.count >= this.data.maxParticles) return -1;
    const index = this.count++;
    const o = index * STRIDE;
    this.#state.fill(0, o, o + STRIDE);
    return index;
  }

  #emit(context: ParticleContext, emitter: ParticleEmitter, age: number): void {
    const data = this.data;
    const rand = this.#random;
    const symmetric = (): number => rand() * 2 - 1;
    const index = this.#allocate();
    if (index < 0) return;
    const s = this.#state;
    const o = index * STRIDE;
    const name = emitter.name;
    const speed =
      this.#param(name, 'speed', emitter.speed) + emitter.speedVariation * (rand() - 0.5);
    const declination =
      this.#param(name, 'declination', emitter.declination) +
      this.#param(name, 'declinationVariation', emitter.declinationVariation) * symmetric();
    const planar =
      this.#param(name, 'planarAngle', emitter.planarAngle) +
      this.#param(name, 'planarAngleVariation', emitter.planarAngleVariation) * symmetric();
    const position = this.#a;
    const direction = this.#b;
    let frame: Mat4;

    if (emitter.shape === 'mesh') {
      frame = this.#toSim;
      this.#meshPoint(emitter, declination, planar, position, direction);
    } else {
      frame = this.#objectFrame(context, emitter.object);
      const [sx, sy, sz] = emitter.size;
      if (emitter.shape === 'box') {
        position[0] = sx * (rand() - 0.5);
        position[1] = sy * (rand() - 0.5);
        position[2] = sz * (rand() - 0.5);
      } else if (emitter.shape === 'cylinder') {
        const angle = rand() * Math.PI * 2;
        const distance = sx * Math.sqrt(rand());
        position[0] = distance * Math.cos(angle);
        position[1] = distance * Math.sin(angle);
        position[2] = sy * (rand() - 0.5);
      } else {
        spherical(Math.acos(symmetric()), rand() * Math.PI * 2, position);
        const distance = sx * Math.cbrt(rand());
        for (let k = 0; k < 3; k++) position[k] = (position[k] ?? 0) * distance;
      }
      spherical(declination, planar, direction);
    }
    point(frame, position[0] ?? 0, position[1] ?? 0, position[2] ?? 0, position);
    rotate(frame, direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0, direction);
    const scale = maxScale(frame);

    for (let k = 0; k < 3; k++) {
      const velocity = (direction[k] ?? 0) * speed;
      s[o + S_VEL + k] = velocity;
      s[o + S_POS + k] = (position[k] ?? 0) + velocity * age;
    }
    const inherit = data.modifiers.inheritVelocity;
    if (inherit && rand() * 100 < inherit.chance) {
      const factor = inherit.multiplier + inherit.variation * symmetric();
      for (let k = 0; k < 3; k++) {
        s[o + S_VEL + k] = (s[o + S_VEL + k] ?? 0) + (this.#objectVelocity[k] ?? 0) * factor;
      }
    }
    s[o + S_AGE] = age;
    s[o + S_LIFE] = Math.max(
      0.01,
      this.#param(name, 'lifeSpan', emitter.lifeSpan) + emitter.lifeSpanVariation * (rand() - 0.5),
    );
    s[o + S_RADIUS] =
      Math.max(
        0,
        this.#param(name, 'radius', emitter.radius) + emitter.radiusVariation * (rand() - 0.5),
      ) * scale;
    s.set(emitter.color, o + S_COLOR);
    this.#initRotationAndFrame(o);
    if (data.strip) this.#recordStripPoint(index);
  }

  #initRotationAndFrame(o: number): void {
    const data = this.data;
    const s = this.#state;
    const rand = this.#random;
    const rotation = data.modifiers.rotation;
    if (rotation && this.#active(rotation.name)) {
      const name = rotation.name;
      s[o + S_ANGLE] =
        this.#param(name, 'rotationAngle', rotation.angle) +
        this.#param(name, 'rotationAngleVariation', rotation.angleVariation) * (rand() * 2 - 1);
      let spin =
        this.#param(name, 'rotationSpeed', rotation.speed) +
        this.#param(name, 'rotationSpeedVariation', rotation.speedVariation) * (rand() - 0.5);
      if (rotation.randomSign && rand() < 0.5) spin = -spin;
      s[o + S_SPIN] = spin;
    }
    const subTexture = data.modifiers.subTexture;
    if (subTexture && this.#active(subTexture.name)) {
      s[o + S_FRAME_FIXED] = -1;
      s[o + S_FRAME_START] =
        subTexture.startFrame + Math.floor(rand() * subTexture.startFrameFudge);
      s[o + S_FRAME_COUNT] = Math.max(
        0,
        subTexture.frameCount + subTexture.frameCountFudge * (rand() * 2 - 1),
      );
      s[o + S_LOOP_START] =
        subTexture.loopStartFrame + Math.floor(rand() * subTexture.loopStartFrameFudge);
    } else {
      // Without the modifier each particle shows one random frame of the atlas.
      s[o + S_FRAME_FIXED] =
        data.subtextures.length > 1 ? Math.floor(rand() * data.subtextures.length) : 0;
    }
  }

  /** A point on an emitter mesh and its starting direction (model space). */
  #meshPoint(
    emitter: ParticleEmitter,
    declination: number,
    planar: number,
    position: number[],
    direction: number[],
  ): void {
    const rand = this.#random;
    const mesh = emitter.meshes[Math.floor(rand() * emitter.meshes.length)];
    if (!mesh) return;
    const { positions, normals, indices } = mesh;
    const triangle = Math.floor(rand() * (indices.length / 3)) * 3;
    const corner = (k: number): number => indices[triangle + k] ?? 0;
    const blend = (weights: readonly number[], source: Float32Array, out: number[]): void => {
      for (let axis = 0; axis < 3; axis++) {
        out[axis] =
          (weights[0] ?? 0) * (source[corner(0) * 3 + axis] ?? 0) +
          (weights[1] ?? 0) * (source[corner(1) * 3 + axis] ?? 0) +
          (weights[2] ?? 0) * (source[corner(2) * 3 + axis] ?? 0);
      }
    };
    let weights: number[];
    switch (emitter.emissionType) {
      case 0: {
        weights = [0, 0, 0];
        weights[Math.floor(rand() * 3)] = 1;
        break;
      }
      case 1:
        weights = [1 / 3, 1 / 3, 1 / 3];
        break;
      case 2:
      case 4: {
        const edge = Math.floor(rand() * 3);
        const along = emitter.emissionType === 2 ? 0.5 : rand();
        weights = [0, 0, 0];
        weights[edge] = 1 - along;
        weights[(edge + 1) % 3] = along;
        break;
      }
      default: {
        let u = rand();
        let v = rand();
        if (u + v > 1) {
          u = 1 - u;
          v = 1 - v;
        }
        weights = [1 - u - v, u, v];
      }
    }
    blend(weights, positions, position);
    const normal = this.#c;
    blend(weights, normals, normal);
    normalize(normal);
    if (emitter.velocityType === 1) {
      spherical(Math.acos(rand() * 2 - 1), rand() * Math.PI * 2, direction);
      return;
    }
    const axis = emitter.velocityType === 2 ? [...emitter.emissionAxis] : normal;
    normalize(axis);
    // Declination and planar angle relative to that axis.
    const local = spherical(declination, planar, [0, 0, 0]);
    const ax = axis[0] ?? 0;
    const ay = axis[1] ?? 0;
    const az = axis[2] ?? 1;
    const helper = Math.abs(az) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const tx = (helper[1] ?? 0) * az - (helper[2] ?? 0) * ay;
    const ty = (helper[2] ?? 0) * ax - (helper[0] ?? 0) * az;
    const tz = (helper[0] ?? 0) * ay - (helper[1] ?? 0) * ax;
    const tangent = normalize([tx, ty, tz]);
    const bx = ay * (tangent[2] ?? 0) - az * (tangent[1] ?? 0);
    const by = az * (tangent[0] ?? 0) - ax * (tangent[2] ?? 0);
    const bz = ax * (tangent[1] ?? 0) - ay * (tangent[0] ?? 0);
    const [lx = 0, ly = 0, lz = 1] = local;
    direction[0] = (tangent[0] ?? 0) * lx + bx * ly + ax * lz;
    direction[1] = (tangent[1] ?? 0) * lx + by * ly + ay * lz;
    direction[2] = (tangent[2] ?? 0) * lx + bz * ly + az * lz;
  }

  /** NiPSysSpawnModifier: new particles where one died or collided. */
  #spawnFrom(index: number): void {
    const spawn = this.data.modifiers.spawn;
    if (!spawn || !this.#active(spawn.name)) return;
    const rand = this.#random;
    const s = this.#state;
    const o = index * STRIDE;
    const generation = s[o + S_GENERATION] ?? 0;
    if (spawn.generations > 0 && generation >= spawn.generations) return;
    if (rand() > spawn.percentage) return;
    const count =
      spawn.minCount +
      Math.floor(rand() * (Math.max(spawn.maxCount, spawn.minCount) - spawn.minCount + 1));
    for (let n = 0; n < count; n++) {
      const child = this.#allocate();
      if (child < 0) return;
      const c = child * STRIDE;
      s.copyWithin(c, o, o + STRIDE);
      const speed = Math.hypot(s[c + S_VEL] ?? 0, s[c + S_VEL + 1] ?? 0, s[c + S_VEL + 2] ?? 0);
      const factor = 1 + (spawn.speedVariation * (rand() * 2 - 1)) / Math.max(speed, 1e-6);
      for (let k = 0; k < 3; k++) {
        const jitter = spawn.directionVariation * (rand() * 2 - 1) * speed;
        s[c + S_VEL + k] = (s[c + S_VEL + k] ?? 0) * factor + jitter;
      }
      s[c + S_AGE] = 0;
      s[c + S_LIFE] = Math.max(0.01, spawn.lifeSpan + spawn.lifeSpanVariation * (rand() - 0.5));
      s[c + S_GENERATION] = generation + 1;
      s[c + S_STRIP_COUNT] = 0;
      this.#initRotationAndFrame(c);
    }
  }

  #updateObjectVelocity(context: ParticleContext, dt: number): void {
    const inherit = this.data.modifiers.inheritVelocity;
    if (!inherit) return;
    const frame = this.#objectFrame(context, inherit.object);
    const now: [number, number, number] = [at(frame, 12), at(frame, 13), at(frame, 14)];
    const before = this.#objectPositions.get(inherit.object);
    for (let k = 0; k < 3; k++) {
      this.#objectVelocity[k] = before && dt > 0 ? ((now[k] ?? 0) - (before[k] ?? 0)) / dt : 0;
    }
    this.#objectPositions.set(inherit.object, now);
  }

  #applyForces(context: ParticleContext, dt: number): void {
    const data = this.data;
    const s = this.#state;
    const rand = this.#random;
    const axis = this.#a;
    const temp = this.#b;
    const modifiers = data.modifiers;

    for (const gravity of modifiers.gravity) {
      if (!this.#active(gravity.name)) continue;
      const strength = this.#param(gravity.name, 'gravityStrength', gravity.strength);
      const frame = this.#objectFrame(context, gravity.object);
      if (gravity.worldAligned) {
        // World axis → simulation space.
        if (data.worldSpace) {
          axis[0] = gravity.axis[0];
          axis[1] = gravity.axis[1];
          axis[2] = gravity.axis[2];
        } else {
          const inverse = invert(this.#simToWorld) ?? identity();
          rotate(inverse, gravity.axis[0], gravity.axis[1], gravity.axis[2], axis);
        }
      } else {
        rotate(frame, gravity.axis[0], gravity.axis[1], gravity.axis[2], axis);
      }
      normalize(axis);
      const gx = at(frame, 12);
      const gy = at(frame, 13);
      const gz = at(frame, 14);
      for (let i = 0; i < this.count; i++) {
        const o = i * STRIDE;
        const dx = gx - (s[o + S_POS] ?? 0);
        const dy = gy - (s[o + S_POS + 1] ?? 0);
        const dz = gz - (s[o + S_POS + 2] ?? 0);
        let fx: number;
        let fy: number;
        let fz: number;
        let distance: number;
        if (gravity.forceType === 1) {
          distance = Math.hypot(dx, dy, dz);
          const inverse = distance > 1e-6 ? 1 / distance : 0;
          fx = dx * inverse;
          fy = dy * inverse;
          fz = dz * inverse;
        } else {
          distance = Math.abs(dx * (axis[0] ?? 0) + dy * (axis[1] ?? 0) + dz * (axis[2] ?? 0));
          fx = axis[0] ?? 0;
          fy = axis[1] ?? 0;
          fz = axis[2] ?? 0;
        }
        const magnitude =
          strength * (gravity.decay > 0 ? Math.exp(-gravity.decay * distance) : 1) * dt;
        s[o + S_VEL] = (s[o + S_VEL] ?? 0) + fx * magnitude;
        s[o + S_VEL + 1] = (s[o + S_VEL + 1] ?? 0) + fy * magnitude;
        s[o + S_VEL + 2] = (s[o + S_VEL + 2] ?? 0) + fz * magnitude;
        if (gravity.turbulence > 0) {
          const amount = gravity.turbulence * gravity.turbulenceScale * Math.abs(strength) * dt;
          for (let k = 0; k < 3; k++) {
            s[o + S_VEL + k] = (s[o + S_VEL + k] ?? 0) + (rand() * 2 - 1) * amount;
          }
        }
      }
    }

    for (const bomb of modifiers.bombs) {
      if (!this.#active(bomb.name)) continue;
      const frame = this.#objectFrame(context, bomb.object);
      rotate(frame, bomb.axis[0], bomb.axis[1], bomb.axis[2], axis);
      normalize(axis);
      const bx = at(frame, 12);
      const by = at(frame, 13);
      const bz = at(frame, 14);
      for (let i = 0; i < this.count; i++) {
        const o = i * STRIDE;
        let tx = (s[o + S_POS] ?? 0) - bx;
        let ty = (s[o + S_POS + 1] ?? 0) - by;
        let tz = (s[o + S_POS + 2] ?? 0) - bz;
        const ax = axis[0] ?? 0;
        const ay = axis[1] ?? 0;
        const az = axis[2] ?? 0;
        const along = tx * ax + ty * ay + tz * az;
        if (bomb.symmetryType === 1) {
          // Cylindrical: away from the axis line.
          tx -= ax * along;
          ty -= ay * along;
          tz -= az * along;
        } else if (bomb.symmetryType === 2) {
          // Planar: away from the plane through the bomb.
          tx = ax * along;
          ty = ay * along;
          tz = az * along;
        }
        temp[0] = tx;
        temp[1] = ty;
        temp[2] = tz;
        const distance = Math.hypot(tx, ty, tz);
        if (distance < 1e-6) continue;
        let factor = 1;
        if (bomb.decayType === 1)
          factor = bomb.decay > 0 ? Math.max(0, 1 - distance / bomb.decay) : 0;
        else if (bomb.decayType === 2)
          factor = bomb.decay > 0 ? Math.exp(-distance / bomb.decay) : 0;
        const change = (bomb.deltaV * factor * dt) / distance;
        for (let k = 0; k < 3; k++)
          s[o + S_VEL + k] = (s[o + S_VEL + k] ?? 0) + (temp[k] ?? 0) * change;
      }
    }

    for (const drag of modifiers.drag) {
      if (!this.#active(drag.name) || drag.percentage <= 0) continue;
      const frame = this.#objectFrame(context, drag.object);
      rotate(frame, drag.axis[0], drag.axis[1], drag.axis[2], axis);
      normalize(axis);
      const keep = Math.pow(Math.max(0, 1 - Math.min(1, drag.percentage)), dt * DRAG_FRAME_RATE);
      const limited = Number.isFinite(drag.range) && drag.range < 1e30;
      const ox = at(frame, 12);
      const oy = at(frame, 13);
      const oz = at(frame, 14);
      for (let i = 0; i < this.count; i++) {
        const o = i * STRIDE;
        let amount = 1 - keep;
        if (limited) {
          const distance = Math.hypot(
            (s[o + S_POS] ?? 0) - ox,
            (s[o + S_POS + 1] ?? 0) - oy,
            (s[o + S_POS + 2] ?? 0) - oz,
          );
          if (distance > drag.range + drag.rangeFalloff) continue;
          if (distance > drag.range && drag.rangeFalloff > 0) {
            amount *= 1 - (distance - drag.range) / drag.rangeFalloff;
          }
        }
        const along =
          (s[o + S_VEL] ?? 0) * (axis[0] ?? 0) +
          (s[o + S_VEL + 1] ?? 0) * (axis[1] ?? 0) +
          (s[o + S_VEL + 2] ?? 0) * (axis[2] ?? 0);
        for (let k = 0; k < 3; k++) {
          s[o + S_VEL + k] = (s[o + S_VEL + k] ?? 0) - (axis[k] ?? 0) * along * amount;
        }
      }
    }

    if (modifiers.wind !== 0) {
      // The wind pushes particles towards its own velocity.
      const inverse = data.worldSpace ? undefined : invert(this.#simToWorld);
      const wind = inverse
        ? rotate(inverse, context.wind[0], context.wind[1], context.wind[2], temp)
        : [context.wind[0], context.wind[1], context.wind[2]];
      const amount = Math.min(1, modifiers.wind * dt);
      for (let i = 0; i < this.count; i++) {
        const o = i * STRIDE;
        for (let k = 0; k < 3; k++) {
          const velocity = s[o + S_VEL + k] ?? 0;
          s[o + S_VEL + k] = velocity + ((wind[k] ?? 0) - velocity) * amount;
        }
      }
    }
  }

  #collide(context: ParticleContext, dt: number): void {
    const s = this.#state;
    for (const collider of this.data.modifiers.colliders) {
      if (!this.#active(collider.name)) continue;
      const frame = this.#objectFrame(context, collider.object);
      const cx = at(frame, 12);
      const cy = at(frame, 13);
      const cz = at(frame, 14);
      if (collider.shape === 'plane') {
        const x = normalize(rotate(frame, ...collider.xAxis, [0, 0, 0]));
        const y = normalize(rotate(frame, ...collider.yAxis, [0, 0, 0]));
        const scale = maxScale(frame);
        const halfWidth = (collider.width * scale) / 2;
        const halfHeight = (collider.height * scale) / 2;
        const nx = (x[1] ?? 0) * (y[2] ?? 0) - (x[2] ?? 0) * (y[1] ?? 0);
        const ny = (x[2] ?? 0) * (y[0] ?? 0) - (x[0] ?? 0) * (y[2] ?? 0);
        const nz = (x[0] ?? 0) * (y[1] ?? 0) - (x[1] ?? 0) * (y[0] ?? 0);
        for (let i = 0; i < this.count; i++) {
          const o = i * STRIDE;
          const px = (s[o + S_POS] ?? 0) - cx;
          const py = (s[o + S_POS + 1] ?? 0) - cy;
          const pz = (s[o + S_POS + 2] ?? 0) - cz;
          const vx = s[o + S_VEL] ?? 0;
          const vy = s[o + S_VEL + 1] ?? 0;
          const vz = s[o + S_VEL + 2] ?? 0;
          const before = px * nx + py * ny + pz * nz;
          const after = before + (vx * nx + vy * ny + vz * nz) * dt;
          if (before === 0 || Math.sign(before) === Math.sign(after)) continue;
          // Where it crosses the plane: inside the rectangle?
          const t = before / (before - after);
          const hx = px + vx * dt * t;
          const hy = py + vy * dt * t;
          const hz = pz + vz * dt * t;
          const u = hx * (x[0] ?? 0) + hy * (x[1] ?? 0) + hz * (x[2] ?? 0);
          const w = hx * (y[0] ?? 0) + hy * (y[1] ?? 0) + hz * (y[2] ?? 0);
          if (Math.abs(u) > halfWidth || Math.abs(w) > halfHeight) continue;
          if (this.#collided(i, collider)) {
            i--;
            continue;
          }
          const normalSpeed = vx * nx + vy * ny + vz * nz;
          s[o + S_VEL] = vx - nx * normalSpeed * (1 + collider.bounce);
          s[o + S_VEL + 1] = vy - ny * normalSpeed * (1 + collider.bounce);
          s[o + S_VEL + 2] = vz - nz * normalSpeed * (1 + collider.bounce);
        }
      } else {
        const radius = collider.radius * maxScale(frame);
        for (let i = 0; i < this.count; i++) {
          const o = i * STRIDE;
          const px = (s[o + S_POS] ?? 0) - cx;
          const py = (s[o + S_POS + 1] ?? 0) - cy;
          const pz = (s[o + S_POS + 2] ?? 0) - cz;
          const vx = s[o + S_VEL] ?? 0;
          const vy = s[o + S_VEL + 1] ?? 0;
          const vz = s[o + S_VEL + 2] ?? 0;
          const before = Math.hypot(px, py, pz);
          const after = Math.hypot(px + vx * dt, py + vy * dt, pz + vz * dt);
          if ((before - radius) * (after - radius) >= 0) continue;
          if (this.#collided(i, collider)) {
            i--;
            continue;
          }
          const inverse = before > 1e-6 ? 1 / before : 0;
          const nx = px * inverse;
          const ny = py * inverse;
          const nz = pz * inverse;
          const normalSpeed = vx * nx + vy * ny + vz * nz;
          s[o + S_VEL] = vx - nx * normalSpeed * (1 + collider.bounce);
          s[o + S_VEL + 1] = vy - ny * normalSpeed * (1 + collider.bounce);
          s[o + S_VEL + 2] = vz - nz * normalSpeed * (1 + collider.bounce);
        }
      }
    }
  }

  /** Spawning and dying on a collision; true if the particle is gone. */
  #collided(
    index: number,
    collider: ParticleSystemData['modifiers']['colliders'][number],
  ): boolean {
    if (collider.spawnOnCollide) this.#spawnFrom(index);
    if (!collider.dieOnCollide) return false;
    this.#kill(index);
    return true;
  }

  #recycle(context: ParticleContext): void {
    const bound = this.data.modifiers.recycleBound;
    if (!bound) return;
    const frame = this.#objectFrame(context, bound.object);
    const inverse = invert(frame);
    if (!inverse) return;
    const s = this.#state;
    const local = this.#a;
    const world = this.#b;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      point(inverse, s[o + S_POS] ?? 0, s[o + S_POS + 1] ?? 0, s[o + S_POS + 2] ?? 0, local);
      let moved = false;
      for (let k = 0; k < 3; k++) {
        const extent = bound.extent[k] ?? 0;
        if (extent <= 0) continue;
        const min = bound.offset[k] ?? 0;
        const value = local[k] ?? 0;
        if (value < min || value > min + extent) {
          local[k] = min + ((((value - min) % extent) + extent) % extent);
          moved = true;
        }
      }
      if (moved) {
        point(frame, local[0] ?? 0, local[1] ?? 0, local[2] ?? 0, world);
        for (let k = 0; k < 3; k++) s[o + S_POS + k] = world[k] ?? 0;
      }
    }
  }
}
