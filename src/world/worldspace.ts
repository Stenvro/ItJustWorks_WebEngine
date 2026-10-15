// Worldspaces (WRLD) and their exterior cells: which world supplies the land, water, climate
// and LOD (child worlds such as WhiterunWorld borrow them from Tamriel), and where the
// persistent references are. Layout: docs/formats/esm.md ("Worldspaces").

import { enabledAtGameStart, parseReference, parseTeleport } from './cell-records.ts';
import { CELL_SIZE, parseLand, type LandData } from './land.ts';
import { parseLargeReferences, type LargeReference } from './large-references.ts';
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
  /** ZNAM: the music type (MUSC) where no region names one. */
  readonly music: number | undefined;
  /** MNAM: the world map's extent and camera (undefined: the world has none). */
  readonly map: WorldMapData | undefined;
  /** ONAM: where the world's places show on its map. */
  readonly mapOffset: WorldMapOffset;
  /** MODL: the world map's clouds (undefined: the engine's default). */
  readonly cloudModel: string | undefined;
}

/**
 * WRLD MNAM: the world map. The usable dimensions (pixels of the old 2D map, unused), the
 * cells it spans (north-west and south-east corner cells) and its camera: the lowest and
 * highest the camera goes and the pitch it opens with (degrees below the horizon). The 16-byte
 * form of older plugins has no camera data: 50000, 80000 and 50 (the CK's defaults).
 */
export interface WorldMapData {
  readonly usableWidth: number;
  readonly usableHeight: number;
  readonly northWest: readonly [number, number];
  readonly southEast: readonly [number, number];
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly initialPitch: number;
}

/** WRLD ONAM: the world map's scale and offset (a world shown on another world's map). */
export interface WorldMapOffset {
  readonly scale: number;
  readonly offset: readonly [number, number, number];
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
    music: record.formIdField('ZNAM'),
    map: parseWorldMap(record.fields.first('MNAM')),
    mapOffset: {
      scale: f32('ONAM', 0) ?? 1,
      offset: [f32('ONAM', 4) ?? 0, f32('ONAM', 8) ?? 0, f32('ONAM', 12) ?? 0],
    },
    cloudModel: nonEmpty(record.text('MODL')),
  };
}

const nonEmpty = (text: string | undefined): string | undefined =>
  text === undefined || text === '' ? undefined : text;

function parseWorldMap(data: Uint8Array | undefined): WorldMapData | undefined {
  if (!data || data.length < 16) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const camera = data.length >= 28;
  return {
    usableWidth: view.getInt32(0, true),
    usableHeight: view.getInt32(4, true),
    northWest: [view.getInt16(8, true), view.getInt16(10, true)],
    southEast: [view.getInt16(12, true), view.getInt16(14, true)],
    minHeight: camera ? view.getFloat32(16, true) : 50000,
    maxHeight: camera ? view.getFloat32(20, true) : 80000,
    initialPitch: camera ? view.getFloat32(24, true) : 50,
  };
}

/** Where to put the player: a position (feet) and a heading (radians, clockwise from north). */
export interface Arrival {
  readonly position: readonly [number, number, number];
  readonly heading: number;
}

/** The engine's map marker (STAT): fast travel arrives at these. */
const MAP_MARKER = 0x10;

/** A worldspace with the indexes needed to load its exterior cells. */
export class Worldspace {
  readonly db: RecordDatabase;
  readonly record: WorldspaceRecord;
  /** The world whose landscape, water, climate and LOD are used (itself or its parent). */
  readonly landWorld: WorldspaceRecord;
  readonly waterWorld: WorldspaceRecord;
  readonly climateWorld: WorldspaceRecord;
  readonly lodWorld: WorldspaceRecord;
  /** The world whose map is shown (itself or its parent). */
  readonly mapWorld: WorldspaceRecord;
  /** Large references by the cells they reach into ("x,y"), from every plugin's RNAM. */
  readonly largeReferences: ReadonlyMap<string, readonly LargeReference[]>;
  /** Persistent references by cell "x,y". */
  readonly #persistent: Map<string, number[]>;
  /** Load doors in the world (persistent references with XTEL) and where they stand. */
  readonly #doors: readonly { readonly door: number; readonly x: number; readonly y: number }[];
  /** Map markers: where fast travel puts the player. */
  readonly #mapMarkers: readonly Arrival[];
  readonly #land = new Map<string, Promise<LandData | undefined>>();

  private constructor(
    db: RecordDatabase,
    record: WorldspaceRecord,
    parent: WorldspaceRecord | undefined,
    persistent: Map<string, number[]>,
    largeReferences: ReadonlyMap<string, readonly LargeReference[]>,
    doors: readonly { readonly door: number; readonly x: number; readonly y: number }[],
    mapMarkers: readonly Arrival[],
  ) {
    this.db = db;
    this.record = record;
    this.largeReferences = largeReferences;
    const from = (bit: number): WorldspaceRecord =>
      parent && (record.parentUse & bit) !== 0 ? parent : record;
    this.landWorld = from(ParentUse.land);
    this.waterWorld = from(ParentUse.water);
    this.climateWorld = from(ParentUse.climate);
    this.lodWorld = from(ParentUse.lod);
    this.mapWorld = from(ParentUse.map);
    this.#persistent = persistent;
    this.#doors = doors;
    this.#mapMarkers = mapMarkers;
  }

  /** Reads the worldspace and sorts its persistent references into cells by position. */
  static async open(db: RecordDatabase, formId: number): Promise<Worldspace> {
    const record = parseWorldspace(await db.require(formId));
    const parentRecord = record.parent === undefined ? undefined : await db.get(record.parent);
    const parent = parentRecord ? parseWorldspace(parentRecord) : undefined;
    const persistent = new Map<string, number[]>();
    const doors: { door: number; x: number; y: number }[] = [];
    const mapMarkers: Arrival[] = [];
    const persistentCell = db.persistentCell(formId);
    if (persistentCell !== undefined) {
      for (const id of db.cellReferences(persistentCell)) {
        const ref = await db.get(id);
        if (!ref || ref.deleted || (ref.type !== 'REFR' && ref.type !== 'ACHR')) continue;
        const placed = parseReference(ref);
        const { position } = placed;
        // Load doors and map markers are persistent: where the player comes into the world.
        if (ref.fields.has('XTEL')) doors.push({ door: id, x: position[0], y: position[1] });
        if (placed.base === MAP_MARKER) {
          mapMarkers.push({ position, heading: placed.rotation[2] });
        }
        const key = cellKey(
          Math.floor(position[0] / CELL_SIZE),
          Math.floor(position[1] / CELL_SIZE),
        );
        const list = persistent.get(key) ?? [];
        list.push(id);
        persistent.set(key, list);
      }
    }
    const versions = await Promise.all(db.locateAll(formId).map((location) => db.read(location)));
    return new Worldspace(
      db,
      record,
      parent,
      persistent,
      parseLargeReferences(versions),
      doors,
      mapMarkers,
    );
  }

  /**
   * Where the player comes into the world near a point, as the game brings them in: in front
   * of the nearest load door (the arrival point of the door on its other side, XTEL), else at
   * the nearest map marker (where fast travel arrives). Undefined if the world has neither.
   * Only doors there at the start of a new game count, on both sides (the East Empire Company
   * Warehouse's way to Brinewater Grotto is disabled, and boxes stand in front of it).
   */
  async arrivalNear(x: number, y: number): Promise<Arrival | undefined> {
    const distance = (px: number, py: number): number => Math.hypot(px - x, py - y);
    const doors = [...this.#doors].sort((a, b) => distance(a.x, a.y) - distance(b.x, b.y));
    let best: (Arrival & { readonly distance: number }) | undefined;
    for (const { door } of doors.slice(0, 8)) {
      const own = await this.db.get(door);
      const destination = own && parseTeleport(own);
      const other = destination && (await this.db.get(destination.door));
      const back = other && parseTeleport(other);
      // The door on the other side leads back here; its XTEL is where one arrives.
      if (!destination || back?.door !== door) continue;
      if (!(await enabledAtGameStart(this.db, door))) continue;
      if (!(await enabledAtGameStart(this.db, destination.door))) continue;
      const d = distance(back.position[0], back.position[1]);
      if (!best || d < best.distance) {
        best = { position: back.position, heading: back.rotation[2], distance: d };
      }
    }
    if (!best) {
      for (const marker of this.#mapMarkers) {
        const d = distance(marker.position[0], marker.position[1]);
        if (!best || d < best.distance) best = { ...marker, distance: d };
      }
    }
    return best && { position: best.position, heading: best.heading };
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

  /** The music type a cell names (XCMO), if any. */
  async cellMusic(x: number, y: number): Promise<number | undefined> {
    const id = await this.cell(x, y);
    const record = id === undefined ? undefined : await this.db.get(id);
    return record?.formIdField('XCMO');
  }

  /** Water height of a cell: its XCLW, else the world's default. */
  async waterHeight(x: number, y: number): Promise<number | undefined> {
    const id = await this.cell(x, y);
    const record = id === undefined ? undefined : await this.db.get(id);
    const xclw = record?.fields.f32('XCLW');
    if (xclw !== undefined && xclw > -1e9 && xclw < 1e9) return xclw;
    return this.defaultWaterHeight;
  }

  /**
   * The default water height of its cells: part of the land data (DNAM, "Land Data" in xEdit),
   * so a world that uses its parent's land has none of its own and takes the parent's
   * (KatariahWorld: Tamriel's −14000, not 0), whichever world its water type comes from.
   */
  get defaultWaterHeight(): number {
    return this.landWorld.defaultWaterHeight;
  }
}

const LAND_TYPE = 0x444e414c; // 'LAND' as a little-endian four-character code

export const cellKey = (x: number, y: number): string => `${String(x)},${String(y)}`;
