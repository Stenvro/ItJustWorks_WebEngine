// What a hit leaves where it lands (docs/ai.md, "Combat"): the attacker's weapon names an impact
// data set (WEAP INAM; fists: the race's NAM5; a block or bash: WEAP BIDS), which gives for the
// material struck (an actor: its race's NAM4, MaterialSkin's blood; the world: the shape's
// material) an impact (IPCT): its sound (SNAM, NAM1 for a heavy hit: a power attack) at the hit,
// and its decal (DODT with the texture set DNAM: blood) on the surface behind the target, as far
// as the blow carries it. A decal lasts [Display] fDecalLifetime seconds; at most [Decals]
// uMaxDecals are kept, the oldest going first (observed in the original: each dynamic decal
// is made with the lifetime, the count capped by the setting). TODO(M13): whether a decal fades
// at its end or vanishes. Its effect model (MODL: the blood spray, the sparks) shows at the hit.

import { impactAgainst } from '../audio/impacts.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { GpuDecals } from '../render/decals.ts';
import type { RenderPort } from '../render/render-port.ts';
import { invert } from '../render/frustum.ts';
import type { GpuModel } from '../render/gpu-model.ts';
import { multiply, transformPoint, type Mat4, type Vec3 } from '../render/math.ts';
import type { GpuScene, ModelInstance } from '../render/scene-renderer.ts';
import { skinnedDecalModel, type DecalPose, type DecalTarget } from '../render/skinned-decal.ts';
import {
  expireDecals,
  parseTextureSet,
  placeDecal,
  TextureSetFlag,
  type DecalData,
  type TextureSet,
} from '../world/decal.ts';
import { impactFacing, type Impact } from '../world/impact-records.ts';
import type { GameSession } from './game-session.ts';

/** SLSF1 Decal: a shape that is itself a decal takes none. */
const SLSF1_DECAL = 0x4000000;

/** How far behind a hit its blood lands (game units). */
const SPLATTER_REACH = 160;

/** A hit's decal and when it goes (seconds on the impacts' clock). */
interface LivingDecal {
  readonly gpu: GpuDecals;
  readonly until: number;
  /** A decal on a body: its box where the body's node has it now (undefined: not shown). */
  readonly follow?: () => Mat4 | undefined;
}

/** A body a hit's blood lands on: its placement and its pose (node matrices, model space). */
export interface BleedingBody {
  readonly world: Mat4;
  readonly pose: { readonly worlds: Float32Array };
}

/** An actor's body as drawn: the instances of its models, posed by its skeleton. */
export interface DecalBody extends BleedingBody {
  readonly pose: DecalPose;
  readonly instances: readonly ModelInstance[];
}

/** A hit's blood on an actor's skin: its decal shapes, drawn with the actor's pose. */
interface SkinDecal {
  readonly actor: number;
  readonly model: GpuModel;
  readonly scene: GpuScene;
  readonly until: number;
}

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
  /**
   * Whether the impact may be placed here (a spell's: not within its placement radius of a
   * living one: src/shell/magic-projectiles.ts); not: only its sound, no decal.
   */
  readonly placeable?: (impact: Impact) => boolean;
}

export class CombatImpacts {
  readonly #session: GameSession;
  readonly #renderer: RenderPort;
  readonly #decals: LivingDecal[] = [];
  /** Skinned decals on actors (oldest first), and how many were made this frame. */
  readonly #skin: SkinDecal[] = [];
  #skinMadeThisFrame = 0;
  readonly #decalData = new Map<number, Promise<ImpactDecal | undefined>>();
  /** Seconds now (the decals' lifetimes run on it). */
  readonly #now: () => number;
  #seed = 1;

  /** Shows an impact's effect model (IPCT MODL) at a point, facing a way, for a time. */
  readonly #showModel: ImpactModelShow | undefined;

  constructor(
    session: GameSession,
    renderer: RenderPort,
    now: () => number = () => performance.now() / 1000,
    showModel?: ImpactModelShow,
  ) {
    this.#session = session;
    this.#renderer = renderer;
    this.#now = now;
    this.#showModel = showModel;
  }

  /** The decals of hits (the viewers draw them with their cells'), those past their time gone. */
  *decals(): Iterable<GpuDecals> {
    this.#expire();
    for (const decal of this.#decals) {
      if (decal.follow) {
        const box = decal.follow();
        if (!box) continue;
        decal.gpu.move(box);
      }
      yield decal.gpu;
    }
  }

  /** The skinned decals on actors (drawn with their actors' poses), those past their time gone. */
  *scenes(): Iterable<GpuScene> {
    this.#expire();
    // A new frame: the skinned decals made per frame are counted again.
    this.#skinMadeThisFrame = 0;
    for (const decal of this.#skin) yield decal.scene;
  }

  /**
   * The impact's blood decal on the body it struck (an actor's skin, as its pose moves): its box
   * at the hit, facing along the blow. With `actor` and the body's drawn instances, it is made
   * as the original makes skinned decals (skinned-decal.ts): the triangles of the skinned shapes
   * in its box copied into decal shapes skinned to the same bones. Where no skinned shape lies
   * in the box, the decal is projected onto whatever of the body does, following the body's
   * nearest node. TODO(M13): the original puts geometry decals on rigid worn shapes; ours
   * project.
   */
  async bodyDecal(
    impact: Impact,
    point: Vec3,
    direction: Vec3,
    body: () => BleedingBody | DecalBody | undefined,
    actor?: number,
  ): Promise<void> {
    const data = await this.#decal(impact.formId);
    const now = body();
    if (!data || !now || !this.#withinDecalReach(point)) return;
    const way = normalize(direction);
    const placed = placeDecal(
      data.decal,
      this.#seed++,
      decalFrame(point, [-way[0], -way[1], -way[2]]),
    );
    if (
      actor !== undefined &&
      'instances' in now &&
      this.#session.ini.bool('Decals', 'bSkinnedDecals')
    ) {
      const made = await this.#skinDecal(data, placed, now, actor);
      if (made !== 'none') return;
    }
    const node = nearestNode(now, point);
    if (node < 0) return;
    const nodeWorld = (b: BleedingBody): Mat4 =>
      multiply(b.world, b.pose.worlds.subarray(node * 16, node * 16 + 16));
    const inverse = invert(nodeWorld(now));
    if (!inverse) return;
    const local = multiply(inverse, placed.box);
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
    const lifetime = this.#session.ini.number('Display', 'fDecalLifetime');
    const box = new Float32Array(16);
    this.#decals.push({
      gpu,
      until: this.#now() + lifetime,
      follow: () => {
        const at = body();
        return at && multiply(nodeWorld(at), local, box);
      },
    });
    this.#expire();
  }

  /**
   * A skinned decal on an actor, under the original's limits (observed in the original): none
   * once [Decals] uMaxSkinDecals live, once [Display] iMaxSkinDecalsPerFrame were made this
   * frame, or once the actor carries [Decals] uMaxSkinDecalPerActor; the decal is then not made
   * (the older ones stay). Shapes hidden, shapes that are decals themselves and, without
   * [Decals] bAllowDecalsOnAlpha, alpha-blended or alpha-tested shapes take none.
   * 'none': no skinned shape lies in the box.
   */
  async #skinDecal(
    data: ImpactDecal,
    placed: { readonly box: Mat4; readonly rect: readonly [number, number, number, number] },
    body: DecalBody,
    actor: number,
  ): Promise<'made' | 'refused' | 'none'> {
    const ini = this.#session.ini;
    this.#expire();
    if (
      this.#skin.length >= ini.number('Decals', 'uMaxSkinDecals') ||
      this.#skinMadeThisFrame >= ini.number('Display', 'iMaxSkinDecalsPerFrame') ||
      this.#skin.filter((d) => d.actor === actor).length >=
        ini.number('Decals', 'uMaxSkinDecalPerActor')
    ) {
      return 'refused';
    }
    const onAlpha = ini.bool('Decals', 'bAllowDecalsOnAlpha');
    const targets: { readonly instance: ModelInstance; readonly target: DecalTarget }[] = [];
    for (const instance of body.instances) {
      if (!instance.pose) continue;
      for (const { part } of instance.model.parts) {
        if (!part.skin || part.weaponBlood) continue;
        if (instance.partShown && !instance.partShown(part)) continue;
        if (((part.material?.flags1 ?? 0) & SLSF1_DECAL) !== 0) continue;
        if (!onAlpha && ((part.alpha?.flags ?? 0) & 0x201) !== 0) continue;
        const visible = instance.partitionVisible;
        targets.push({
          instance,
          target: {
            part,
            world: instance.world,
            pose: body.pose,
            ...(visible && { partitionVisible: (bodyPart: number) => visible(bodyPart, part) }),
          },
        });
      }
    }
    const textureSet = data.textureSet;
    const model = skinnedDecalModel(
      targets.map((t) => t.target),
      placed.box,
      placed.rect,
      {
        textures: textureSet.textures,
        flags: data.decal.flags,
        shininess: data.decal.shininess,
        color: data.decal.color,
        noSpecular: (textureSet.flags & TextureSetFlag.noSpecularMap) !== 0,
        modelSpaceNormals: (textureSet.flags & TextureSetFlag.modelSpaceNormals) !== 0,
      },
    );
    if (!model) return 'none';
    this.#skinMadeThisFrame++;
    const gpu = await this.#renderer.scene.createModel(model, this.#session.textures);
    // Drawn as the body is: its placement, motion, visibility and pose.
    const first = targets[0]?.instance;
    const scene =
      first &&
      this.#renderer.scene.createScene([
        {
          model: gpu,
          world: first.world,
          ...(first.motion && { motion: first.motion }),
          ...(first.visibility && { visibility: first.visibility }),
          ...(first.pose && { pose: first.pose }),
          ...(first.partitionVisible && { partitionVisible: first.partitionVisible }),
        },
      ]);
    if (!scene) {
      gpu.destroy();
      return 'made';
    }
    const lifetime = ini.number('Display', 'fDecalLifetime');
    this.#skin.push({ actor, model: gpu, scene, until: this.#now() + lifetime });
    return 'made';
  }

  /**
   * Whether a dynamic decal at a point is made: within [Display] fDecalLOD0 of the camera
   * (observed in the original; farther ones are not made at all). Without a view, always.
   */
  #withinDecalReach(point: Vec3): boolean {
    const camera = this.#renderer.view?.camera.position;
    if (!camera) return true;
    const reach = this.#session.ini.number('Display', 'fDecalLOD0');
    return Math.hypot(point[0] - camera[0], point[1] - camera[1], point[2] - camera[2]) <= reach;
  }

  #expire(): void {
    const max = this.#session.ini.number('Decals', 'uMaxDecals');
    for (const gone of expireDecals(this.#decals, this.#now(), max)) gone.gpu.destroy();
    const now = this.#now();
    for (let i = this.#skin.length - 1; i >= 0; i--) {
      const decal = this.#skin[i];
      if (!decal || decal.until > now) continue;
      this.#skin.splice(i, 1);
      decal.scene.destroy();
      decal.model.destroy();
    }
  }

  /** Sounds a hit and leaves its decal; resolves the impact (IPCT) it was. */
  async hit(hit: HitImpact, physics: PhysicsWorld | undefined): Promise<Impact | undefined> {
    const sounds = this.#session.soundSystem;
    if (!sounds || hit.impactDataSet === undefined) return undefined;
    const records = sounds.impactRecords;
    const set = await records.impactDataSet(hit.impactDataSet);
    if (!set) return undefined;
    const material =
      hit.materialForm !== undefined
        ? await records.material(hit.materialForm)
        : hit.materialId !== undefined
          ? await records.materialById(hit.materialId)
          : undefined;
    const impact = await impactAgainst(records, set, material);
    if (!impact) return undefined;
    const sound = hit.heavy ? (impact.heavySound ?? impact.sound) : impact.sound;
    if (sound !== undefined) void sounds.play(sound, hit.position);
    if (hit.placeable && !hit.placeable(impact)) return impact;
    // Its effect model (the blood's spray, the sparks off metal) where the blow landed.
    if (impact.model && this.#showModel) {
      this.#showModel(impact.model, hit.position, impactFacing(impact.orientation, hit.direction));
    }
    if (physics) await this.#splatter(impact.formId, hit, physics);
    return impact;
  }

  /**
   * Whether an impact draws blood: it leaves a decal (IPCT DNAM, without the no-decal flag), as
   * the impacts of weapons against flesh do (DecalBloodBladeHit, DecalBloodDraugrHit); those
   * against bone, metal, stone and the punches' do not. A weapon that dealt it is bloodied
   * (src/gameplay/combat/weapon-blood.ts). TODO(M13): the engine's own test is not documented.
   */
  async bleeds(impact: Impact): Promise<boolean> {
    return (await this.#decal(impact.formId)) !== undefined;
  }

  /** The impact's decal on what lies behind the hit (blood on the floor or a wall). */
  async #splatter(impact: number, hit: HitImpact, physics: PhysicsWorld): Promise<void> {
    const data = await this.#decal(impact);
    if (!data || !physics.queriesCurrent) return;
    // Along the blow and down: where the blood falls.
    const way = normalize([hit.direction[0], hit.direction[1], hit.direction[2] - 1]);
    const surface = physics.raycast(hit.position, way, SPLATTER_REACH, Layer.static);
    if (!surface || !this.#withinDecalReach(surface.point)) return;
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
    const lifetime = this.#session.ini.number('Display', 'fDecalLifetime');
    this.#decals.push({ gpu, until: this.#now() + lifetime });
    this.#expire();
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
    for (const decal of this.#decals.splice(0)) decal.gpu.destroy();
    for (const decal of this.#skin.splice(0)) {
      decal.scene.destroy();
      decal.model.destroy();
    }
  }
}

/** Shows an impact's effect model for its own time: its path, where, the way it faces. */
export type ImpactModelShow = (model: string, at: Vec3, facing: Vec3) => void;

/** The body's node nearest a point in the world (-1: none). */
export function nearestNode(body: BleedingBody, point: Vec3): number {
  const worlds = body.pose.worlds;
  let best = -1;
  let bestDistance = Infinity;
  for (let node = 0; node * 16 + 15 < worlds.length; node++) {
    const at = transformPoint(body.world, [
      worlds[node * 16 + 12] ?? 0,
      worlds[node * 16 + 13] ?? 0,
      worlds[node * 16 + 14] ?? 0,
    ]);
    const distance = Math.hypot(at[0] - point[0], at[1] - point[1], at[2] - point[2]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
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
