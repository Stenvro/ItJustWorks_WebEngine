// Worldspaces (WRLD) and their exterior cells: which world supplies the land, water, climate
// and LOD (child worlds such as WhiterunWorld borrow them from Tamriel), and where the
// persistent references are. Layout: docs/formats/esm.md ("Worldspaces").

import { parseReference } from './cell-records.ts';
import { CELL_SIZE, parseLand, type LandData } from './land.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

/** WRLD PNAM: what a child worldspace takes from its parent. */
export const ParentUse = {
  land: 0x1,
  lod: 0x2,
  map: 0x4,
  water: 0x8,
  climate: 0x10,
  imageSpace: 0x20,
  sky: 0x40,
} as const;

/** WRLD DATA flags. */
export const WorldFlag = {
  smallWorld: 0x1,
  cantFastTravel: 0x2,
  noLodWater: 0x8,
  noLandscape: 0x10,
  noSky: 0x20,
  fixedDimensions: 0x40,
  noGrass: 0x80,
} as const;

export interface WorldspaceRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  readonly parent: number | undefined;
  /** ParentUse bits. */
  readonly parentUse: number;
  /** WorldFlag bits. */
  readonly flags: number;
  readonly defaultLandHeight: number;
  readonly defaultWaterHeight: number;
  /** WATR form id. */
  readonly water: number | undefined;
  readonly lodWater: number | undefined;
  readonly lodWaterHeight: number;
  /** CLMT form id. */
  readonly climate: number | undefined;
}

export function parseWorldspace(record: GameRecord): WorldspaceRecord {
  const f32 = (type: string, offset = 0): number | undefined => {
    const data = record.fields.first(type);
    return data && data.length >= offset + 4
      ? new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat32(offset, true)
      : undefined;
  };
  const pnam = record.fields.first('PNAM');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: record.text('FULL') ?? '',
    parent: record.formIdField('WNAM'),
    parentUse: pnam && pnam.length >= 2 ? (pnam[0] ?? 0) | ((pnam[1] ?? 0) << 8) : 0,
    flags: record.fields.first('DATA')?.[0] ?? 0,
    defaultLandHeight: f32('DNAM', 0) ?? -2048,
    defaultWaterHeight: f32('DNAM', 4) ?? 0,
    water: record.formIdField('NAM2'),
    lodWater: record.formIdField('NAM3'),
    lodWaterHeight: f32('NAM4') ?? 0,
    climate: record.formIdField('CNAM'),
  };
}

/** A worldspace with the indexes needed to load its exterior cells. */
export class Worldspace {
  readonly db: RecordDatabase;
  readonly record: WorldspaceRecord;
  /** The world whose landscape, water, climate and LOD are used (itself or its parent). */
  readonly landWorld: WorldspaceRecord;
  readonly waterWorld: WorldspaceRecord;
  readonly climateWorld: WorldspaceRecord;
  readonly lodWorld: WorldspaceRecord;
  /** Persistent references by cell "x,y". */
  readonly #persistent: Map<string, number[]>;
  readonly #land = new Map<string, Promise<LandData | undefined>>();

  private constructor(
    db: RecordDatabase,
    record: WorldspaceRecord,
    parent: WorldspaceRecord | undefined,
    persistent: Map<string, number[]>,
  ) {
    this.db = db;
    this.record = record;
    const from = (bit: number): WorldspaceRecord =>
      parent && (record.parentUse & bit) !== 0 ? parent : record;
    this.landWorld = from(ParentUse.land);
    this.waterWorld = from(ParentUse.water);
    this.climateWorld = from(ParentUse.climate);
    this.lodWorld = from(ParentUse.lod);
    this.#persistent = persistent;
  }

  /** Reads the worldspace and sorts its persistent references into cells by position. */
  static async open(db: RecordDatabase, formId: number): Promise<Worldspace> {
    const record = parseWorldspace(await db.require(formId));
    const parentRecord = record.parent === undefined ? undefined : await db.get(record.parent);
    const parent = parentRecord ? parseWorldspace(parentRecord) : undefined;
    const persistent = new Map<string, number[]>();
    const persistentCell = db.persistentCell(formId);
    if (persistentCell !== undefined) {
      for (const id of db.cellReferences(persistentCell)) {
        const ref = await db.get(id);
        if (!ref || ref.deleted || (ref.type !== 'REFR' && ref.type !== 'ACHR')) continue;
        const { position } = parseReference(ref);
        const key = cellKey(
          Math.floor(position[0] / CELL_SIZE),
          Math.floor(position[1] / CELL_SIZE),
        );
        const list = persistent.get(key) ?? [];
        list.push(id);
        persistent.set(key, list);
      }
    }
    return new Worldspace(db, record, parent, persistent);
  }

  /** The cell record at a grid position, if the world has one. */
  cell(x: number, y: number): Promise<number | undefined> {
    return this.db.exteriorCell(this.record.formId, x, y);
  }

  /** The cell with the most persistent references (a town), as a starting point. */
  busiestCell(): [number, number] | undefined {
    let best: [string, number] | undefined;
    for (const [key, refs] of this.#persistent) {
      if (!best || refs.length > best[1]) best = [key, refs.length];
    }
    if (!best) return undefined;
    const [x, y] = best[0].split(',').map(Number);
    return [x ?? 0, y ?? 0];
  }

  /** Persistent references placed in a cell. */
  persistentReferences(x: number, y: number): readonly number[] {
    return this.#persistent.get(cellKey(x, y)) ?? [];
  }

  /** The landscape at a grid position (from the land world). */
  land(x: number, y: number): Promise<LandData | undefined> {
    const key = cellKey(x, y);
    let pending = this.#land.get(key);
    if (!pending) {
      pending = this.#readLand(x, y);
      this.#land.set(key, pending);
    }
    return pending;
  }

  async #readLand(x: number, y: number): Promise<LandData | undefined> {
    const cell = await this.db.exteriorCell(this.landWorld.formId, x, y);
    if (cell === undefined) return undefined;
    for (const id of this.db.cellReferences(cell)) {
      const location = this.db.locate(id);
      if (!location) continue;
      const type = location.plugin.index.types[location.record];
      if (type !== LAND_TYPE) continue;
      const record = await this.db.read(location);
      if (!record.deleted) return parseLand(record);
    }
    return undefined;
  }

  /** Regions (REGN form ids) a cell belongs to (XCLR). */
  async regions(x: number, y: number): Promise<number[]> {
    const id = await this.cell(x, y);
    const record = id === undefined ? undefined : await this.db.get(id);
    const xclr = record?.fields.first('XCLR');
    const regions: number[] = [];
    if (!record || !xclr) return regions;
    for (let offset = 0; offset + 4 <= xclr.length; offset += 4) {
      regions.push(record.formIdAt(xclr, offset));
    }
    return regions;
  }

  /** Water height of a cell: its XCLW, else the world's default. */
  async waterHeight(x: number, y: number): Promise<number | undefined> {
    const id = await this.cell(x, y);
    const record = id === undefined ? undefined : await this.db.get(id);
    const xclw = record?.fields.f32('XCLW');
    if (xclw !== undefined && xclw > -1e9 && xclw < 1e9) return xclw;
    return this.waterWorld.defaultWaterHeight;
  }
}

const LAND_TYPE = 0x444e414c; // 'LAND' as a little-endian four-character code

export const cellKey = (x: number, y: number): string => `${String(x)},${String(y)}`;
