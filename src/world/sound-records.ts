// The records behind every sound the game makes (layouts: xEdit's TES5 definitions and
// CommonLibSSE's BGSStandardSoundDef, BGSSoundOutput, BGSSoundCategory, BGSMusicType,
// BGSMusicTrack, BGSAcousticSpace, BGSReverbParameters):
// - SNDR sound descriptor: which files (one at random), category, output model, looping,
//   pitch and volume variation;
// - SOPM output model: distance attenuation, 3D (HRTF) or speaker output, reverb send;
// - SNCT category: the volume tree (master → SFX, music, voice, ...);
// - SOUN sound marker: a placed sound (its descriptor);
// - MUSC music type and MUST music track: what plays where and how;
// - ASPC acoustic space and REVB reverb: an area's ambience loop, region sounds and reverb.
// Platform-independent. Notes: docs/formats/esm.md ("Sounds", "Music").

import { parseConditions, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from './record-db.ts';

/** How a descriptor's sound loops (LNAM, BGSStandardSoundDef::LengthCharacteristics). */
export type SoundLooping = 'none' | 'loop' | 'envelope-fast' | 'envelope-slow';

export interface SoundDescriptor {
  readonly formId: number;
  readonly editorId: string;
  /** GNAM: SNCT. */
  readonly category: number | undefined;
  /** SNAM: the descriptor this one replaces when its conditions hold. */
  readonly alternateFor: number | undefined;
  /** ANAM: data paths of the sound files; one is picked at random. */
  readonly files: readonly string[];
  /** ONAM: SOPM. */
  readonly outputModel: number | undefined;
  readonly looping: SoundLooping;
  /** BNAM: pitch shift and its random variation, percent. */
  readonly frequencyShift: number;
  readonly frequencyVariance: number;
  readonly priority: number;
  /** Random attenuation up to this many dB. */
  readonly dbVariance: number;
  /** Fixed attenuation, dB. */
  readonly staticAttenuation: number;
  readonly conditions: readonly Condition[];
}

export interface SoundAttenuation {
  /** Inside it the sound is at the curve's first value; beyond the maximum it is silent. */
  readonly minDistance: number;
  readonly maxDistance: number;
  /** Five volumes (0–100 %) from the minimum to the maximum distance. */
  readonly curve: readonly number[];
}

export interface SoundOutputModel {
  readonly formId: number;
  readonly editorId: string;
  readonly attenuatesWithDistance: boolean;
  /** Share of the sound sent to the reverb (0–1). */
  readonly reverbSend: number;
  /** MNAM 0: placed in 3D (HRTF); 1: fixed speaker levels (ONAM). */
  readonly uses3d: boolean;
  /** ONAM: speaker levels (0–100) of mono, stereo left and stereo right input: L R C LFE RL RR BL BR. */
  readonly speakers: readonly (readonly number[])[] | undefined;
  readonly attenuation: SoundAttenuation | undefined;
}

export interface SoundCategory {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  readonly parent: number | undefined;
  readonly muteWhenSubmerged: boolean;
  /** Has a slider in the audio settings. */
  readonly onMenu: boolean;
  /** VNAM: the category's own volume (0–1). */
  readonly volume: number;
  /** UNAM: the settings slider's default (0–1). */
  readonly menuVolume: number;
}

/** MUSC flags. */
export const MusicTypeFlag = {
  playsOneSelection: 0x01,
  abruptTransition: 0x02,
  cycleTracks: 0x04,
  maintainTrackOrder: 0x08,
  ducksCurrentTrack: 0x20,
  doesNotQueue: 0x40,
} as const;

export interface MusicType {
  readonly formId: number;
  readonly editorId: string;
  readonly flags: number;
  readonly priority: number;
  /** How far it turns down the music it interrupts, dB. */
  readonly ducking: number;
  /** WNAM: seconds of fade between tracks. */
  readonly fadeDuration: number;
  /** TNAM: MUST tracks. */
  readonly tracks: readonly number[];
}

export type MusicTrackType = 'palette' | 'single' | 'silent';

export interface MusicTrack {
  readonly formId: number;
  readonly editorId: string;
  readonly type: MusicTrackType;
  /** FLTV: a silent track's length, seconds. */
  readonly duration: number;
  /** DNAM: fade-out, seconds. */
  readonly fadeOut: number;
  /** ANAM: the music file's data path. */
  readonly file: string | undefined;
  /** BNAM: what plays when the track is ended early (combat's finale). */
  readonly finale: string | undefined;
  /** LNAM: a loop inside the file (seconds) and how often (0: until stopped). */
  readonly loop:
    { readonly start: number; readonly end: number; readonly count: number } | undefined;
  /** FNAM: where the track may be left (seconds). */
  readonly cuePoints: readonly number[];
  readonly conditions: readonly Condition[];
  /**
   * SNAM: a palette's layers, which play at the same time, each its tracks (single and silent
   * ones) one after another at random; a NULL entry separates two layers.
   */
  readonly layers: readonly (readonly number[])[];
}

export interface AcousticSpace {
  readonly formId: number;
  readonly editorId: string;
  /** SNAM: SNDR looping ambience. */
  readonly ambient: number | undefined;
  /** RDAT: REGN whose sounds play here (interiors). */
  readonly region: number | undefined;
  /** BNAM: REVB. */
  readonly reverb: number | undefined;
}

/** REVB DATA: I3DL2 reverb parameters (XAudio2's), levels in dB. */
export interface Reverb {
  readonly formId: number;
  readonly editorId: string;
  readonly decayTime: number;
  readonly hfReference: number;
  readonly room: number;
  readonly roomHf: number;
  readonly reflections: number;
  readonly reverb: number;
  readonly decayHfRatio: number;
  /** The record's "scaled" reflections delay byte. */
  readonly reflectionsDelay: number;
  /** Milliseconds. */
  readonly reverbDelay: number;
  readonly diffusion: number;
  readonly density: number;
}

const TRACK_TYPES = new Map<number, MusicTrackType>([
  [0x23f678c3, 'palette'],
  [0x6ed7e048, 'single'],
  [0xa1a9c4d5, 'silent'],
]);
const LOOPING = new Map<number, SoundLooping>([
  [8, 'loop'],
  [16, 'envelope-fast'],
  [32, 'envelope-slow'],
]);

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function text(data: Uint8Array | undefined): string | undefined {
  if (!data) return undefined;
  let out = '';
  for (const byte of data) {
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

/** MUST SNAM: the tracks of each layer; NULL entries separate the layers. */
function paletteLayers(record: GameRecord): number[][] {
  const data = record.fields.first('SNAM');
  if (!data) return [];
  const layers: number[][] = [[]];
  for (let offset = 0; offset + 4 <= data.byteLength; offset += 4) {
    const formId = record.formIdAt(data, offset);
    if (formId === 0) layers.push([]);
    else layers[layers.length - 1]?.push(formId);
  }
  return layers.filter((layer) => layer.length > 0);
}

function formIds(record: GameRecord, type: string): number[] {
  const data = record.fields.first(type);
  if (!data) return [];
  return Array.from({ length: Math.floor(data.byteLength / 4) }, (_, i) =>
    record.formIdAt(data, i * 4),
  ).filter((formId) => formId !== 0);
}

/**
 * A sound or music file name as records store it ("Data\Sound\FX\...\x.wav", "fx\...",
 * "Data\Music\...\x.wav", even "c:\...\data\sound\...") as a data path under `root`
 * ("sound" for descriptors, "music" for tracks). The engine also finds the file under the
 * other extension (.xwm for .wav, .wav for .xwm): see soundFileCandidates.
 */
export function soundFilePath(name: string, root: 'sound' | 'music'): string {
  let path = name.replace(/\//g, '\\').trim().toLowerCase();
  const data = path.lastIndexOf('data\\');
  if (data >= 0 && (data === 0 || path[data - 1] === '\\')) path = path.slice(data + 5);
  path = path.replace(/^\\+/, '');
  return path.startsWith(`${root}\\`) ? path : `${root}\\${path}`;
}

/** The paths a sound file may be found under: as named, then with the other extension. */
export function soundFileCandidates(path: string): string[] {
  if (path.endsWith('.wav')) return [path, `${path.slice(0, -4)}.xwm`];
  if (path.endsWith('.xwm')) return [path, `${path.slice(0, -4)}.wav`];
  return [path];
}

export function parseSoundDescriptor(record: GameRecord): SoundDescriptor {
  const bnam = record.fields.first('BNAM');
  const values = bnam && bnam.byteLength >= 6 ? viewOf(bnam) : undefined;
  const lnam = record.fields.first('LNAM');
  // Older records (form version < 34) have FNAM flags instead: bit 4 loops.
  const fnam = record.fields.first('FNAM');
  const looping = lnam
    ? (LOOPING.get(lnam[1] ?? 0) ?? 'none')
    : fnam && fnam.byteLength >= 4 && (viewOf(fnam).getUint32(0, true) & 0x10) !== 0
      ? 'loop'
      : 'none';
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    category: record.formIdField('GNAM'),
    alternateFor: record.formIdField('SNAM'),
    files: record.fields
      .all('ANAM')
      .map((data) => text(data) ?? '')
      .filter((name) => name !== '')
      .map((name) => soundFilePath(name, 'sound')),
    outputModel: record.formIdField('ONAM'),
    looping,
    frequencyShift: values?.getInt8(0) ?? 0,
    frequencyVariance: values?.getInt8(1) ?? 0,
    priority: values?.getUint8(2) ?? 128,
    dbVariance: values?.getUint8(3) ?? 0,
    staticAttenuation: (values?.getUint16(4, true) ?? 0) / 100,
    conditions: parseConditions(record),
  };
}

export function parseSoundOutputModel(record: GameRecord): SoundOutputModel {
  const nam1 = record.fields.first('NAM1');
  const mnam = record.fields.first('MNAM');
  const onam = record.fields.first('ONAM');
  const anam = record.fields.first('ANAM');
  let attenuation: SoundAttenuation | undefined;
  if (anam && anam.byteLength >= 17) {
    const view = viewOf(anam);
    attenuation = {
      minDistance: view.getFloat32(4, true),
      maxDistance: view.getFloat32(8, true),
      curve: Array.from(anam.subarray(12, 17)),
    };
  }
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    attenuatesWithDistance: ((nam1?.[0] ?? 0) & 0x1) !== 0,
    reverbSend: (nam1?.[3] ?? 0) / 100,
    uses3d: (mnam && mnam.byteLength >= 4 ? viewOf(mnam).getUint32(0, true) : 0) === 0,
    speakers:
      onam && onam.byteLength >= 24
        ? [0, 1, 2].map((input) => Array.from(onam.subarray(input * 8, input * 8 + 8)))
        : undefined,
    attenuation,
  };
}

export function parseSoundCategory(record: GameRecord): SoundCategory {
  const fnam = record.fields.first('FNAM');
  const flags = fnam && fnam.byteLength >= 4 ? viewOf(fnam).getUint32(0, true) : 0;
  const u16 = (type: string, fallback: number): number => {
    const data = record.fields.first(type);
    return data && data.byteLength >= 2 ? viewOf(data).getUint16(0, true) / 65535 : fallback;
  };
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    // FULL: the settings slider's name, from the string tables: a key the menus translate
    // ("$Music", Interface\Translations; M9).
    name: record.text('FULL') ?? '',
    parent: record.formIdField('PNAM'),
    muteWhenSubmerged: (flags & 0x1) !== 0,
    onMenu: (flags & 0x2) !== 0,
    volume: u16('VNAM', 1),
    menuVolume: u16('UNAM', 1),
  };
}

/** SOUN: the descriptor a sound marker plays. */
export function soundMarkerDescriptor(record: GameRecord): number | undefined {
  return record.formIdField('SDSC');
}

export function parseMusicType(record: GameRecord): MusicType {
  const fnam = record.fields.first('FNAM');
  const pnam = record.fields.first('PNAM');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    flags: fnam && fnam.byteLength >= 4 ? viewOf(fnam).getUint32(0, true) : 0,
    priority: pnam && pnam.byteLength >= 2 ? viewOf(pnam).getUint16(0, true) : 0,
    ducking: pnam && pnam.byteLength >= 4 ? viewOf(pnam).getUint16(2, true) / 100 : 0,
    fadeDuration: record.fields.f32('WNAM') ?? 0,
    tracks: formIds(record, 'TNAM'),
  };
}

export function parseMusicTrack(record: GameRecord): MusicTrack {
  const cnam = record.fields.first('CNAM');
  const type = TRACK_TYPES.get(cnam && cnam.byteLength >= 4 ? viewOf(cnam).getUint32(0, true) : 0);
  const lnam = record.fields.first('LNAM');
  const fnam = record.fields.first('FNAM');
  const file = text(record.fields.first('ANAM'));
  const finale = text(record.fields.first('BNAM'));
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    type: type ?? 'single',
    duration: record.fields.f32('FLTV') ?? 0,
    fadeOut: record.fields.f32('DNAM') ?? 0,
    file: file ? soundFilePath(file, 'music') : undefined,
    finale: finale ? soundFilePath(finale, 'music') : undefined,
    loop:
      lnam && lnam.byteLength >= 12
        ? {
            start: viewOf(lnam).getFloat32(0, true),
            end: viewOf(lnam).getFloat32(4, true),
            count: viewOf(lnam).getUint32(8, true),
          }
        : undefined,
    cuePoints: fnam
      ? Array.from({ length: Math.floor(fnam.byteLength / 4) }, (_, i) =>
          viewOf(fnam).getFloat32(i * 4, true),
        )
      : [],
    conditions: parseConditions(record),
    layers: paletteLayers(record),
  };
}

export function parseAcousticSpace(record: GameRecord): AcousticSpace {
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    ambient: record.formIdField('SNAM'),
    region: record.formIdField('RDAT'),
    reverb: record.formIdField('BNAM'),
  };
}

export function parseReverb(record: GameRecord): Reverb | undefined {
  const data = record.fields.first('DATA');
  if (!data || data.byteLength < 13) return undefined;
  const view = viewOf(data);
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    decayTime: view.getUint16(0, true),
    hfReference: view.getUint16(2, true),
    room: view.getInt8(4),
    roomHf: view.getInt8(5),
    reflections: view.getInt8(6),
    reverb: view.getInt8(7),
    decayHfRatio: view.getUint8(8) / 100,
    reflectionsDelay: view.getUint8(9),
    reverbDelay: view.getUint8(10),
    diffusion: view.getUint8(11),
    density: view.getUint8(12),
  };
}

/** REGN RDSA: a sound of a region, for the weathers its flags name. */
export interface RegionSound {
  /** SNDR. */
  readonly sound: number;
  /** Weather classifications it plays in: 0x1 pleasant, 0x2 cloudy, 0x4 rainy, 0x8 snowy. */
  readonly flags: number;
  /** Looping sounds: 1. Others: the chance of starting at each check. */
  readonly chance: number;
}

/** The sounds and music of a region (its RDAT type 7 entries: RDSA, RDMO). */
export interface RegionAudio {
  /** The sound tab's priority and override flag (RDAT): see regionsInEffect. */
  readonly priority: number;
  readonly override: boolean;
  readonly sounds: readonly RegionSound[];
  /** RDMO: the region's music type (MUSC). */
  readonly music: number | undefined;
}

/** RDAT type of a region's sound data. */
const REGION_SOUND = 7;

export function parseRegionAudio(record: GameRecord): RegionAudio {
  const sounds: RegionSound[] = [];
  let music: number | undefined;
  let type = -1;
  let priority = 0;
  let override = false;
  for (const field of record.fields.list) {
    if (field.type === 'RDAT' && field.data.byteLength >= 4) {
      type = viewOf(field.data).getUint32(0, true);
      if (type === REGION_SOUND) {
        override = ((field.data[4] ?? 0) & 1) !== 0;
        priority = field.data[5] ?? 0;
      }
      continue;
    }
    if (type !== REGION_SOUND) continue;
    if (field.type === 'RDMO' && field.data.byteLength >= 4) {
      const formId = record.formIdAt(field.data, 0);
      if (formId !== 0) music = formId;
    } else if (field.type === 'RDSA') {
      const view = viewOf(field.data);
      for (let offset = 0; offset + 12 <= field.data.byteLength; offset += 12) {
        const sound = record.formIdAt(field.data, offset);
        if (sound === 0) continue;
        sounds.push({
          sound,
          flags: view.getUint32(offset + 4, true),
          chance: view.getFloat32(offset + 8, true),
        });
      }
    }
  }
  return { priority, override, sounds, music };
}

/**
 * The regions whose sound data applies where several hold (a cell's XCLR): from the highest
 * priority down, up to and including the first that overrides lower ones (the Creation Kit's
 * region "Override" flag); the others add theirs. Equal priorities keep their order.
 */
export function regionsInEffect(regions: readonly RegionAudio[]): RegionAudio[] {
  const sorted = [...regions].sort((a, b) => b.priority - a.priority);
  const cut = sorted.findIndex((region) => region.override);
  return cut < 0 ? sorted : sorted.slice(0, cut + 1);
}

/** The music type of the regions in effect: the first (highest-priority) that names one. */
export function regionMusic(regions: readonly RegionAudio[]): number | undefined {
  return regionsInEffect(regions).find((region) => region.music !== undefined)?.music;
}
