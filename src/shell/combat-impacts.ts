// What a hit leaves where it lands (docs/ai.md, "Combat"): the attacker's weapon names an impact
// data set (WEAP INAM; fists: the race's NAM5; a block or bash: WEAP BIDS), which gives for the
// material struck (an actor: its race's NAM4, MaterialSkin's blood; the world: the shape's
// material) an impact (IPCT): its sound (SNAM, NAM1 for a heavy hit: a power attack) at the hit,
// and its decal (DODT with the texture set DNAM: blood) on the surface behind the target, as far
// as the blow carries it. The decals of the latest hits stay; older ones go. TODO(M13): the
// impact's effect model (MODL: the blood spray's particles) and how long the engine keeps
// decals.

import { impactAgainst } from '../audio/impacts.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { GpuDecals } from '../render/decals.ts';
import type { Renderer } from '../render/renderer.ts';
import type { Mat4, Vec3 } from '../render/math.ts';
import { parseTextureSet, placeDecal, type DecalData, type TextureSet } from '../world/decal.ts';
import type { GameSession } from './game-session.ts';

/** How far behind a hit its blood lands (game units). */
const SPLATTER_REACH = 160;
/** Decals of hits kept at once. */
const MAX_DECALS = 24;

/** An impact's decal (IPCT DODT and DNAM). */
interface ImpactDecal {
  readonly decal: DecalData;
  readonly textureSet: TextureSet;
  readonly base: number;
}

/** A hit to show and sound. */
export interface HitImpact {
  /** The impact data set (IPDS) of what struck. */
  readonly impactDataSet: number | undefined;
  /** What was struck: a material by form id (an actor's race NAM4) or by collision id. */
  readonly materialForm?: number;
  readonly materialId?: number;
  readonly position: Vec3;
  /** Which way the blow went (a unit vector). */
  readonly direction: Vec3;
  readonly heavy: boolean;
}

export class CombatImpacts {
  readonly #session: GameSession;
  readonly #renderer: Renderer;
  readonly #decals: GpuDecals[] = [];
  readonly #decalData = new Map<number, Promise<ImpactDecal | undefined>>();
  #seed = 1;

  constructor(session: GameSession, renderer: Renderer) {
    this.#session = session;
    this.#renderer = renderer;
  }

  /** The decals of hits (the viewers draw them with their cells'). */
  decals(): Iterable<GpuDecals> {
    return this.#decals;
  }

  /** Sounds a hit and leaves its decal. */
  async hit(hit: HitImpact, physics: PhysicsWorld | undefined): Promise<void> {
    const sounds = this.#session.soundSystem;
    if (!sounds || hit.impactDataSet === undefined) return;
    const records = sounds.impactRecords;
    const set = await records.impactDataSet(hit.impactDataSet);
    if (!set) return;
    const material =
      hit.materialForm !== undefined
        ? await records.material(hit.materialForm)
        : hit.materialId !== undefined
          ? await records.materialById(hit.materialId)
          : undefined;
    const impact = await impactAgainst(records, set, material);
    if (!impact) return;
    const sound = hit.heavy ? (impact.heavySound ?? impact.sound) : impact.sound;
    if (sound !== undefined) void sounds.play(sound, hit.position);
    if (physics) await this.#splatter(impact.formId, hit, physics);
  }

  /** The impact's decal on what lies behind the hit (blood on the floor or a wall). */
  async #splatter(impact: number, hit: HitImpact, physics: PhysicsWorld): Promise<void> {
    const data = await this.#decal(impact);
    if (!data || !physics.queriesCurrent) return;
    // Along the blow and down: where the blood falls.
    const way = normalize([hit.direction[0], hit.direction[1], hit.direction[2] - 1]);
    const surface = physics.raycast(hit.position, way, SPLATTER_REACH, Layer.static);
    if (!surface) return;
    const placed = placeDecal(data.decal, this.#seed++, decalFrame(surface.point, surface.normal));
    const gpu = await this.#renderer.decals.createDecals(
      [
        {
          reference: 0,
          base: data.base,
          textureSet: data.textureSet,
          box: placed.box,
          rect: placed.rect,
        },
      ],
      this.#session.textures,
    );
    if (!gpu) return;
    gpu.select(() => true);
    this.#decals.push(gpu);
    while (this.#decals.length > MAX_DECALS) this.#decals.shift()?.destroy();
  }

  #decal(impact: number): Promise<ImpactDecal | undefined> {
    let entry = this.#decalData.get(impact);
    if (!entry) {
      entry = this.#readDecal(impact).catch(() => undefined);
      this.#decalData.set(impact, entry);
    }
    return entry;
  }

  async #readDecal(impact: number): Promise<ImpactDecal | undefined> {
    const db = await this.#session.db;
    const record = await db.get(impact);
    if (record?.type !== 'IPCT') return undefined;
    // DATA flag 0x1: no decal data.
    if (((record.fields.first('DATA')?.[20] ?? 0) & 0x1) !== 0) return undefined;
    const textureSetId = record.formIdField('DNAM');
    const textureRecord = textureSetId === undefined ? undefined : await db.get(textureSetId);
    if (!textureRecord || textureSetId === undefined) return undefined;
    const textureSet = parseTextureSet(textureRecord);
    // The impact's own decal data (DODT, the texture set's layout) over the texture set's.
    const own = parseTextureSet({ fields: record.fields }).decal;
    const decal = own ?? textureSet.decal;
    if (!decal) return undefined;
    return { decal, textureSet: { ...textureSet, decal }, base: textureSetId };
  }

  clear(): void {
    for (const decal of this.#decals.splice(0)) decal.destroy();
  }
}

/** A vector of length 1 (or the one given, if it has none). */
function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : v;
}

/** A decal's frame on a surface: its Y axis into the surface, Z up the texture. */
function decalFrame(point: Vec3, normal: Vec3): Mat4 {
  const y = normalize([-normal[0], -normal[1], -normal[2]]);
  const up: Vec3 = Math.abs(y[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  const x = normalize([
    y[1] * up[2] - y[2] * up[1],
    y[2] * up[0] - y[0] * up[2],
    y[0] * up[1] - y[1] * up[0],
  ]);
  const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return new Float32Array([
    x[0],
    x[1],
    x[2],
    0,
    y[0],
    y[1],
    y[2],
    0,
    z[0],
    z[1],
    z[2],
    0,
    point[0],
    point[1],
    point[2],
    1,
  ]);
}
