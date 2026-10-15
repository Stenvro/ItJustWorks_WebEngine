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

const markersOf = new WeakMap<RecordDatabase, Promise<MapMarker[]>>();

/** Every map marker of the load order (they are persistent references); read once. */
export function readMapMarkers(db: RecordDatabase): Promise<MapMarker[]> {
  let markers = markersOf.get(db);
  if (!markers) {
    markers = scanMapMarkers(db);
    markersOf.set(db, markers);
  }
  return markers;
}

async function scanMapMarkers(db: RecordDatabase): Promise<MapMarker[]> {
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

/**
 * The map menu's icons (map.swf's Map.MapMarker.IconTypes): a map marker's type (TNAM 0 ..
 * 59) is its icon's index; after them the engine's own.
 */
export const MapIcon = {
  empty: 0,
  door: 61,
  questTarget: 62,
  questTargetDoor: 63,
  multipleQuestTargets: 64,
  playerSet: 65,
  youAreHere: 66,
} as const;

/**
 * Where a place of a world shows on its map's world (WRLD ONAM: a world shown on another's map,
 * such as Blackreach under Tamriel, its places scaled and moved; scale 0 puts all of it at one
 * point). Undefined for a negative scale: the world is on no map.
 */
export function onMapPosition(
  offset: { readonly scale: number; readonly offset: readonly [number, number, number] },
  position: readonly [number, number, number],
): [number, number, number] | undefined {
  if (offset.scale < 0) return undefined;
  return [
    position[0] * offset.scale + offset.offset[0],
    position[1] * offset.scale + offset.offset[1],
    position[2] * offset.scale + offset.offset[2],
  ];
}
