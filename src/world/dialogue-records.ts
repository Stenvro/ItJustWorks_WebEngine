// Dialogue: topics (DIAL), the branches that start them (DLBR) and their infos (INFO: what an
// actor says, when, and what comes after). Layouts after UESP's "Skyrim Mod:Mod File Format"
// DIAL, DLBR and INFO pages. An info's responses are its lines: each TRDT with its text (NAM1),
// its emotion and its number (the voice file's _1, _2, ...). Platform-independent.
// Notes: docs/formats/esm.md ("Dialogue").

import { view } from '../formats/esm/fields.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt' | 'textAt'>;

/** DIAL DATA categories. */
export const TopicCategory = {
  topic: 0,
  favor: 1,
  scene: 2,
  combat: 3,
  favors: 4,
  detection: 5,
  service: 6,
  miscellaneous: 7,
} as const;

/** DIAL DATA flags. */
export const TopicFlag = { doAllBeforeRepeating: 0x1 } as const;

export interface TopicRecord {
  readonly formId: number;
  readonly editorId: string;
  /** FULL: what the player says to choose it. */
  readonly text: string;
  readonly priority: number;
  /** BNAM: the branch it belongs to. */
  readonly branch: number | undefined;
  readonly quest: number | undefined;
  readonly flags: number;
  readonly category: number;
  readonly subtype: number;
  /** SNAM: the subtype's code ("CUST", "HELO", "GBYE", ...). */
  readonly subtypeName: string;
}

/** DLBR DNAM flags. */
export const BranchFlag = { topLevel: 0x1, blocking: 0x2, exclusive: 0x4 } as const;

export interface BranchRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly quest: number | undefined;
  readonly flags: number;
  /** SNAM: the topic it starts with. */
  readonly startingTopic: number | undefined;
}

/** INFO ENAM flags. */
export const InfoFlag = {
  goodbye: 0x1,
  random: 0x2,
  sayOnce: 0x4,
  requiresPlayerActivation: 0x8,
  infoRefusal: 0x10,
  randomEnd: 0x20,
  invisibleContinue: 0x40,
  walkAway: 0x80,
  walkAwayInvisibleInMenu: 0x100,
  forceSubtitle: 0x200,
  canMoveWhileGreeting: 0x400,
  noLipFile: 0x800,
  requiresPostProcessing: 0x1000,
  audioOutputOverride: 0x2000,
  spendsFavorPoints: 0x4000,
} as const;

/** A line of an info (TRDT and the fields after it). */
export interface InfoResponse {
  /** 1, 2, ...: the voice file's number. */
  readonly number: number;
  readonly emotion: number;
  readonly emotionValue: number;
  readonly text: string;
  /** TRDT: a sound to play instead of the voice file (form id; 0 none). */
  readonly sound: number;
  readonly useEmotionAnimation: boolean;
  /** SNAM / LNAM: the speaker's and the listener's idle. */
  readonly speakerIdle: number | undefined;
  readonly listenerIdle: number | undefined;
}

export interface InfoRecord {
  readonly formId: number;
  readonly flags: number;
  /** ENAM: hours before a Say Once a Day info may be said again. */
  readonly resetHours: number;
  /** PNAM: the info it follows in its topic (the order of infos). */
  readonly previous: number | undefined;
  /** TCLT: the topics the player may choose after it. */
  readonly choices: readonly number[];
  /** DNAM: the info whose responses it says (shared infos). */
  readonly sharedInfo: number | undefined;
  /** RNAM: what the player says to choose it (instead of the topic's text). */
  readonly prompt: string | undefined;
  /** ANAM: the actor who says it (else whoever the conditions pick). */
  readonly speaker: number | undefined;
  readonly responses: readonly InfoResponse[];
  readonly conditions: readonly Condition[];
}

const u32 = (data: Uint8Array | undefined, at: number): number =>
  data && data.length >= at + 4 ? view(data).getUint32(at, true) : 0;
const fourCC = (data: Uint8Array | undefined): string =>
  data ? String.fromCharCode(...data.subarray(0, 4)).replace(/\0+$/, '') : '';

export function parseTopic(record: RecordSource): TopicRecord {
  const data = record.fields.first('DATA');
  const form = (type: string): number | undefined => {
    const field = record.fields.first(type);
    return field && field.length >= 4 ? record.formIdAt(field) : undefined;
  };
  const full = record.fields.first('FULL');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    text: full ? record.textAt(full) : '',
    priority: record.fields.f32('PNAM') ?? 50,
    branch: form('BNAM'),
    quest: form('QNAM'),
    flags: data?.[0] ?? 0,
    category: data?.[1] ?? 0,
    subtype: data && data.length >= 4 ? view(data).getUint16(2, true) : 0,
    subtypeName: fourCC(record.fields.first('SNAM')),
  };
}

export function parseBranch(record: RecordSource): BranchRecord {
  const form = (type: string): number | undefined => {
    const field = record.fields.first(type);
    return field && field.length >= 4 ? record.formIdAt(field) : undefined;
  };
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    quest: form('QNAM'),
    flags: u32(record.fields.first('DNAM'), 0),
    startingTopic: form('SNAM'),
  };
}

export function parseInfo(record: RecordSource): InfoRecord {
  const fields = record.fields.list;
  const enam = record.fields.first('ENAM');
  const responses: InfoResponse[] = [];
  const conditions: Condition[] = [];
  const choices: number[] = [];
  let previous: number | undefined;
  let sharedInfo: number | undefined;
  let prompt: string | undefined;
  let speaker: number | undefined;
  let response:
    | {
        number: number;
        emotion: number;
        emotionValue: number;
        text: string;
        sound: number;
        useEmotionAnimation: boolean;
        speakerIdle: number | undefined;
        listenerIdle: number | undefined;
      }
    | undefined;
  const closeResponse = (): void => {
    if (response) responses.push(response);
    response = undefined;
  };
  for (const [index, { type, data }] of fields.entries()) {
    const form = data.length >= 4 ? record.formIdAt(data) : undefined;
    switch (type) {
      case 'TRDT':
        closeResponse();
        response = {
          emotion: u32(data, 0),
          emotionValue: u32(data, 4),
          number: data[12] ?? 0,
          sound: data.length >= 20 ? record.formIdAt(data, 16) : 0,
          useEmotionAnimation: ((data[20] ?? 0) & 0x1) !== 0,
          text: '',
          speakerIdle: undefined,
          listenerIdle: undefined,
        };
        break;
      case 'NAM1':
        if (response) response.text = record.textAt(data);
        break;
      case 'SNAM':
        if (response) response.speakerIdle = form;
        break;
      case 'LNAM':
        if (response) response.listenerIdle = form;
        break;
      case 'CTDA': {
        closeResponse();
        const condition = conditionAt(fields, index, record);
        if (condition) conditions.push(condition);
        break;
      }
      case 'PNAM':
        previous = form;
        break;
      case 'TCLT':
        if (form !== undefined) choices.push(form);
        break;
      case 'DNAM':
        sharedInfo = form;
        break;
      case 'RNAM':
        closeResponse();
        prompt = record.textAt(data);
        break;
      case 'ANAM':
        speaker = form;
        break;
      default:
        break;
    }
  }
  closeResponse();
  return {
    formId: record.formId,
    flags: enam && enam.length >= 2 ? view(enam).getUint16(0, true) : 0,
    resetHours: enam && enam.length >= 4 ? view(enam).getUint16(2, true) : 0,
    previous,
    choices,
    sharedInfo,
    prompt,
    speaker,
    responses,
    conditions,
  };
}
