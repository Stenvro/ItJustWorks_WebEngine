// The game's sounds: descriptors, output models and categories read from the plugins once,
// decoded files kept within a memory budget, one-shot sounds (a door opening) and the looping
// sounds of placed things (sound markers, torches, water wheels), which play while the
// listener is within their output model's range; the ambience of regions and weather; and the
// music. Updated every frame with the camera. Notes: docs/audio.md.

import { invert } from '../render/frustum.ts';
import { transformPoint, type Mat4, type Vec3 } from '../render/math.ts';
import type { Camera } from '../render/view-camera.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import {
  parseAcousticSpace,
  parseMusicTrack,
  parseMusicType,
  parseReverb,
  parseSoundCategory,
  parseSoundDescriptor,
  parseSoundOutputModel,
  type AcousticSpace,
  type MusicTrack,
  type MusicType,
  type Reverb,
  type SoundDescriptor,
  type SoundOutputModel,
} from '../world/sound-records.ts';
import { ConditionFunction, type Condition } from '../scripting/conditions.ts';
import type { IniSettings } from '../world/ini-settings.ts';
import { parseRegionAudio, type RegionAudio } from '../world/sound-records.ts';
import { DefaultObjects, DefaultObjectUse } from '../world/default-objects.ts';
import { Ambience, ambientConditions, type AmbientState } from './ambience.ts';
import { Music } from './music.ts';
import { WaterAudio } from './water-audio.ts';
import {
  impactAgainst,
  ImpactSounds,
  landMaterial,
  type ImpactHit,
  type ImpactRecords,
} from './impacts.ts';
import {
  parseFootstep,
  parseFootstepSet,
  type Footstep,
  type FootstepGait,
  type FootstepGround,
  type FootstepSet,
} from '../world/footstep-records.ts';
import {
  parseImpact,
  parseImpactDataSet,
  type Impact,
  type ImpactDataSet,
} from '../world/impact-records.ts';
import { materialId, parseMaterialType, type MaterialType } from '../world/material-type.ts';
import { WebMusicOutput } from './music-output.ts';
import type { AudioLoader } from './audio-loader.ts';
import { AudioEngine } from './audio-engine.ts';
import { SoundInstance, type SoundBuffer, type SoundPlace } from './sound-instance.ts';

/** Decoded sound files kept for reuse (bytes of float samples). */
const BUFFER_BUDGET = 256 * 1024 * 1024;
/** A placed loop starts within its range and stops beyond it by this share more. */
const EMITTER_HYSTERESIS = 1.1;
/** The collision material of water volumes (MaterialWater). */
const WATER_MATERIAL = materialId('Water');

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

/** A spoken line, loaded (SoundSystem.voiceLine). */
export interface VoiceLine {
  /** Seconds of audio. */
  readonly duration: number;
  /** Its lip-sync data (src/formats/audio/lip.ts), if it has any. */
  readonly lip?: Uint8Array;
  play(place: SoundPlace): Promise<SoundInstance | undefined>;
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
  readonly #regionAudio = new Map<number, Promise<RegionAudio | undefined>>();
  /** Global variables that sound conditions read (GLOB FLTV). */
  readonly #globals = new Map<number, Promise<number>>();
  readonly #globalValues = new Map<number, number>();
  readonly #ini: IniSettings;
  readonly #ambience: Ambience;
  /** The music (development tools add and remove music types through it). */
  readonly music: Music;
  readonly #musicOutput: WebMusicOutput;
  readonly #musicTypes = new Map<number, Promise<MusicType | undefined>>();
  readonly #musicTracks = new Map<number, Promise<MusicTrack | undefined>>();
  /** DFMS: the music where nothing names any. */
  readonly #defaultMusic: number | undefined;
  readonly #impacts: ImpactSounds;
  readonly #water: WaterAudio;
  readonly #waterSounds = new Map<number, Promise<number | undefined>>();
  /** UWLS: the loop under water, and the one playing. */
  readonly #underwaterSound: number | undefined;
  /** DDSC and DOP2: the category and 3D output model of spoken lines. */
  readonly #dialogueCategory: number | undefined;
  readonly #dialogueOutput: number | undefined;
  #underwater: { loop: SoundInstance | undefined; dropped: boolean } | undefined;
  #materials:
    Promise<{ byId: Map<number, MaterialType>; byForm: Map<number, MaterialType> }> | undefined;
  readonly #impactSets = new Map<number, Promise<ImpactDataSet | undefined>>();
  readonly #impactRecords = new Map<number, Promise<Impact | undefined>>();
  readonly #footstepSets = new Map<number, Promise<FootstepSet | undefined>>();
  readonly #footsteps = new Map<number, Promise<Footstep | undefined>>();
  #namedDescriptors: Promise<Map<string, number>> | undefined;
  /** The records impacts and footsteps resolve through. */
  readonly #impactSources: ImpactRecords;
  /** What the viewers last said about the surroundings (regions, weather, time). */
  #ambient: AmbientState | undefined;
  /** An interior's sound region (its acoustic space's RDAT). */
  #spaceRegion: number | undefined;
  /** Exterior acoustic areas with their inverse placement. */
  #areas: { readonly area: AcousticArea; readonly toLocal: Mat4 }[] = [];
  /** The interior's acoustic space (cell XCAS), used when no area holds the listener. */
  #cellSpace: number | undefined;
  /** A menu's acoustic space (the map's) and its fade time, over the world's. */
  #menuSpace: number | undefined;
  #menuFade: number | undefined;
  /** The acoustic space in effect, its ambience loop, and a counter against stale loads. */
  #space: number | undefined;
  #ambientLoop: SoundInstance | undefined;
  #spaceVersion = 0;
  /** The default objects (the sounds the engine plays where records name none). */
  readonly defaults: DefaultObjects;
  #listener: Vec3 = [0, 0, 0];
  #bufferBytes = 0;
  #random = 0x9e3779b9;

  private constructor(
    engine: AudioEngine,
    db: RecordDatabase,
    loader: AudioLoader,
    ini: IniSettings,
    defaults: DefaultObjects,
  ) {
    this.engine = engine;
    this.defaults = defaults;
    this.#db = db;
    this.#loader = loader;
    this.#ini = ini;
    this.#defaultMusic = defaults.get(DefaultObjectUse.defaultMusic);
    this.#underwaterSound = defaults.get(DefaultObjectUse.underwaterLoop);
    this.#dialogueCategory = defaults.get(DefaultObjectUse.dialogueCategory);
    this.#dialogueOutput = defaults.get(DefaultObjectUse.dialogueOutput3d);
    this.#water = new WaterAudio(
      {
        waterSound: (type) => this.#waterSound(type),
        play: (sound, place, fadeIn) => this.play(sound, place, fadeIn),
      },
      ini,
    );
    this.#impactSources = {
      materialById: async (id) => (await this.#materialTypes()).byId.get(id),
      material: async (formId) => (await this.#materialTypes()).byForm.get(formId),
      impactDataSet: (formId) => this.#impactDataSet(formId),
      impact: (formId) => this.#impact(formId),
      landMaterial: defaults.get(DefaultObjectUse.landMaterial),
      landMaterialAt: (position) => this.landMaterialAt?.(position),
    };
    this.#impacts = new ImpactSounds(
      this.#impactSources,
      {
        heavySpeed: ini.number('Audio', 'fCollisionSoundHeavyThreshold'),
        interval: ini.number('Audio', 'iCollisionSoundTimeDelta') / 1000,
      },
      (sound, position) => void this.play(sound, position),
    );
    this.#musicOutput = new WebMusicOutput(
      engine,
      loader,
      {
        musicType: (formId) => this.musicType(formId),
        musicTrack: (formId) => this.musicTrack(formId),
      },
      defaults.get(DefaultObjectUse.musicCategory),
      (message) => {
        this.#warn(message);
      },
    );
    this.music = new Music(
      this.#musicOutput,
      {
        duckingSeconds: ini.number('Audio', 'fMusicDuckingSeconds'),
        unDuckingSeconds: ini.number('Audio', 'fMusicUnDuckingSeconds'),
        finaleFadeIn: ini.number('Audio', 'fMusicFinaleCrossFadeTimeIn'),
        finaleFadeOut: ini.number('Audio', 'fMusicFinaleCrossFadeTimeOut'),
      },
      () => this.#next(),
    );
    this.#ambience = new Ambience(
      {
        descriptor: (formId) => this.descriptor(formId),
        regionAudio: (formId) => this.regionAudio(formId),
        global: (formId) => this.#globalValue(formId),
        play: (descriptor, place, fadeIn) => this.play(descriptor, place, fadeIn),
      },
      ini,
      () => this.#next(),
    );
  }

  /** Reads the categories and starts the engine (silent until a user gesture resumes it). */
  static async create(
    db: RecordDatabase,
    loader: AudioLoader,
    ini: IniSettings,
  ): Promise<SoundSystem> {
    const engine = new AudioEngine();
    const categories = await Promise.all(
      db.formIdsOfType('SNCT').map(async (formId) => {
        const record = await db.get(formId);
        return record && !record.deleted ? parseSoundCategory(record) : undefined;
      }),
    );
    engine.setCategories(categories.filter((category) => category !== undefined));
    return new SoundSystem(engine, db, loader, ini, await DefaultObjects.read(db));
  }

  /** What is going on (the shell and development tools show it). */
  get stats(): {
    playing: number;
    emitters: number;
    sounding: number;
    bufferBytes: number;
    space: number | undefined;
    /** Region and weather loops playing (SNDR form ids). */
    ambience: { regionLoops: number[]; weatherLoops: number[] };
    music: Music['state'];
    /** Music files kept ready (WAV bytes). */
    musicBytes: number;
    /** Water loops playing (SNDR form ids). */
    water: number[];
    underwater: boolean;
  } {
    return {
      playing: this.#playing.size,
      emitters: this.#emitters.size,
      sounding: [...this.#emitters.values()].filter((state) => state.instance).length,
      bufferBytes: this.#bufferBytes,
      space: this.#space,
      ambience: this.#ambience.loops,
      music: this.music.state,
      musicBytes: this.#musicOutput.bytes,
      water: this.#water.playing,
      underwater: this.#underwater !== undefined,
    };
  }

  /** Plays a descriptor once (or until stopped, if it loops); undefined if it cannot. */
  async play(
    descriptorId: number,
    place?: SoundPlace,
    fadeIn = 0,
  ): Promise<SoundInstance | undefined> {
    const descriptor = await this.descriptor(descriptorId);
    if (!descriptor) return undefined;
    const model =
      descriptor.outputModel === undefined
        ? undefined
        : await this.outputModel(descriptor.outputModel);
    return this.#start(descriptor, model, place, fadeIn);
  }

  /**
   * A spoken line (a voice file: .fuz, or .xwm/.wav with a .lip), loaded: its lip-sync data,
   * and `play` starting it at a place as dialogue plays (the dialogue category, through the
   * 3D dialogue output model). Undefined if the file cannot be read.
   */
  async voiceLine(path: string): Promise<VoiceLine | undefined> {
    const sound = await this.buffer(path);
    if (!sound) return undefined;
    const outputModel = this.#dialogueOutput;
    const model = outputModel === undefined ? undefined : await this.outputModel(outputModel);
    const descriptor: SoundDescriptor = {
      formId: 0,
      editorId: path,
      category: this.#dialogueCategory,
      alternateFor: undefined,
      files: [path],
      outputModel,
      looping: 'none',
      frequencyShift: 0,
      frequencyVariance: 0,
      priority: 0,
      dbVariance: 0,
      staticAttenuation: 0,
      conditions: [],
    };
    return {
      duration: sound.buffer.duration,
      ...(sound.lip && { lip: sound.lip }),
      play: (place) => this.#start(descriptor, model, place),
    };
  }

  /**
   * Under water: the categories that mute under water fall silent and the underwater loop
   * (default object UWLS) plays.
   */
  #setUnderwater(underwater: boolean): void {
    if (underwater === (this.#underwater !== undefined)) return;
    this.engine.setSubmerged(underwater);
    if (!underwater) {
      const state = this.#underwater;
      this.#underwater = undefined;
      if (state) {
        state.dropped = true;
        state.loop?.stop();
      }
      return;
    }
    const state: { loop: SoundInstance | undefined; dropped: boolean } = {
      loop: undefined,
      dropped: false,
    };
    this.#underwater = state;
    if (this.#underwaterSound === undefined) return;
    void this.play(this.#underwaterSound).then((loop) => {
      if (state.dropped) loop?.stop(true);
      else state.loop = loop;
    });
  }

  /** A water type's open sound (WATR SNAM). */
  #waterSound(type: number): Promise<number | undefined> {
    let entry = this.#waterSounds.get(type);
    if (!entry) {
      entry = this.#db.get(type).then((record) => {
        if (record?.type !== 'WATR' || record.deleted) return undefined;
        const formId = record.formIdField('SNAM');
        return formId === 0 ? undefined : formId;
      });
      this.#waterSounds.set(type, entry);
    }
    return entry;
  }

  /**
   * The material (MATT form id) of the land texture at a point, set by the viewers (they know
   * the loaded landscape); undefined: the default land material.
   */
  landMaterialAt: ((position: Vec3) => number | undefined) | undefined;

  /**
   * An actor's footstep: the footstep of its set answering an animation event (`tag`) in its
   * gait (else in the walking one), sounding the impact of its impact data set for the ground
   * at `position` (a material id, or the landscape's by its land texture), or for the water the
   * feet are in (its type's material). False if the set answers nothing to the event.
   */
  async footstep(
    set: number,
    tag: string,
    gait: FootstepGait,
    position: Vec3,
    ground: FootstepGround,
  ): Promise<boolean> {
    const footsteps = await this.#footstepSet(set);
    if (!footsteps) return false;
    const lower = tag.toLowerCase();
    const find = async (ids: readonly number[] | undefined): Promise<Footstep | undefined> => {
      for (const id of ids ?? []) {
        const footstep = await this.#footstep(id);
        if (footstep?.tag.toLowerCase() === lower) return footstep;
      }
      return undefined;
    };
    const footstep =
      (await find(footsteps.gaits.get(gait))) ?? (await find(footsteps.gaits.get('walk')));
    if (footstep?.impactDataSet === undefined) return false;
    const impactSet = await this.#impactDataSet(footstep.impactDataSet);
    if (!impactSet) return true;
    const records = this.#impactSources;
    const material =
      'water' in ground
        ? await this.#waterMaterial(ground.water)
        : ground.material !== 0
          ? await records.materialById(ground.material)
          : ground.landscape
            ? await landMaterial(records, position)
            : undefined;
    const impact = await impactAgainst(records, impactSet, material);
    if (impact?.sound !== undefined) void this.play(impact.sound, position);
    return true;
  }

  /**
   * The material of a water type: its own (WATR TNAM: MaterialWaterPuddle for the puddles and
   * ankle-deep interior waters), else that of water's collision (the WATER phantoms' Water).
   */
  async #waterMaterial(type: number): Promise<MaterialType | undefined> {
    const record = await this.#db.get(type);
    const own = record?.type === 'WATR' && !record.deleted ? record.formIdField('TNAM') : 0;
    const materials = await this.#materialTypes();
    return (own ? materials.byForm.get(own) : undefined) ?? materials.byId.get(WATER_MATERIAL);
  }

  /**
   * Plays a sound by editor id at a place (animations' SoundPlay events; the menus' PlaySound,
   * at no place): a sound descriptor's (SNDR), else a sound's (SOUN: its descriptor, SDSC).
   */
  async playNamed(editorId: string, place: SoundPlace): Promise<SoundInstance | undefined> {
    const byName = await this.#descriptorNames();
    const formId = byName.get(editorId.toLowerCase());
    return formId === undefined ? undefined : this.play(formId, place);
  }

  #descriptorNames(): Promise<Map<string, number>> {
    this.#namedDescriptors ??= (async () => {
      const names = new Map<string, number>();
      for (const formId of this.#db.formIdsOfType('SNDR')) {
        const record = await this.#db.get(formId);
        if (record?.editorId && !record.deleted) names.set(record.editorId.toLowerCase(), formId);
      }
      for (const formId of this.#db.formIdsOfType('SOUN')) {
        const record = await this.#db.get(formId);
        if (!record || record.deleted) continue;
        const descriptor = record.formIdField('SDSC');
        const name = record.editorId?.toLowerCase();
        if (name && descriptor && !names.has(name)) names.set(name, descriptor);
      }
      return names;
    })();
    return this.#namedDescriptors;
  }

  #footstepSet(formId: number): Promise<FootstepSet | undefined> {
    let entry = this.#footstepSets.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'FSTS' && !record.deleted ? parseFootstepSet(record) : undefined,
        );
      this.#footstepSets.set(formId, entry);
    }
    return entry;
  }

  #footstep(formId: number): Promise<Footstep | undefined> {
    let entry = this.#footsteps.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'FSTP' && !record.deleted ? parseFootstep(record) : undefined,
        );
      this.#footsteps.set(formId, entry);
    }
    return entry;
  }

  /** A physics collision: the impact sound of the materials that met. */
  impact(hit: ImpactHit): void {
    void this.#impacts.hit(hit, performance.now() / 1000);
  }

  /** The material types (MATT) by collision id and by form id, read once. */
  #materialTypes(): Promise<{
    byId: Map<number, MaterialType>;
    byForm: Map<number, MaterialType>;
  }> {
    this.#materials ??= (async () => {
      const byId = new Map<number, MaterialType>();
      const byForm = new Map<number, MaterialType>();
      for (const formId of this.#db.formIdsOfType('MATT')) {
        const record = await this.#db.get(formId);
        if (!record || record.deleted) continue;
        const material = parseMaterialType(record);
        byId.set(material.id, material);
        byForm.set(material.formId, material);
      }
      return { byId, byForm };
    })();
    return this.#materials;
  }

  #impactDataSet(formId: number): Promise<ImpactDataSet | undefined> {
    let entry = this.#impactSets.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'IPDS' && !record.deleted ? parseImpactDataSet(record) : undefined,
        );
      this.#impactSets.set(formId, entry);
    }
    return entry;
  }

  #impact(formId: number): Promise<Impact | undefined> {
    let entry = this.#impactRecords.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'IPCT' && !record.deleted ? parseImpact(record) : undefined,
        );
      this.#impactRecords.set(formId, entry);
    }
    return entry;
  }

  /** The surroundings for ambience: regions, weather, time of day (every frame). */
  setAmbience(state: AmbientState | undefined): void {
    if (!state && this.#ambient) {
      this.#ambience.stop();
      this.music.stop();
      this.#musicOutput.stop();
      this.#water.stop();
      this.#setUnderwater(false);
    }
    this.#ambient = state;
  }

  regionAudio(formId: number): Promise<RegionAudio | undefined> {
    let entry = this.#regionAudio.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'REGN' && !record.deleted ? parseRegionAudio(record) : undefined,
        );
      this.#regionAudio.set(formId, entry);
    }
    return entry;
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

  /**
   * A menu's acoustic space over the world's (the map's UIWorldMap), fading over
   * `fadeSeconds`;
   * undefined gives the world's back.
   */
  setMenuSpace(space: number | undefined, fadeSeconds?: number): void {
    this.#menuSpace = space;
    this.#menuFade = fadeSeconds;
    this.#updateSpace();
    if (space === undefined) this.#menuFade = undefined;
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
    const ambient = this.#ambient;
    if (ambient) {
      const regions =
        ambient.interior && this.#spaceRegion !== undefined ? [this.#spaceRegion] : ambient.regions;
      this.#ambience.update({ ...ambient, regions }, this.#listener, performance.now() / 1000);
    }
    this.#water.update(this.#listener, ambient?.waterAt, performance.now() / 1000);
    this.#setUnderwater(ambient?.underwater ?? false);
    // Music runs on the audio clock, and only while audio plays (it would skip through its
    // tracks before the first user gesture otherwise).
    if (ambient && this.engine.context.state === 'running') {
      const location = this.#locationMusic(ambient);
      if (location !== null) this.music.setLocation(location);
      this.#musicOutput.update();
      this.music.update(
        this.engine.context.currentTime,
        ambientConditions(ambient, (formId) => this.#globalValue(formId)),
      );
    }
  }

  musicType(formId: number): Promise<MusicType | undefined> {
    let entry = this.#musicTypes.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'MUSC' && !record.deleted ? parseMusicType(record) : undefined,
        );
      this.#musicTypes.set(formId, entry);
    }
    return entry;
  }

  musicTrack(formId: number): Promise<MusicTrack | undefined> {
    let entry = this.#musicTracks.get(formId);
    if (!entry) {
      entry = this.#db.get(formId).then(async (record) => {
        if (record?.type !== 'MUST' || record.deleted) return undefined;
        const track = parseMusicTrack(record);
        await this.#conditionGlobals(track.conditions);
        return track;
      });
      this.#musicTracks.set(formId, entry);
    }
    return entry;
  }

  /**
   * The location's music: the cell's (XCMO); indoors else the default (DFMS); outdoors else
   * its regions' (RDMO), the worldspace's (ZNAM), the default. null: the regions are still
   * being read.
   */
  #locationMusic(ambient: AmbientState): number | undefined | null {
    if (ambient.cellMusic !== undefined) return ambient.cellMusic;
    if (ambient.interior) return this.#defaultMusic;
    const region = this.#ambience.regionMusic;
    if (!region.ready) return null;
    return region.music ?? ambient.worldMusic ?? this.#defaultMusic;
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
      entry = this.#db.get(formId).then(async (record) => {
        if (record?.type !== 'SNDR' || record.deleted) return undefined;
        const descriptor = parseSoundDescriptor(record);
        await this.#conditionGlobals(descriptor.conditions);
        return descriptor;
      });
      this.#descriptors.set(formId, entry);
    }
    return entry;
  }

  /** The globals conditions read load with them: conditions are checked synchronously. */
  async #conditionGlobals(conditions: readonly Condition[]): Promise<void> {
    await Promise.all(
      conditions.flatMap((condition) => [
        ...(condition.function === ConditionFunction.getGlobalValue
          ? [this.#global(condition.form)]
          : []),
        ...(typeof condition.comparand === 'number'
          ? []
          : [this.#global(condition.comparand.global)]),
      ]),
    );
  }

  /**
   * The running game's value of a global (scripts set them, e.g. CWDistantCatapultsAMB during
   * a civil war battle; the clock's move), else its starting value.
   */
  #globalValue(formId: number): number {
    return this.globals?.(formId) ?? this.#globalValues.get(formId) ?? 0;
  }

  /** The running game's globals (the scripts'), once they run. */
  globals: ((formId: number) => number | undefined) | undefined;

  /** Loads a global variable's starting value (FLTV). */
  #global(formId: number): Promise<number> {
    let entry = this.#globals.get(formId);
    if (!entry) {
      entry = this.#db.get(formId).then((record) => {
        const value =
          record?.type === 'GLOB' && !record.deleted ? (record.fields.f32('FLTV') ?? 0) : 0;
        this.#globalValues.set(formId, value);
        return value;
      });
      this.#globals.set(formId, entry);
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
            ...(decoded.lip && { lip: decoded.lip }),
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
    this.#ambience.stop();
    this.#ambient = undefined;
    this.music.stop();
    this.#musicOutput.stop();
    this.#water.stop();
    this.#setUnderwater(false);
  }

  /** Frees the music kept ready (the session ends). */
  dispose(): void {
    this.stopAll();
    this.#musicOutput.dispose();
  }

  /** Called with problems worth logging (once per message). */
  onWarning: ((message: string) => void) | undefined;

  async #start(
    descriptor: SoundDescriptor,
    model: SoundOutputModel | undefined,
    place: SoundPlace,
    fadeIn = 0,
  ): Promise<SoundInstance | undefined> {
    const files = descriptor.files;
    if (files.length === 0) return undefined;
    const path = files[Math.floor(this.#next() * files.length)] ?? files[0] ?? '';
    const sound = await this.buffer(path);
    if (!sound) return undefined;
    const instance = new SoundInstance(
      this.engine,
      sound,
      descriptor,
      model,
      place,
      () => this.#next(),
      fadeIn,
    );
    instance.update(this.#listener);
    this.#playing.add(instance);
    return instance;
  }

  /** The acoustic space around the listener: an area holding it, else the interior's. */
  #updateSpace(): void {
    let space = this.#menuSpace ?? this.#cellSpace;
    for (const { area, toLocal } of this.#menuSpace === undefined ? this.#areas : []) {
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
    // [Audio] fASFadeInTime and fASFadeOutTime: a space's ambience fades in and out.
    this.#ambientLoop?.fadeOut(this.#menuFade ?? this.#ini.number('Audio', 'fASFadeOutTime'));
    this.#ambientLoop = undefined;
    if (space === undefined) {
      this.#spaceRegion = undefined;
      this.engine.setReverb(undefined);
      return;
    }
    void this.acousticSpace(space).then(async (data) => {
      if (version !== this.#spaceVersion) return;
      this.#spaceRegion = data?.region;
      const reverb = data?.reverb === undefined ? undefined : await this.reverb(data.reverb);
      if (version !== this.#spaceVersion) return;
      this.engine.setReverb(reverb);
      if (data?.ambient === undefined) return;
      const loop = await this.play(
        data.ambient,
        undefined,
        this.#menuFade ?? this.#ini.number('Audio', 'fASFadeInTime'),
      );
      if (version !== this.#spaceVersion) {
        loop?.stop(true);
        return;
      }
      this.#ambientLoop = loop;
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
