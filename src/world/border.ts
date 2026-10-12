// Border regions: the edge of a worldspace the player cannot cross ("You cannot go that way.").
// A region (REGN) with record flag 0x40 (Border Region, xEdit) and the worldspace in WNAM
// outlines its area with one or more polygons: RPLI (edge fall-off, world units) followed by
// RPLD (x, y floats per point). Tamriel has two (BorderRegionSkyrim and Dawnguard's
// DLC1BorderRegionSkyrim); a point inside any polygon of any border region is inside.
// Platform-independent. Notes: docs/formats/esm.md ("Border regions").

import { RecordFlag } from '../formats/esm/record.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

/** REGN record flag: a border region. */
export const BORDER_REGION_FLAG = 0x40;

export type BorderPoint = readonly [number, number];

export interface BorderRegion {
  readonly formId: number;
  readonly editorId: string;
  /** WNAM: the worldspace it bounds. */
  readonly world: number | undefined;
  readonly polygons: readonly (readonly BorderPoint[])[];
}

/** A region's border polygons, or undefined if it is not a border region. */
export function parseBorderRegion(record: GameRecord): BorderRegion | undefined {
  if ((record.flags & BORDER_REGION_FLAG) === 0 || (record.flags & RecordFlag.deleted) !== 0) {
    return undefined;
  }
  const polygons: BorderPoint[][] = [];
  for (const field of record.fields.list) {
    if (field.type !== 'RPLD') continue;
    const view = new DataView(field.data.buffer, field.data.byteOffset, field.data.byteLength);
    const points: BorderPoint[] = [];
    for (let offset = 0; offset + 8 <= field.data.byteLength; offset += 8) {
      points.push([view.getFloat32(offset, true), view.getFloat32(offset + 4, true)]);
    }
    if (points.length >= 3) polygons.push(points);
  }
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    world: record.formIdField('WNAM'),
    polygons,
  };
}

/** Whether a point lies inside a polygon (even-odd rule). */
export function insidePolygon(polygon: readonly BorderPoint[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] ?? [0, 0];
    const [xj, yj] = polygon[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The area a worldspace's border regions allow (everywhere if it has none). */
export class WorldBorder {
  readonly regions: readonly BorderRegion[];

  constructor(regions: readonly BorderRegion[]) {
    this.regions = regions;
  }

  /** Whether the player may stand at (x, y). */
  contains(x: number, y: number): boolean {
    if (this.regions.length === 0) return true;
    return this.regions.some((region) =>
      region.polygons.some((polygon) => insidePolygon(polygon, x, y)),
    );
  }

  /** The border regions of a worldspace (its own WNAM, not a parent's). */
  static async of(db: RecordDatabase, world: number): Promise<WorldBorder> {
    const regions: BorderRegion[] = [];
    for (const formId of db.formIdsOfType('REGN')) {
      const record = await db.get(formId);
      const region = record && parseBorderRegion(record);
      if (region?.world === world && region.polygons.length > 0) regions.push(region);
    }
    return new WorldBorder(regions);
  }
}
