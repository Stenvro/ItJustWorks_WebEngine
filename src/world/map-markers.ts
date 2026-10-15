// Map markers: the persistent references with map marker data (REFR XMRK, then FNAM flags u8
// (0x1 visible, 0x2 can travel to), FULL the name, TNAM the marker's type u8 (its icon: 0 ..
// 58, a camp, a town, a cave, a city, ...)), where they stand and in which worldspace. The
// compass and the map show them. Platform-independent. Notes: docs/formats/esm.md ("Map
// markers").

import { view } from '../formats/esm/fields.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

/** XMRK FNAM flags. */
export const MapMarkerFlag = { visible: 0x1, canTravel: 0x2, showAllHidden: 0x4 } as const;

export interface MapMarker {
  readonly reference: number;
  readonly name: string;
  /** TNAM: its icon. */
  readonly type: number;
  readonly flags: number;
  readonly position: readonly [number, number, number];
  /** The worldspace it is in (undefined: an interior). */
  readonly world: number | undefined;
}

/** A reference's map marker data, if it is a map marker. */
export function parseMapMarker(
  record: Pick<GameRecord, 'formId' | 'fields' | 'text'>,
  world: number | undefined,
): MapMarker | undefined {
  if (!record.fields.has('XMRK')) return undefined;
  const data = record.fields.first('DATA');
  const position: [number, number, number] =
    data && data.length >= 12
      ? [
          view(data).getFloat32(0, true),
          view(data).getFloat32(4, true),
          view(data).getFloat32(8, true),
        ]
      : [0, 0, 0];
  return {
    reference: record.formId,
    name: record.text('FULL') ?? '',
    type: record.fields.first('TNAM')?.[0] ?? 0,
    flags: record.fields.first('FNAM')?.[0] ?? 0,
    position,
    world,
  };
}

/** Every map marker of the load order (they are persistent references). */
export async function readMapMarkers(db: RecordDatabase): Promise<MapMarker[]> {
  const markers: MapMarker[] = [];
  const PERSISTENT = 0x400;
  await db.scan(
    ['REFR'],
    (flags) => (flags & PERSISTENT) !== 0,
    (record) => {
      if (!record.fields.has('XMRK') || record.deleted) return;
      const cell = db.cellOfReference(record.formId);
      const marker = parseMapMarker(record, cell === undefined ? undefined : db.worldOfCell(cell));
      if (marker) markers.push(marker);
    },
  );
  return markers;
}
