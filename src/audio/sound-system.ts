// The game's sounds: descriptors, output models and categories read from the plugins once,
// decoded files kept within a memory budget, one-shot sounds (a door opening) and the looping
// sounds of placed things (sound markers, torches, water wheels), which play while the
// listener is within their output model's range. Updated every frame with the camera.
// Notes: docs/audio.md.

import { invert } from '../render/frustum.ts';
import { transformPoint, type Mat4, type Vec3 } from '../render/math.ts';
import type { Camera } from '../render/view-camera.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import {
  parseAcousticSpace,
  parseReverb,
  parseSoundCategory,
  parseSoundDescriptor,
  parseSoundOutputModel,
  type AcousticSpace,
  type Reverb,
  type SoundDescriptor,
  type SoundOutputModel,
} from '../world/sound-records.ts';
import type { AudioLoader } from './audio-loader.ts';
import { AudioEngine } from './audio-engine.ts';
import { SoundInstance, type SoundBuffer, type SoundPlace } from './sound-instance.ts';

/** Decoded sound files kept for reuse (bytes of float samples). */
const BUFFER_BUDGET = 256 * 1024 * 1024;
/** A placed loop starts within its range and stops beyond it by this share more. */
const EMITTER_HYSTERESIS = 1.1;

/** A placed looping sound (CellSoundEmitter) as the system tracks it. */
export interface SoundEmitter {
  readonly reference: number;
  readonly position: readonly [number, number, number];
  readonly descriptor: number;
}

/** A placed acoustic space (CellAcousticArea): its box in the world. */
export interface AcousticArea {
  readonly reference: number;
  readonly space: number;
  readonly world: Mat4;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

interface EmitterState {
  readonly emitter: SoundEmitter;
  descriptor: SoundDescriptor | undefined;
  model: SoundOutputModel | undefined;
  /** Records looked up (descriptor and model). */
  ready: boolean;
  instance: SoundInstance | undefined;
  starting: boolean;
}

export class SoundSystem {
  readonly engine: AudioEngine;
  readonly #db: RecordDatabase;
  readonly #loader: AudioLoader;
  readonly #descriptors = new Map<number, Promise<SoundDescriptor | undefined>>();
  readonly #models = new Map<number, Promise<SoundOutputModel | undefined>>();
  readonly #reverbs = new Map<number, Promise<Reverb | undefined>>();
  readonly #buffers = new Map<
    string,
    { sound: Promise<SoundBuffer | undefined>; bytes: number; used: number }
  >();
  readonly #playing = new Set<SoundInstance>();
  readonly #emitters = new Map<number, EmitterState>();
  readonly #warned = new Set<string>();
  readonly #spaces = new Map<number, Promise<AcousticSpace | undefined>>();
  /** Exterior acoustic areas with their inverse placement. */
  #areas: { readonly area: AcousticArea; readonly toLocal: Mat4 }[] = [];
  /** The interior's acoustic space (cell XCAS), used when no area holds the listener. */
  #cellSpace: number | undefined;
  /** The acoustic space in effect, its ambience loop, and a counter against stale loads. */
  #space: number | undefined;
  #ambient: SoundInstance | undefined;
  #spaceVersion = 0;
  #listener: Vec3 = [0, 0, 0];
  #bufferBytes = 0;
  #random = 0x9e3779b9;

  private constructor(engine: AudioEngine, db: RecordDatabase, loader: AudioLoader) {
    this.engine = engine;
    this.#db = db;
    this.#loader = loader;
  }

  /** Reads the categories and starts the engine (silent until a user gesture resumes it). */
  static async create(db: RecordDatabase, loader: AudioLoader): Promise<SoundSystem> {
    const engine = new AudioEngine();
    const categories = await Promise.all(
      db.formIdsOfType('SNCT').map(async (formId) => {
        const record = await db.get(formId);
        return record && !record.deleted ? parseSoundCategory(record) : undefined;
      }),
    );
    engine.setCategories(categories.filter((category) => category !== undefined));
    return new SoundSystem(engine, db, loader);
  }

  /** What is going on (the shell and development tools show it). */
  get stats(): {
    playing: number;
    emitters: number;
    sounding: number;
    bufferBytes: number;
    space: number | undefined;
  } {
    return {
      playing: this.#playing.size,
      emitters: this.#emitters.size,
      sounding: [...this.#emitters.values()].filter((state) => state.instance).length,
      bufferBytes: this.#bufferBytes,
      space: this.#space,
    };
  }

  /** Plays a descriptor once (or until stopped, if it loops); undefined if it cannot. */
  async play(descriptorId: number, place?: SoundPlace): Promise<SoundInstance | undefined> {
    const descriptor = await this.descriptor(descriptorId);
    if (!descriptor) return undefined;
    const model =
      descriptor.outputModel === undefined
        ? undefined
        : await this.outputModel(descriptor.outputModel);
    return this.#start(descriptor, model, place);
  }

  /** The placed loops of the loaded cells (enabled ones); others stop. */
  setEmitters(emitters: readonly SoundEmitter[]): void {
    const keep = new Set<number>();
    for (const emitter of emitters) {
      keep.add(emitter.reference);
      if (this.#emitters.has(emitter.reference)) continue;
      const state: EmitterState = {
        emitter,
        descriptor: undefined,
        model: undefined,
        ready: false,
        instance: undefined,
        starting: false,
      };
      this.#emitters.set(emitter.reference, state);
      void this.descriptor(emitter.descriptor).then(async (descriptor) => {
        state.descriptor = descriptor;
        const modelId = descriptor?.outputModel;
        state.model = modelId === undefined ? undefined : await this.outputModel(modelId);
        state.ready = true;
      });
    }
    for (const [reference, state] of this.#emitters) {
      if (keep.has(reference)) continue;
      state.instance?.stop(true);
      this.#emitters.delete(reference);
    }
  }

  /** The acoustic space of an interior (cell XCAS), or none (exteriors). */
  setCellAcousticSpace(space: number | undefined): void {
    this.#cellSpace = space;
  }

  /** The placed acoustic spaces of the loaded exterior cells (enabled ones). */
  setAcousticAreas(areas: readonly AcousticArea[]): void {
    this.#areas = areas.flatMap((area) => {
      const toLocal = invert(area.world);
      return toLocal ? [{ area, toLocal }] : [];
    });
  }

  /** Every frame: the listener at the camera, sounds following, placed loops in range. */
  update(camera: Camera | undefined): void {
    if (!camera) return;
    const forward = camera.forward ?? [0, 1, 0];
    this.#listener = [...camera.position];
    this.engine.setListener(camera.position, forward);
    for (const instance of this.#playing) {
      if (instance.ended) {
        this.#playing.delete(instance);
        continue;
      }
      instance.update(this.#listener);
    }
    for (const state of this.#emitters.values()) this.#updateEmitter(state);
    this.#updateSpace();
  }

  acousticSpace(formId: number): Promise<AcousticSpace | undefined> {
    let entry = this.#spaces.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'ASPC' && !record.deleted ? parseAcousticSpace(record) : undefined,
        );
      this.#spaces.set(formId, entry);
    }
    return entry;
  }

  descriptor(formId: number): Promise<SoundDescriptor | undefined> {
    let entry = this.#descriptors.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'SNDR' && !record.deleted ? parseSoundDescriptor(record) : undefined,
        );
      this.#descriptors.set(formId, entry);
    }
    return entry;
  }

  outputModel(formId: number): Promise<SoundOutputModel | undefined> {
    let entry = this.#models.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'SOPM' && !record.deleted ? parseSoundOutputModel(record) : undefined,
        );
      this.#models.set(formId, entry);
    }
    return entry;
  }

  reverb(formId: number): Promise<Reverb | undefined> {
    let entry = this.#reverbs.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'REVB' && !record.deleted ? parseReverb(record) : undefined,
        );
      this.#reverbs.set(formId, entry);
    }
    return entry;
  }

  /** A decoded sound file on the audio context (kept within the budget). */
  buffer(path: string): Promise<SoundBuffer | undefined> {
    const cached = this.#buffers.get(path);
    if (cached) {
      cached.used = performance.now();
      return cached.sound;
    }
    const entry = {
      used: performance.now(),
      bytes: 0,
      sound: this.#loader.load(path).then(
        (decoded) => {
          if (!decoded) {
            this.#warn(`${path}: not found`);
            return undefined;
          }
          const frames = decoded.channels[0]?.length ?? 0;
          const buffer = this.engine.context.createBuffer(
            decoded.channels.length,
            Math.max(1, frames),
            decoded.sampleRate,
          );
          decoded.channels.forEach((channel, i) => {
            buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, i);
          });
          entry.bytes = frames * decoded.channels.length * 4;
          this.#bufferBytes += entry.bytes;
          this.#evict();
          return {
            buffer,
            ...(decoded.loop && {
              loop: {
                start: decoded.loop.start / decoded.sampleRate,
                end: decoded.loop.end / decoded.sampleRate,
              },
            }),
          };
        },
        (error: unknown) => {
          this.#warn(error instanceof Error ? error.message : String(error));
          return undefined;
        },
      ),
    };
    this.#buffers.set(path, entry);
    return entry.sound;
  }

  /** Stops everything (leaving a world). */
  stopAll(): void {
    for (const instance of this.#playing) instance.stop(true);
    this.#playing.clear();
    this.setEmitters([]);
    this.#areas = [];
    this.#cellSpace = undefined;
    this.#applySpace(undefined);
  }

  /** Called with problems worth logging (once per message). */
  onWarning: ((message: string) => void) | undefined;

  async #start(
    descriptor: SoundDescriptor,
    model: SoundOutputModel | undefined,
    place: SoundPlace,
  ): Promise<SoundInstance | undefined> {
    const files = descriptor.files;
    if (files.length === 0) return undefined;
    const path = files[Math.floor(this.#next() * files.length)] ?? files[0] ?? '';
    const sound = await this.buffer(path);
    if (!sound) return undefined;
    const instance = new SoundInstance(this.engine, sound, descriptor, model, place, () =>
      this.#next(),
    );
    instance.update(this.#listener);
    this.#playing.add(instance);
    return instance;
  }

  /** The acoustic space around the listener: an area holding it, else the interior's. */
  #updateSpace(): void {
    let space = this.#cellSpace;
    for (const { area, toLocal } of this.#areas) {
      const [x, y, z] = transformPoint(toLocal, this.#listener);
      if (
        x >= area.min[0] &&
        x <= area.max[0] &&
        y >= area.min[1] &&
        y <= area.max[1] &&
        z >= area.min[2] &&
        z <= area.max[2]
      ) {
        space = area.space;
        break;
      }
    }
    if (space !== this.#space) this.#applySpace(space);
  }

  /** Switches to an acoustic space: its reverb and its ambience loop (2D). */
  #applySpace(space: number | undefined): void {
    this.#space = space;
    const version = ++this.#spaceVersion;
    this.#ambient?.stop();
    this.#ambient = undefined;
    if (space === undefined) {
      this.engine.setReverb(undefined);
      return;
    }
    void this.acousticSpace(space).then(async (data) => {
      if (version !== this.#spaceVersion) return;
      const reverb = data?.reverb === undefined ? undefined : await this.reverb(data.reverb);
      if (version !== this.#spaceVersion) return;
      this.engine.setReverb(reverb);
      if (data?.ambient === undefined) return;
      const ambient = await this.play(data.ambient);
      if (version !== this.#spaceVersion) {
        ambient?.stop(true);
        return;
      }
      this.#ambient = ambient;
    });
  }

  #updateEmitter(state: EmitterState): void {
    if (!state.ready || !state.descriptor) return;
    const model = state.model;
    const [x, y, z] = state.emitter.position;
    const distance = Math.hypot(
      x - this.#listener[0],
      y - this.#listener[1],
      z - this.#listener[2],
    );
    // Without distance attenuation a loop plays wherever its cell is loaded.
    const range =
      model?.attenuatesWithDistance && model.attenuation
        ? model.attenuation.maxDistance
        : Number.POSITIVE_INFINITY;
    if (state.instance && (state.instance.ended || distance > range * EMITTER_HYSTERESIS)) {
      state.instance.stop(true);
      state.instance = undefined;
    }
    if (!state.instance && !state.starting && distance <= range) {
      state.starting = true;
      void this.#start(state.descriptor, model, state.emitter.position).then((instance) => {
        state.starting = false;
        // Removed while it was loading.
        if (this.#emitters.get(state.emitter.reference) !== state) {
          instance?.stop(true);
          return;
        }
        state.instance = instance;
      });
    }
  }

  /**
   * Drops the least recently used decoded files beyond the budget (sounds still playing keep
   * their buffer; only the cache lets go).
   */
  #evict(): void {
    if (this.#bufferBytes <= BUFFER_BUDGET) return;
    const entries = [...this.#buffers].sort((a, b) => a[1].used - b[1].used);
    for (const [path, entry] of entries) {
      if (this.#bufferBytes <= BUFFER_BUDGET) break;
      if (entry.bytes === 0) continue;
      this.#buffers.delete(path);
      this.#bufferBytes -= entry.bytes;
    }
  }

  #next(): number {
    // xorshift32: varied pitch and volume per instance without Math.random's cost.
    let x = this.#random;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#random = x >>> 0;
    return this.#random / 4294967296;
  }

  #warn(message: string): void {
    if (this.#warned.has(message)) return;
    this.#warned.add(message);
    this.onWarning?.(message);
  }
}
