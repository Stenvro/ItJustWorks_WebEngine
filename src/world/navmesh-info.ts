// The navmesh info map (NAVI): one record (0x12FB4) that every plugin touching navigation
// meshes overrides, with an entry per navmesh: where it is, the navmeshes its edges lead into,
// the doors on it, for some a coarse copy of it; and precomputed paths along the roads of
// Tamriel. The engine's NavMeshInfoMap (CommonLibSSE: BSNavmeshInfo, NavMeshInfoMap,
// BSPrecomputedNavmeshInfoPathMap); layout from xEdit (wbDefinitionsTES5 NAVI). Details:
// docs/formats/esm.md ("Navmesh info map"). Platform-independent.

import { BinaryReader, FormatError } from '../formats/binary-reader.ts';
import { PathingType, readPathingCell, type Navmesh } from './navmesh.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

/** The NVER of Skyrim (and SSE). */
export const NAVMESH_INFO_VERSION = 12;

/** NVMI flags. */
export const NavmeshInfoFlag = {
  /** The entry carries island data (xEdit: "Is Island"). */
  island: 0x20,
  /** Set on the road markers' navmeshes (xEdit: "Not Edited"). */
  roadMarker: 0x40,
} as const;

/** NVMI island data: a coarse copy of the navmesh (as many triangles or fewer). */
export interface NavmeshIsland {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Vertex indices, three per triangle. */
  readonly triangles: Uint16Array;
  /** xyz per vertex, world coordinates. */
  readonly vertices: Float32Array;
}

/** A navmesh's entry in the info map. */
export interface NavmeshInfo {
  readonly navmesh: number;
  /** NavmeshInfoFlag bits. */
  readonly flags: number;
  /** The middle of its vertices (game units). */
  readonly location: readonly [number, number, number];
  /** The share of its triangles flagged preferred (0–1). */
  readonly preferred: number;
  /** The other navmeshes its edge links lead into (portals and ledges), but not… */
  readonly edgeLinks: readonly number[];
  /** …those reached over an edge of a preferred triangle: these. */
  readonly preferredEdgeLinks: readonly number[];
  /** The door references on its door triangles. */
  readonly doors: readonly number[];
  readonly island: NavmeshIsland | undefined;
  /** The worldspace, 0 for interiors. */
  readonly world: number;
  /** Interiors: the cell; worldspaces: its grid (x, y). */
  readonly cell: Navmesh['cell'];
}

/** A precomputed path's end: a navmesh by a road marker. */
export interface RoadMarker {
  readonly navmesh: number;
  /** Its row and column in the path matrix (NavmeshInfoMap.paths). */
  readonly index: number;
}

/** One plugin's version of the NAVI record. */
export interface NavmeshInfoRecord {
  readonly version: number;
  readonly infos: readonly NavmeshInfo[];
  /** NVPP: the path matrix (see NavmeshInfoMap). */
  readonly paths: readonly (readonly number[])[];
  readonly roadMarkers: readonly RoadMarker[];
  /** NVSI: navmeshes this plugin deletes. */
  readonly deleted: readonly number[];
}

/** Reads one version of the NAVI record. */
export function parseNavmeshInfoRecord(record: GameRecord): NavmeshInfoRecord {
  const nver = record.fields.u32('NVER');
  if (nver !== NAVMESH_INFO_VERSION) {
    throw new FormatError(
      `NAVI version ${String(nver)}, expected ${String(NAVMESH_INFO_VERSION)}`,
      0,
    );
  }
  const infos = record.fields.all('NVMI').map((data) => parseInfo(record, data));
  let paths: number[][] = [];
  let roadMarkers: RoadMarker[] = [];
  const nvpp = record.fields.first('NVPP');
  if (nvpp) ({ paths, roadMarkers } = parsePaths(record, nvpp));
  const deleted: number[] = [];
  const nvsi = record.fields.first('NVSI');
  if (nvsi) {
    if (nvsi.length % 4 !== 0) throw new FormatError(`NVSI of ${String(nvsi.length)} bytes`, 0);
    for (let offset = 0; offset < nvsi.length; offset += 4) {
      deleted.push(record.formIdAt(nvsi, offset));
    }
  }
  return { version: nver, infos, paths, roadMarkers, deleted };
}

/** A reader over a field of `record` that also reads form ids (as global ids). */
function fieldReader(
  record: GameRecord,
  data: Uint8Array,
): { reader: BinaryReader; formId: () => number } {
  const reader = new BinaryReader(data);
  const formId = (): number => {
    const offset = reader.offset;
    reader.skip(4);
    return record.formIdAt(data, offset);
  };
  return { reader, formId };
}

function parseInfo(record: GameRecord, data: Uint8Array): NavmeshInfo {
  const { reader, formId } = fieldReader(record, data);
  const formIds = (): number[] => Array.from({ length: reader.u32() }, formId);
  const vec3 = (): [number, number, number] => [reader.f32(), reader.f32(), reader.f32()];
  const navmesh = formId();
  const flags = reader.u32();
  const location = vec3();
  const preferred = reader.f32();
  const edgeLinks = formIds();
  const preferredEdgeLinks = formIds();
  const doors: number[] = [];
  const doorCount = reader.u32();
  for (let i = 0; i < doorCount; i++) {
    const type = reader.u32();
    if (type !== PathingType.door) {
      throw new FormatError(`NVMI door link of type ${type.toString(16)}`, reader.offset - 4);
    }
    doors.push(formId());
  }
  let island: NavmeshIsland | undefined;
  if (reader.u8() !== 0) {
    const min = vec3();
    const max = vec3();
    const triangles = new Uint16Array(reader.u32() * 3);
    for (let i = 0; i < triangles.length; i++) triangles[i] = reader.u16();
    const vertices = new Float32Array(reader.u32() * 3);
    for (let i = 0; i < vertices.length; i++) vertices[i] = reader.f32();
    island = { min, max, triangles, vertices };
  }
  const { world, cell } = readPathingCell(reader, formId);
  if (reader.remaining !== 0) {
    throw new FormatError(`NVMI: ${String(reader.remaining)} bytes left over`, reader.offset);
  }
  return {
    navmesh,
    flags,
    location,
    preferred,
    edgeLinks,
    preferredEdgeLinks,
    doors,
    island,
    world,
    cell,
  };
}

function parsePaths(
  record: GameRecord,
  data: Uint8Array,
): { paths: number[][]; roadMarkers: RoadMarker[] } {
  const { reader, formId } = fieldReader(record, data);
  const paths = Array.from({ length: reader.u32() }, () =>
    Array.from({ length: reader.u32() }, formId),
  );
  const roadMarkers: RoadMarker[] = [];
  const markerCount = reader.u32();
  for (let i = 0; i < markerCount; i++) {
    const navmesh = formId();
    roadMarkers.push({ navmesh, index: reader.u32() });
  }
  if (reader.remaining !== 0) {
    throw new FormatError(`NVPP: ${String(reader.remaining)} bytes left over`, reader.offset);
  }
  return { paths, roadMarkers };
}

/** The navmesh info map of the whole load order. */
export interface NavmeshInfoMap {
  /** Every navmesh's entry, by navmesh. */
  readonly infos: ReadonlyMap<number, NavmeshInfo>;
  /**
   * Precomputed paths between the road markers, a matrix: `paths[from × markers + to]` lists
   * the navmeshes from marker `from`'s navmesh to marker `to`'s, each next to the one before.
   */
  readonly paths: readonly (readonly number[])[];
  readonly roadMarkers: readonly RoadMarker[];
}

/**
 * Merges the versions of the NAVI record in load order: each plugin's entries replace those of
 * the plugins before it navmesh by navmesh, its deleted navmeshes leave the map, and the
 * precomputed paths of the last one that has them win (vanilla's plugins all carry the same).
 */
export function mergeNavmeshInfo(records: readonly NavmeshInfoRecord[]): NavmeshInfoMap {
  const infos = new Map<number, NavmeshInfo>();
  let paths: NavmeshInfoRecord['paths'] = [];
  let roadMarkers: NavmeshInfoRecord['roadMarkers'] = [];
  for (const record of records) {
    for (const info of record.infos) infos.set(info.navmesh, info);
    for (const navmesh of record.deleted) infos.delete(navmesh);
    if (record.paths.length > 0 || record.roadMarkers.length > 0) {
      ({ paths, roadMarkers } = record);
    }
  }
  return { infos, paths, roadMarkers };
}

/** The precomputed path between two road markers' navmeshes, if there is one. */
export function precomputedPath(
  map: NavmeshInfoMap,
  from: number,
  to: number,
): readonly number[] | undefined {
  const index = (navmesh: number): number | undefined =>
    map.roadMarkers.find((marker) => marker.navmesh === navmesh)?.index;
  const a = index(from);
  const b = index(to);
  if (a === undefined || b === undefined) return undefined;
  return map.paths[a * map.roadMarkers.length + b];
}

/** Every version of the NAVI record (vanilla: one, 0x12FB4), in load order. */
export async function navmeshInfoRecords(
  db: RecordDatabase,
): Promise<{ readonly plugin: string; readonly record: NavmeshInfoRecord }[]> {
  const locations = db
    .formIdsOfType('NAVI')
    .flatMap((id) => db.locateAll(id))
    .filter((location) => db.typeAt(location) === 'NAVI')
    .sort((a, b) => a.plugin.slot - b.plugin.slot);
  const records: { plugin: string; record: NavmeshInfoRecord }[] = [];
  for (const location of locations) {
    const record = await db.read(location);
    if (record.deleted) continue;
    records.push({ plugin: location.plugin.entry.name, record: parseNavmeshInfoRecord(record) });
  }
  return records;
}

/** The merged navmesh info map of the load order. */
export async function loadNavmeshInfo(db: RecordDatabase): Promise<NavmeshInfoMap> {
  return mergeNavmeshInfo((await navmeshInfoRecords(db)).map(({ record }) => record));
}
