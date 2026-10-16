// Furniture (FURN) as AI uses it: which of its model's markers are active and what they allow
// (MNAM), per marker its disabled entry points and keyword (ENAM / NAM0 / FNMK), the marker
// types and entry points (FNPR), the interaction keyword (KNAM), the sandbox flag (FNAM) and
// the spell it gives (NAM1). The workbench data (WBDT) is read in crafting-records.ts.
// Layouts: xEdit (wbDefinitionsTES5 FURN), CommonLibSSE-NG (TESFurniture, TESObjectACTI,
// BSFurnitureMarker). Notes: docs/formats/esm.md ("Furniture"). Platform-independent.

import { view } from '../formats/esm/fields.ts';
import { recordKeywords } from './crafting-records.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'flags' | 'fields' | 'formIdAt'>;

/** FURN record flags (xEdit, CommonLib TESFurniture::RecordFlags). */
export const FurnitureRecordFlag = {
  isPerch: 0x80,
  hasDistantLod: 0x8000,
  randomAnimStart: 0x10000,
  isMarker: 0x800000,
  obstacle: 0x2000000,
  mustExitToTalk: 0x10000000,
  childCanUse: 0x20000000,
} as const;

/** FNAM u16 (CommonLib TESObjectACTI::ActiFlags; xEdit: "Unknown 0", "Ignored By Sandbox"). */
export const FurnitureFlag = {
  noDisplacement: 0x1,
  ignoredBySandbox: 0x2,
} as const;

/**
 * MNAM u32: the active markers (bit n: marker n) and flags (xEdit; CommonLib
 * TESFurniture::ActiveMarker). On furniture with FNPR, the "can" bits are set exactly where it
 * has a marker of that type (lean: xEdit's 0x10000000, not CommonLib's 1 << 29, which no
 * furniture sets).
 */
export const FurnitureMarkerFlag = {
  activeMarkers: 0x00ffffff,
  disablesActivation: 0x02000000,
  isPerch: 0x04000000,
  mustExitToTalk: 0x08000000,
  canLean: 0x10000000,
  canSit: 0x40000000,
  canSleep: 0x80000000,
} as const;

/** FNPR type (and the model's marker animation type, BSFurnitureMarker::AnimationType). */
export const FurnitureMarkerType = {
  sit: 1,
  sleep: 2,
  lean: 4,
} as const;

/** Entry points (FNPR, NAM0; BSFurnitureMarker::EntryProperties). */
export const FurnitureEntry = {
  front: 0x1,
  behind: 0x2,
  right: 0x4,
  left: 0x8,
  up: 0x10,
} as const;

/** ENAM, NAM0, FNMK: one marker's data. */
export interface FurnitureMarkerData {
  /** ENAM: the marker's index in the model. */
  readonly index: number;
  /** NAM0 u16 @2: the entry points (FurnitureEntry) it cannot be entered from. */
  readonly disabledEntries: number;
  /** FNMK: the marker's keyword; undefined: none. */
  readonly keyword: number | undefined;
}

/** FNPR: a marker's type and the entry points it has. */
export interface FurnitureEntryPoints {
  /** FurnitureMarkerType. */
  readonly type: number;
  /** FurnitureEntry flags. */
  readonly entries: number;
}

export interface FurnitureRecord {
  readonly formId: number;
  readonly editorId: string;
  /** FurnitureRecordFlag. */
  readonly recordFlags: number;
  /** FNAM: FurnitureFlag. */
  readonly flags: number;
  /** KNAM: the interaction keyword; undefined: none. */
  readonly interactionKeyword: number | undefined;
  /** MNAM: FurnitureMarkerFlag (undefined without MNAM). */
  readonly markerFlags: number | undefined;
  /** NAM1: the spell it gives its user (SPEL); undefined: none. */
  readonly associatedSpell: number | undefined;
  /** ENAM / NAM0 / FNMK, in record order. */
  readonly markers: readonly FurnitureMarkerData[];
  /** FNPR, in record order. */
  readonly entryPoints: readonly FurnitureEntryPoints[];
  /** KWDA. */
  readonly keywords: readonly number[];
  readonly model: string | undefined;
  /** XMRK: the model the Creation Kit shows its markers with. */
  readonly markerModel: string | undefined;
}

const formOrUndefined = (record: RecordSource, data: Uint8Array | undefined): number | undefined =>
  data && data.length >= 4 && view(data).getUint32(0, true) !== 0
    ? record.formIdAt(data, 0)
    : undefined;

export function parseFurniture(record: RecordSource): FurnitureRecord {
  const markers: { index: number; disabledEntries: number; keyword: number | undefined }[] = [];
  const entryPoints: FurnitureEntryPoints[] = [];
  for (const { type, data } of record.fields.list) {
    const current = markers[markers.length - 1];
    if (type === 'ENAM' && data.length >= 4) {
      markers.push({
        index: view(data).getUint32(0, true),
        disabledEntries: 0,
        keyword: undefined,
      });
    } else if (type === 'NAM0' && current && data.length >= 4) {
      current.disabledEntries = view(data).getUint16(2, true);
    } else if (type === 'FNMK' && current) {
      current.keyword = formOrUndefined(record, data);
    } else if (type === 'FNPR' && data.length >= 4) {
      entryPoints.push({
        type: view(data).getUint16(0, true),
        entries: view(data).getUint16(2, true),
      });
    }
  }
  const fnam = record.fields.first('FNAM');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    recordFlags: record.flags,
    flags: fnam && fnam.length >= 2 ? view(fnam).getUint16(0, true) : 0,
    interactionKeyword: formOrUndefined(record, record.fields.first('KNAM')),
    markerFlags: record.fields.u32('MNAM'),
    associatedSpell: formOrUndefined(record, record.fields.first('NAM1')),
    markers,
    entryPoints,
    keywords: recordKeywords(record),
    model: record.fields.zstring('MODL'),
    markerModel: record.fields.zstring('XMRK'),
  };
}

/** Whether marker `index` of the model is active (MNAM bit; without MNAM, every marker). */
export function isMarkerActive(furniture: FurnitureRecord, index: number): boolean {
  if (furniture.markerFlags === undefined) return true;
  return index < 24 && (furniture.markerFlags & (1 << index)) !== 0;
}

/** The marker data (ENAM / NAM0 / FNMK) of marker `index` of the model, if the record has it. */
export function markerData(
  furniture: FurnitureRecord,
  index: number,
): FurnitureMarkerData | undefined {
  return furniture.markers.find((marker) => marker.index === index);
}
