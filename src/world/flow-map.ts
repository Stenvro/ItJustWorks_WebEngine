// A river cell's flow map (textures\water\<plugin>\flow.<x>.<y>.dds, docs/formats/esm.md, "Flow
// maps"): which way and how strongly its water flows, for the water's physics (rivers of a type
// with the Enable Flowmap flag carry what floats along it). Platform-independent.

import { parseDds } from '../formats/dds/dds.ts';
import { decodeDdsLevel } from '../formats/dds/decode.ts';
import { CELL_SIZE } from './land.ts';
import type { Worldspace } from './worldspace.ts';

/**
 * How fast a river flows at full strength (game units a second): the water shader's speed.
 * TODO(M13): the engine's own speed for the flow map is not documented.
 */
export const FLOW_SPEED = 160;

export interface FlowMap {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  /** South-west corner of the cell it covers (game units). */
  readonly origin: readonly [number, number];
}

/** The plugin whose folder holds a worldspace's flow maps: its water worldspace's. */
export function waterPlugin(world: Worldspace): string {
  return world.db.locateAll(world.waterWorld.formId)[0]?.plugin.entry.name ?? '';
}

/** The flow maps of a worldspace's cells, read as they are first asked for. */
export class FlowMaps {
  readonly #read: (path: string) => Promise<Uint8Array | undefined>;
  readonly #maps = new Map<string, FlowMap | null>();

  /** `read`: a file of the data (undefined where it is missing). */
  constructor(read: (path: string) => Promise<Uint8Array | undefined>) {
    this.#read = read;
  }

  /**
   * The flow at a point of a worldspace's cell (`plugin`: the plugin of its water's
   * worldspace, which names the folder), undefined while its map loads or where it has none.
   */
  at(plugin: string, x: number, y: number): [number, number] | undefined {
    const cx = Math.floor(x / CELL_SIZE);
    const cy = Math.floor(y / CELL_SIZE);
    const path = `textures\\water\\${plugin.toLowerCase()}\\flow.${String(cx)}.${String(cy)}.dds`;
    const map = this.#maps.get(path);
    if (map === undefined) {
      this.#maps.set(path, null);
      void this.#read(path)
        .then((bytes) => {
          if (bytes) this.#maps.set(path, parseFlowMap(bytes, [cx * CELL_SIZE, cy * CELL_SIZE]));
        })
        .catch(() => undefined);
      return undefined;
    }
    return map ? flowAt(map, x, y) : undefined;
  }
}

/** A flow map of a cell whose south-west corner is at `origin`. */
export function parseFlowMap(bytes: Uint8Array, origin: readonly [number, number]): FlowMap {
  const texture = parseDds(bytes);
  const level = texture.levels[0];
  if (!level) throw new Error('flow map without a level');
  return { width: level.width, height: level.height, rgba: decodeDdsLevel(texture, level), origin };
}

/**
 * The flow at a point of the map's cell: its direction (east, north), a unit vector (R/G
 * around 128; row 0 at the north edge). The direction is smooth across the whole river; the
 * alpha (the shader's strength) is striped from texel to texel (Riverwood's river: 255 next to
 * 4 within a texel), so the physics flows at one speed along the direction.
 * TODO(M13): whether the engine slows its current by the alpha.
 */
export function flowAt(map: FlowMap, x: number, y: number): [number, number] {
  const u = (x - map.origin[0]) / CELL_SIZE;
  const v = 1 - (y - map.origin[1]) / CELL_SIZE;
  const column = Math.max(0, Math.min(map.width - 1, Math.floor(u * map.width)));
  const row = Math.max(0, Math.min(map.height - 1, Math.floor(v * map.height)));
  const i = (row * map.width + column) * 4;
  const east = ((map.rgba[i] ?? 128) - 128) / 127;
  const north = ((map.rgba[i + 1] ?? 128) - 128) / 127;
  const length = Math.hypot(east, north);
  if (length < 1e-3) return [0, 0];
  return [east / length, north / length];
}
