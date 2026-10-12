// Collision layers (COLL records): which layers collide with which, as the engine's
// collision filter reads them from the plugins. Platform-independent.
// Notes: docs/formats/esm.md ("Collision layers").

import { decodeWindows1252 } from '../formats/text.ts';

/** The record fields a collision layer is read from. */
interface RecordSource {
  readonly formId: number;
  readonly editorId?: string | undefined;
  readonly fields: { first(type: string): Uint8Array | undefined };
  formIdAt(data: Uint8Array, offset?: number): number;
}

/** SkyrimLayer indices the engine itself refers to. */
export const Layer = {
  unidentified: 0,
  static: 1,
  animStatic: 2,
  transparent: 3,
  clutter: 4,
  weapon: 5,
  projectile: 6,
  spell: 7,
  biped: 8,
  trees: 9,
  props: 10,
  water: 11,
  trigger: 12,
  terrain: 13,
  trap: 14,
  nonCollidable: 15,
  cloudTrap: 16,
  ground: 17,
  portal: 18,
  debrisSmall: 19,
  debrisLarge: 20,
  acousticSpace: 21,
  actorZone: 22,
  projectileZone: 23,
  gasTrap: 24,
  shellCasing: 25,
  transparentSmall: 26,
  invisibleWall: 27,
  transparentSmallAnim: 28,
  ward: 29,
  charController: 30,
  stairHelper: 31,
  deadBip: 32,
  bipedNoCc: 33,
  avoidBox: 34,
  collisionBox: 35,
  cameraSphere: 36,
  doorDetection: 37,
  coneProjectile: 38,
  camera: 39,
  itemPicker: 40,
  lineOfSight: 41,
  pathingPick: 42,
  customPick1: 43,
  customPick2: 44,
  spellExplosion: 45,
  droppingPick: 46,
} as const;

/** COLL GNAM flags. */
export const LayerFlag = {
  triggerVolume: 0x1,
  sensor: 0x2,
  navmeshObstacle: 0x4,
} as const;

export interface CollisionLayer {
  readonly formId: number;
  readonly editorId: string;
  /** BNAM: the layer's index (SkyrimLayer). */
  readonly index: number;
  /** MNAM. */
  readonly name: string;
  /** GNAM: LayerFlag bits. */
  readonly flags: number;
  /** CNAM: the layers (form ids) this one collides with. */
  readonly collidesWith: readonly number[];
}

export function parseCollisionLayer(record: RecordSource): CollisionLayer {
  const u32 = (type: string): number => {
    const data = record.fields.first(type);
    return data && data.length >= 4
      ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true)
      : 0;
  };
  const name = record.fields.first('MNAM');
  const list = record.fields.first('CNAM');
  const collidesWith: number[] = [];
  if (list)
    for (let o = 0; o + 4 <= list.length; o += 4) collidesWith.push(record.formIdAt(list, o));
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    index: u32('BNAM'),
    name: name ? decodeWindows1252(name).replace(/\0.*$/s, '') : '',
    flags: u32('GNAM'),
    collidesWith,
  };
}

/** Which layers collide: a layer × layer table built from the COLL records. */
export class CollisionMatrix {
  readonly size: number;
  readonly #bits: Uint8Array;
  readonly #flags: Uint32Array;

  constructor(layers: readonly CollisionLayer[]) {
    const byForm = new Map(layers.map((layer) => [layer.formId, layer.index]));
    this.size = Math.max(0, ...layers.map((layer) => layer.index + 1));
    this.#bits = new Uint8Array(this.size * this.size);
    this.#flags = new Uint32Array(this.size);
    for (const layer of layers) {
      this.#flags[layer.index] = layer.flags;
      for (const other of layer.collidesWith) {
        const index = byForm.get(other);
        if (index === undefined) continue;
        // A pair collides if either layer lists the other (the lists are symmetric in the
        // vanilla records).
        this.#bits[layer.index * this.size + index] = 1;
        this.#bits[index * this.size + layer.index] = 1;
      }
    }
  }

  collides(a: number, b: number): boolean {
    if (a >= this.size || b >= this.size || a < 0 || b < 0) return false;
    return this.#bits[a * this.size + b] === 1;
  }

  /** The layer's flags (trigger volume, sensor, navmesh obstacle). */
  flags(layer: number): number {
    return this.#flags[layer] ?? 0;
  }
}
