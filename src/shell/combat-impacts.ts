// What a hit leaves where it lands (docs/ai.md, "Combat"): the attacker's weapon names an impact
// data set (WEAP INAM; fists: the race's NAM5; a block or bash: WEAP BIDS), which gives for the
// material struck (an actor: its race's NAM4, MaterialSkin's blood; the world: the shape's
// material) an impact (IPCT): its sound (SNAM; NAM1 for a heavy hit, a power attack, or a hit on
// the player: blowSound) at the hit, and its decal (DODT with the texture set DNAM: blood) on the surface behind the target (the
// environment blood, #splatter; docs/rendering.md, "Decals"). A decal lasts [Display]
// fDecalLifetime seconds, then fades out over one more (DECAL_FADE_SECONDS); at most [Decals]
// uMaxDecals are kept, the oldest going first (observed in the original: each dynamic decal is
// made with the lifetime, the count capped by the setting). Its effect model (MODL: the blood
// spray, the sparks) shows at the hit.

import { blowSound, impactAgainst } from '../audio/impacts.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { GpuDecals } from '../render/decals.ts';
import type { RenderPort } from '../render/render-port.ts';
import { invert } from '../render/frustum.ts';
import type { GpuModel } from '../render/gpu-model.ts';
import { identity, multiply, transformPoint, type Mat4, type Vec3 } from '../render/math.ts';
import type { GpuScene, ModelInstance } from '../render/scene-renderer.ts';
import {
  rigidDecalPart,
  skinnedDecalMaterial,
  skinnedDecalPart,
  type DecalPose,
  type DecalTarget,
  type SkinnedDecalLook,
} from '../render/skinned-decal.ts';
import type { ModelData, ModelPart } from '../render/model-data.ts';
import {
  landDecalPart,
  worldDecalBox,
  worldDecalFaceLimit,
  worldDecalPart,
  type DecalLand,
  type WorldDecalLook,
} from '../render/world-decal.ts';
import {
  DECAL_SPACING,
  DecalFlag,
  decalAlpha,
  decalGoneAt,
  decalTooNear,
  ENVIRONMENT_BLOOD,
  environmentBloodWay,
  expireDecals,
  landSpaceOrigin,
  parseTextureSet,
  placeDecal,
  placedSize,
  squareDecal,
  struckNodeKey,
  TextureSetFlag,
  type DecalData,
  type DecalSpot,
  type TextureSet,
} from '../world/decal.ts';
import { impactFacing, type Impact } from '../world/impact-records.ts';
import type { SavedDecal } from '../save/world-save.ts';
import type { GameSession } from './game-session.ts';

/** SLSF1 Decal: a shape that is itself a decal takes none. */
const SLSF1_DECAL = 0x4000000;

/**
 * How far a hit on the world looks along the blow (and down) for the surface its decal goes
 * on (game units; the hit's point lies on it).
 */
const SPLATTER_REACH = 160;

/**
 * A hit's decal and when it goes (seconds on the impacts' clock, its fade included): projected
 * (`gpu`: a body known only by its pose, or a world without its drawn shapes given) or built on
 * the struck shapes (`shapes`: their decal shapes, drawn where those are).
 */
interface LivingDecal {
  readonly gpu?: GpuDecals;
  readonly shapes?: { readonly model: GpuModel; readonly scene: GpuScene };
  readonly until: number;
  /** A decal on a body: its box where the body's node has it now (undefined: not shown). */
  readonly follow?: () => Mat4 | undefined;
  /** A decal on the world: the node it is on (struckNodeKey), where it was made, its width. */
  readonly spot?: DecalSpot & { readonly node: string };
  /** What a save keeps of a world decal (on the first of the shapes made for it). */
  readonly stored?: StoredDecal;
}

/** A world decal as the store keeps it: a save's, but for its time (kept as `until`). */
type StoredDecal = Omit<SavedDecal, 'left'>;

/** A saved world decal waiting for what it lies on to be drawn, and when it goes. */
interface RestoredDecal {
  readonly saved: SavedDecal;
  readonly until: number;
  /** Being built (its data or cell read). */
  building?: boolean;
}

/**
 * What of the loaded world a decal is built on (the viewer's): the drawn instances of a placed
 * reference, and the land of the cell holding a point.
 */
export interface DecalSurfaces {
  instances(reference: number): readonly ModelInstance[] | undefined;
  land(x: number, y: number): DecalLand | undefined;
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

/**
 * A hit's blood on an actor: its decal shapes on the skinned shapes (drawn with the actor's
 * pose) and on the rigid ones (each on its shape's node), and how many of each.
 */
interface SkinDecal {
  readonly actor: number;
  readonly model: GpuModel;
  readonly scene: GpuScene;
  readonly until: number;
  readonly skinned: number;
  readonly rigid: number;
  /** Its plain decals on the actor's rigid shapes: the node each is on, where it was made. */
  readonly spots: readonly (DecalSpot & { readonly node: number | ModelPart })[];
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
  /** It struck the player: the impact's player sound (blowSound: IPCT NAM1). */
  readonly onPlayer?: boolean;
  /**
   * Whether the impact may be placed here (a spell's: not within its placement radius of a
   * living one: src/shell/magic-projectiles.ts); not: only its sound, no decal.
   */
  readonly placeable?: (impact: Impact) => boolean;
  /**
   * Its decal is made whatever the spacing, the decals made this frame and the distance
   * (observed in the original: ObjectReference.PlayImpactEffect's).
   */
  readonly forced?: boolean;
  /**
   * An actor hit's environment blood: the impact data set of its struck limb (observed in the
   * original: that part's sever impact data set in the target race's body part data); none:
   * the hit leaves none behind the target.
   */
  readonly environmentBlood?: number;
}

export class CombatImpacts {
  readonly #session: GameSession;
  readonly #renderer: RenderPort;
  readonly #decals: LivingDecal[] = [];
  /** Skinned decals on actors (oldest first), and how many were made this frame. */
  readonly #skin: SkinDecal[] = [];
  #skinMadeThisFrame = 0;
  /** Decal shapes on actors' rigid shapes made this frame (iMaxDecalsPerFrame). */
  #rigidMadeThisFrame = 0;
  readonly #decalData = new Map<number, Promise<ImpactDecal | undefined>>();
  /** Seconds now (the decals' lifetimes run on it). */
  readonly #now: () => number;
  #seed = 1;

  /** Shows an impact's effect model (IPCT MODL) at a point, facing a way, for a time. */
  readonly #showModel: ImpactModelShow | undefined;
  /** The world's shapes and land the decals of hits on it are built on (the viewer's). */
  readonly #surfaces: (() => DecalSurfaces | undefined) | undefined;

  constructor(
    session: GameSession,
    renderer: RenderPort,
    now: () => number = () => performance.now() / 1000,
    showModel?: ImpactModelShow,
    surfaces?: () => DecalSurfaces | undefined,
  ) {
    this.#session = session;
    this.#renderer = renderer;
    this.#now = now;
    this.#showModel = showModel;
    this.#surfaces = surfaces;
  }

  /** The decals of hits (the viewers draw them with their cells'), those past their time gone. */
  *decals(): Iterable<GpuDecals> {
    this.#expire();
    const now = this.#now();
    for (const decal of this.#decals) {
      const gpu = decal.gpu;
      if (!gpu) continue;
      if (decal.follow) {
        const box = decal.follow();
        if (!box) continue;
        gpu.move(box);
      }
      gpu.fade(decalAlpha(decal.until, now));
      yield gpu;
    }
  }

  /**
   * The skinned decals on actors (drawn with their actors' poses) and the decal shapes on the
   * world, those past their time gone and those at their end fading.
   */
  *scenes(): Iterable<GpuScene> {
    this.#expire();
    // A new frame: the decals made per frame are counted again.
    this.#skinMadeThisFrame = 0;
    this.#rigidMadeThisFrame = 0;
    this.#buildRestored();
    const now = this.#now();
    const fade = (scene: GpuScene, until: number): GpuScene => {
      const alpha = decalAlpha(until, now);
      if (alpha < 1) this.#renderer.scene.fadeScene(scene, alpha);
      return scene;
    };
    for (const decal of this.#skin) yield fade(decal.scene, decal.until);
    for (const decal of this.#decals) {
      if (decal.shapes) yield fade(decal.shapes.scene, decal.until);
    }
  }

  /**
   * The impact's blood decal on the body it struck (an actor's skin, as its pose moves): its box
   * at the hit, facing along the blow. With `actor` and the body's drawn instances, it is made
   * as the original makes decals on an actor's shapes (#actorDecal, skinned-decal.ts): each
   * shape in the box takes its own, a skinned shape's triangles in the box copied into a decal
   * shape skinned to the same bones, a rigid shape's into one on that shape's node; where no
   * shape lies in the box there is none. A body known only by its pose (no drawn instances)
   * takes the decal projected onto whatever of it lies in the box, following its nearest node.
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
    if (actor !== undefined && 'instances' in now) {
      await this.#actorDecal(data, { ...placed, point }, now, actor);
      return;
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
      until: decalGoneAt(this.#now(), lifetime),
      follow: () => {
        const at = body();
        return at && multiply(nodeWorld(at), local, box);
      },
    });
    this.#expire();
  }

  /**
   * A hit's decal on an actor's shapes, as the original makes them (observed in the original):
   * it visits the shapes of the actor's 3D in its box, leaving out hidden shapes, shapes that
   * are decals themselves and, without [Decals] bAllowDecalsOnAlpha, alpha-blended or
   * alpha-tested ones. A skinned shape takes a skinned decal while fewer than [Decals]
   * uMaxSkinDecals live, fewer than [Display] iMaxSkinDecalsPerFrame were made this frame and
   * the actor carries fewer than [Decals] uMaxSkinDecalPerActor (each shape's decal counts;
   * without [Decals] bSkinnedDecals, none); a rigid shape (a helmet, a shield, a worn weapon)
   * takes a plain decal on its own geometry, hung on its node, while fewer than [Display]
   * iMaxDecalsPerFrame were made this frame (and fewer than [Decals] uMaxDecals live), and none
   * on the same node was made too near (decalTooNear, the impacts' spacing of 16). Past a
   * limit the decal is not made (the older ones stay). 'none': no shape lies in the box.
   */
  async #actorDecal(
    data: ImpactDecal,
    placed: {
      readonly box: Mat4;
      readonly rect: readonly [number, number, number, number];
      readonly point: Vec3;
    },
    body: DecalBody,
    actor: number,
  ): Promise<'made' | 'refused' | 'none'> {
    const ini = this.#session.ini;
    this.#expire();
    const sum = (decals: readonly SkinDecal[], of: (d: SkinDecal) => number): number =>
      decals.reduce((total, d) => total + of(d), 0);
    let skinLeft = ini.bool('Decals', 'bSkinnedDecals')
      ? Math.min(
          ini.number('Decals', 'uMaxSkinDecals') - sum(this.#skin, (d) => d.skinned),
          ini.number('Display', 'iMaxSkinDecalsPerFrame') - this.#skinMadeThisFrame,
          ini.number('Decals', 'uMaxSkinDecalPerActor') -
            sum(
              this.#skin.filter((d) => d.actor === actor),
              (d) => d.skinned,
            ),
        )
      : 0;
    let rigidLeft = Math.min(
      ini.number('Display', 'iMaxDecalsPerFrame') - this.#rigidMadeThisFrame,
      ini.number('Decals', 'uMaxDecals') - this.#decals.length - sum(this.#skin, (d) => d.rigid),
    );
    const onAlpha = ini.bool('Decals', 'bAllowDecalsOnAlpha');
    const textureSet = data.textureSet;
    const look: SkinnedDecalLook = {
      textures: textureSet.textures,
      flags: data.decal.flags,
      shininess: data.decal.shininess,
      color: data.decal.color,
      noSpecular: (textureSet.flags & TextureSetFlag.noSpecularMap) !== 0,
      modelSpaceNormals: (textureSet.flags & TextureSetFlag.modelSpaceNormals) !== 0,
    };
    const { material, alpha } = skinnedDecalMaterial(look);
    const parts: ModelPart[] = [];
    /** The skeleton node each rigid decal shape hangs on (the decal instance's pose nodes). */
    const hung: number[] = [];
    /** The plain decals on this actor's rigid shapes, live or made now, by node. */
    const spots = this.#skin.filter((d) => d.actor === actor).flatMap((d) => d.spots);
    const made: SkinDecal['spots'][number][] = [];
    const size = placedSize(placed);
    let skinned = 0;
    let rigid = 0;
    let found = false;
    let first: ModelInstance | undefined;
    for (const instance of body.instances) {
      if (!instance.pose) continue;
      for (const { part } of instance.model.parts) {
        if (part.weaponBlood) continue;
        if (instance.partShown && !instance.partShown(part)) continue;
        if (((part.material?.flags1 ?? 0) & SLSF1_DECAL) !== 0) continue;
        if (!onAlpha && ((part.alpha?.flags ?? 0) & 0x201) !== 0) continue;
        if (part.skin) {
          const visible = instance.partitionVisible;
          const target: DecalTarget = {
            part,
            world: instance.world,
            pose: body.pose,
            ...(visible && { partitionVisible: (bodyPart: number) => visible(bodyPart, part) }),
          };
          const made = skinnedDecalPart(
            target,
            placed.box,
            placed.rect,
            material,
            alpha,
            look.color,
          );
          if (!made) continue;
          found = true;
          if (skinLeft <= 0) continue;
          skinLeft--;
          skinned++;
          parts.push(made);
        } else {
          const { world, node } = drawnPartWorld(instance, part);
          const decal = rigidDecalPart(
            { part, world },
            placed.box,
            placed.rect,
            material,
            alpha,
            look.color,
            node >= 0 ? hung.length : undefined,
          );
          if (!decal) continue;
          found = true;
          if (rigidLeft <= 0) continue;
          // Not too near a plain decal already on its node (its skeleton node, else its shape).
          const key = node >= 0 ? node : part;
          const near = [...spots, ...made].filter((spot) => spot.node === key);
          if (decalTooNear(placed.point, size, near)) continue;
          rigidLeft--;
          rigid++;
          if (node >= 0) hung.push(node);
          made.push({ node: key, point: placed.point, width: size.width });
          parts.push(decal);
        }
        first ??= instance;
      }
    }
    if (!found) return 'none';
    if (parts.length === 0 || !first) return 'refused';
    this.#skinMadeThisFrame += skinned;
    this.#rigidMadeThisFrame += rigid;
    const model: ModelData = {
      parts,
      center: parts[0]?.center ?? [0, 0, 0],
      radius: Math.max(...parts.map((part) => part.radius)),
      skipped: [],
      editorMarker: false,
      particles: [],
      addons: [],
    };
    const gpu = await this.#renderer.scene.createModel(model, this.#session.textures);
    // Drawn as the body is: its placement, motion, visibility and pose.
    const scene = this.#renderer.scene.createScene([
      {
        model: gpu,
        world: first.world,
        ...(first.motion && { motion: first.motion }),
        ...(first.visibility && { visibility: first.visibility }),
        ...(first.pose && { pose: first.pose }),
        ...(hung.length > 0 && { poseNodes: Int16Array.from(hung) }),
        ...(first.partitionVisible && { partitionVisible: first.partitionVisible }),
      },
    ]);
    if (!scene) {
      gpu.destroy();
      return 'made';
    }
    const lifetime = ini.number('Display', 'fDecalLifetime');
    this.#skin.push({
      actor,
      model: gpu,
      scene,
      until: decalGoneAt(this.#now(), lifetime),
      skinned,
      rigid,
      spots: made,
    });
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
    for (const gone of expireDecals(this.#decals, this.#now(), max)) destroyDecal(gone);
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
    const sound = blowSound(impact, hit.heavy, hit.onPlayer === true);
    if (sound !== undefined) void sounds.play(sound, hit.position);
    if (hit.placeable && !hit.placeable(impact)) return impact;
    // Its effect model (the blood's spray, the sparks off metal) where the blow landed.
    if (impact.model && this.#showModel) {
      this.#showModel(impact.model, hit.position, impactFacing(impact.orientation, hit.direction));
    }
    if (physics) await this.#splatter(impact, hit, physics);
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

  /**
   * The impact's decal on the world: an actor hit's blood on what lies behind it (the
   * environment blood, ENVIRONMENT_BLOOD: by its chance, along the blow lowered by half, 512
   * units, spaced by its impact's Placement Radius), or a hit on the world where it struck
   * (spaced by the impacts' 16). Observed in the original: the environment blood's impact is
   * not the hit's but its struck limb's (HitImpact.environmentBlood: the sever impact data set
   * of that part of the target race's body part data, against the race's material), square
   * (its width also its height) and 48 deep; none where the limb names none. The decal is made
   * on the node that holds the struck collision (struckNodeKey), skipped where one on that node
   * is too near (decalTooNear), past iMaxDecalsPerFrame plain decals this frame, or beyond
   * fDecalLOD0; a forced one (PlayImpactEffect's) is made regardless. It is built from the
   * struck shapes' triangles (#onSurfaces); without the viewer's shapes, projected.
   */
  async #splatter(hitImpact: Impact, hit: HitImpact, physics: PhysicsWorld): Promise<void> {
    if (!physics.queriesCurrent) return;
    const blood = hit.materialForm !== undefined;
    const impact = blood ? await this.#environmentImpact(hit) : hitImpact;
    const data = impact && (await this.#decal(impact.formId));
    if (!impact || !data) return;
    if (blood) {
      const settings = await this.#session.settings();
      const chance = settings.number('fCombatEnvironmentBloodChance') ?? ENVIRONMENT_BLOOD.chance;
      if (Math.random() >= chance) return;
    }
    const way = blood
      ? environmentBloodWay(hit.direction)
      : normalize([hit.direction[0], hit.direction[1], hit.direction[2] - 1]);
    const reach = blood ? ENVIRONMENT_BLOOD.reach : SPLATTER_REACH;
    const surface = physics.raycast(hit.position, way, reach, Layer.static);
    if (!surface) return;
    const forced = hit.forced === true;
    const ini = this.#session.ini;
    if (!forced) {
      if (!this.#withinDecalReach(surface.point)) return;
      if (this.#rigidMadeThisFrame >= ini.number('Display', 'iMaxDecalsPerFrame')) return;
    }
    const decal = blood ? squareDecal(data.decal) : data.decal;
    const placed = placeDecal(decal, this.#seed++, decalFrame(surface.point, surface.normal));
    const size = placedSize(placed);
    const struck = physics.nodeOf(surface.collider);
    const node = struckNodeKey(surface.owner, struck, surface.point);
    if (!forced) {
      const spacing = blood ? impact.placementRadius : DECAL_SPACING;
      const near = this.#decals.flatMap((d) => (d.spot?.node === node ? [d.spot] : []));
      if (decalTooNear(surface.point, size, near, spacing)) return;
    }
    const lifetime = ini.number('Display', 'fDecalLifetime');
    const spot = { node, point: surface.point, width: size.width };
    const faceLimit = worldDecalFaceLimit(impact.angleThreshold);
    const store = { textureSet: data.base, impact: impact.formId, rect: placed.rect, faceLimit };
    const surfaces = this.#surfaces?.();
    if (surfaces) {
      await this.#onSurfaces(surfaces, data, faceLimit, {
        box: worldDecalBox(placed.box, blood ? ENVIRONMENT_BLOOD.depth : decal.depth),
        rect: placed.rect,
        outward: normalize(surface.normal),
        owner: surface.owner,
        node: struck?.toLowerCase(),
        point: surface.point,
        forced,
        until: decalGoneAt(this.#now(), lifetime),
        spot,
        store,
      });
      return;
    }
    this.#rigidMadeThisFrame++;
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
    this.#decals.push({
      gpu,
      until: decalGoneAt(this.#now(), lifetime),
      spot,
      stored: { ...store, on: { world: true }, box: Array.from(placed.box) },
    });
    this.#expire();
  }

  /**
   * The environment blood's impact (observed in the original): the hit's struck limb's impact
   * data set (HitImpact.environmentBlood) against the target's material; none without one.
   */
  async #environmentImpact(hit: HitImpact): Promise<Impact | undefined> {
    const set = hit.environmentBlood;
    const records = this.#session.soundSystem?.impactRecords;
    if (set === undefined || hit.materialForm === undefined || !records) return undefined;
    const dataSet = await records.impactDataSet(set);
    if (!dataSet) return undefined;
    return impactAgainst(records, dataSet, await records.material(hit.materialForm));
  }

  /**
   * A decal on the world built as the original builds it (observed in the original): the
   * shapes of the struck reference under the node that holds the struck collision (its whole
   * 3D without a node), leaving out hidden ones, shapes that are decals themselves and, without
   * [Decals] bAllowDecalsOnAlpha, alpha-blended or alpha-tested ones, each take a decal shape of
   * their own from their triangles in the box (world-decal.ts), drawn where they are; the land
   * of the cell takes one from its grid. Each shape's decal counts against [Display]
   * iMaxDecalsPerFrame (a forced one's does not stop at it); none made where nothing takes it.
   */
  async #onSurfaces(
    surfaces: DecalSurfaces,
    data: ImpactDecal,
    faceLimit: number,
    at: {
      readonly box: Mat4;
      readonly rect: readonly [number, number, number, number];
      readonly outward: Vec3;
      readonly owner: { readonly reference: number; readonly kind: string } | undefined;
      readonly node: string | undefined;
      readonly point: Vec3;
      readonly forced: boolean;
      readonly until: number;
      readonly spot: DecalSpot & { readonly node: string };
      /** What the store keeps of it beside what it lies on and its box there. */
      readonly store: Omit<StoredDecal, 'on' | 'box'>;
    },
  ): Promise<void> {
    const ini = this.#session.ini;
    const textureSet = data.textureSet;
    const { material, alpha } = skinnedDecalMaterial({
      textures: textureSet.textures,
      flags: data.decal.flags,
      shininess: data.decal.shininess,
      color: data.decal.color,
      noSpecular: (textureSet.flags & TextureSetFlag.noSpecularMap) !== 0,
      modelSpaceNormals: (textureSet.flags & TextureSetFlag.modelSpaceNormals) !== 0,
    });
    const look: WorldDecalLook = { material, alpha, color: data.decal.color, rect: at.rect };
    const perFrame = ini.number('Display', 'iMaxDecalsPerFrame');
    const room = (): boolean => at.forced || this.#rigidMadeThisFrame < perFrame;
    /** Each drawn instance's decal shapes (its pose nodes for those hung on one). */
    const made: { instance: ModelInstance | undefined; parts: ModelPart[]; hung: number[] }[] = [];
    if (at.owner?.kind === 'landscape') {
      const land = surfaces.land(at.point[0], at.point[1]);
      const part =
        land && room() ? landDecalPart(land, at.box, at.outward, faceLimit, look) : undefined;
      if (part) {
        this.#rigidMadeThisFrame++;
        made.push({ instance: undefined, parts: [part], hung: [] });
      }
    } else if (at.owner) {
      const onAlpha = ini.bool('Decals', 'bAllowDecalsOnAlpha');
      for (const instance of surfaces.instances(at.owner.reference) ?? []) {
        if (instance.visibility?.hidden) continue;
        const entry = { instance, parts: [] as ModelPart[], hung: [] as number[] };
        for (const { part } of instance.model.parts) {
          if (part.weaponBlood || part.skin) continue;
          if (instance.partShown && !instance.partShown(part)) continue;
          if (at.node !== undefined && part.ancestors && !part.ancestors.includes(at.node)) {
            continue;
          }
          if (((part.material?.flags1 ?? 0) & SLSF1_DECAL) !== 0) continue;
          if (!onAlpha && ((part.alpha?.flags ?? 0) & 0x201) !== 0) continue;
          if (!room()) break;
          const { world, node } = drawnPartWorld(instance, part);
          const decal = worldDecalPart(
            part,
            world,
            at.box,
            at.outward,
            faceLimit,
            look,
            node >= 0 ? entry.hung.length : undefined,
          );
          if (!decal) continue;
          this.#rigidMadeThisFrame++;
          if (node >= 0) entry.hung.push(node);
          entry.parts.push(decal);
        }
        if (entry.parts.length > 0) made.push(entry);
      }
    }
    // The store keeps it once, its box in the space of what it lies on (the land's: the world).
    const owner = made[0]?.instance;
    const inOwner = owner && invert(owner.world);
    let stored: StoredDecal | undefined =
      at.owner?.kind === 'landscape'
        ? { ...at.store, on: { land: true }, box: Array.from(at.box) }
        : at.owner && inOwner
          ? {
              ...at.store,
              on: {
                reference: at.owner.reference,
                ...(at.node !== undefined && { node: at.node }),
              },
              box: Array.from(multiply(inOwner, at.box)),
            }
          : undefined;
    for (const { instance, parts, hung } of made) {
      const model = await this.#renderer.scene.createModel(
        {
          parts,
          center: parts[0]?.center ?? at.point,
          radius: Math.max(...parts.map((part) => part.radius)),
          skipped: [],
          editorMarker: false,
          particles: [],
          addons: [],
        },
        this.#session.textures,
      );
      // Drawn as the shapes it lies on are: their placement, motion, visibility and pose.
      const scene = this.#renderer.scene.createScene([
        instance
          ? {
              model,
              world: instance.world,
              ...(instance.motion && { motion: instance.motion }),
              ...(instance.visibility && { visibility: instance.visibility }),
              ...(instance.pose && { pose: instance.pose }),
              ...(hung.length > 0 && { poseNodes: Int16Array.from(hung) }),
            }
          : { model, world: identity() },
      ]);
      if (!scene) {
        model.destroy();
        continue;
      }
      this.#decals.push({
        shapes: { model, scene },
        until: at.until,
        spot: at.spot,
        ...(stored && { stored }),
      });
      stored = undefined;
    }
    this.#expire();
  }

  /** A saved decal's data: its impact's (own decal data over its set's), else its set's. */
  async #savedDecalData(saved: SavedDecal): Promise<ImpactDecal | undefined> {
    if (saved.impact !== undefined) {
      const data = await this.#decal(saved.impact);
      if (data) return data;
    }
    const db = await this.#session.db;
    const record = await db.get(saved.textureSet);
    if (record?.type !== 'TXST') return undefined;
    const textureSet = parseTextureSet(record);
    const decal = textureSet.decal;
    return decal && { decal, textureSet, base: saved.textureSet };
  }

  /**
   * The world decals as a save keeps them (docs/formats/save.md): each with its time left, and
   * those of a loaded save still waiting for what they lie on.
   */
  save(): SavedDecal[] {
    this.#takeRestored();
    const now = this.#now();
    const out: SavedDecal[] = [];
    for (const { saved, until } of this.#restored) {
      if (until > now) out.push({ ...saved, left: until - now });
    }
    for (const { stored, until } of this.#decals) {
      if (stored && until > now) out.push({ ...stored, left: until - now });
    }
    return out;
  }

  /** A loaded save's world decals, waiting to be built as what they lie on is drawn. */
  #restored: RestoredDecal[] = [];

  #takeRestored(): void {
    const saved = this.#session.restoring?.takeDecals() ?? [];
    if (saved.length === 0) return;
    const now = this.#now();
    const whole = decalGoneAt(now, this.#session.ini.number('Display', 'fDecalLifetime'));
    for (const decal of saved) {
      this.#restored.push({
        saved: decal,
        until: decal.left === undefined ? whole : now + decal.left,
      });
    }
  }

  /**
   * Each frame: the saved decals whose surfaces are drawn now are built on them (a reference's
   * shapes, the land of a cell; one known by no surface projected), as a hit made them, forced
   * (no spacing, no per-frame cap); those whose time ran out go.
   */
  #buildRestored(): void {
    // Taken by the impacts of a view showing the world (its shapes and land given).
    const surfaces = this.#surfaces?.();
    if (!surfaces) return;
    this.#takeRestored();
    if (this.#restored.length === 0) return;
    const now = this.#now();
    this.#restored = this.#restored.filter((entry) => entry.until > now);
    for (const entry of this.#restored) {
      if (entry.building) continue;
      const on = entry.saved.on;
      const ready =
        'world' in on ||
        ('reference' in on && (surfaces.instances(on.reference)?.length ?? 0) > 0) ||
        'land' in on ||
        'cell' in on;
      if (!ready) continue;
      entry.building = true;
      void this.#buildSaved(entry, surfaces).then(
        (done) => {
          entry.building = false;
          if (done) this.#restored = this.#restored.filter((other) => other !== entry);
        },
        () => {
          this.#restored = this.#restored.filter((other) => other !== entry);
        },
      );
    }
  }

  /** Builds a saved decal; whether it is done with (built, or never to be). */
  async #buildSaved(entry: RestoredDecal, surfaces: DecalSurfaces): Promise<boolean> {
    const { saved, until } = entry;
    const data = await this.#savedDecalData(saved);
    if (!data || saved.box.length !== 16) return true;
    const rect: readonly [number, number, number, number] =
      (data.decal.flags & DecalFlag.noSubtextures) !== 0 ? [0, 0, 1, 1] : saved.rect;
    const on = saved.on;
    let box: Mat4 = Float32Array.from(saved.box);
    const point = (): Vec3 => [box[12] ?? 0, box[13] ?? 0, box[14] ?? 0];
    if ('world' in on) {
      const gpu = await this.#renderer.decals.createDecals(
        [{ reference: 0, base: data.base, textureSet: data.textureSet, box, rect }],
        this.#session.textures,
      );
      if (!gpu) return true;
      gpu.select(() => true);
      const width = Math.hypot(box[0] ?? 0, box[1] ?? 0, box[2] ?? 0);
      const spot = { node: 'none', point: point(), width };
      this.#decals.push({ gpu, until, spot, stored: { ...saved, box: Array.from(box) } });
      this.#expire();
      return true;
    }
    let owner: { readonly reference: number; readonly kind: string };
    let node: string | undefined;
    if ('reference' in on) {
      const instance = surfaces.instances(on.reference)?.[0];
      if (!instance) return false;
      box = multiply(instance.world, box);
      owner = { reference: on.reference, kind: 'object' };
      node = on.node;
    } else {
      if ('cell' in on) {
        const grid = await this.#cellGrid(on.cell);
        const center = grid && [(grid[0] + 0.5) * 4096, (grid[1] + 0.5) * 4096];
        const land = center && surfaces.land(center[0] ?? 0, center[1] ?? 0);
        if (!grid) return true;
        if (!land) return false;
        const origin = landSpaceOrigin(land.heights, grid[0], grid[1]);
        const toWorld = identity();
        toWorld.set(origin, 12);
        box = multiply(toWorld, box);
      } else if (!surfaces.land(box[12] ?? 0, box[13] ?? 0)) {
        return false;
      }
      owner = { reference: 0, kind: 'landscape' };
    }
    const at = point();
    const outward = normalize([-(box[4] ?? 0), -(box[5] ?? 0), -(box[6] ?? 1)]);
    const width = Math.hypot(box[0] ?? 0, box[1] ?? 0, box[2] ?? 0);
    await this.#onSurfaces(surfaces, data, saved.faceLimit, {
      box,
      rect,
      outward,
      owner,
      node,
      point: at,
      forced: true,
      until,
      spot: { node: struckNodeKey(owner, node, at), point: at, width },
      store: {
        textureSet: saved.textureSet,
        ...(saved.impact !== undefined && { impact: saved.impact }),
        rect: saved.rect,
        faceLimit: saved.faceLimit,
      },
    });
    return true;
  }

  readonly #cellGrids = new Map<number, Promise<readonly [number, number] | undefined>>();

  /** An exterior cell's grid (XCLC), read once. */
  #cellGrid(cell: number): Promise<readonly [number, number] | undefined> {
    let grid = this.#cellGrids.get(cell);
    if (!grid) {
      grid = this.#session.db
        .then((db) => db.get(cell))
        .then((record) => {
          const xclc = record?.type === 'CELL' ? record.fields.first('XCLC') : undefined;
          if (!xclc || xclc.length < 8) return undefined;
          const view = new DataView(xclc.buffer, xclc.byteOffset, xclc.byteLength);
          return [view.getInt32(0, true), view.getInt32(4, true)] as const;
        })
        .catch(() => undefined);
      this.#cellGrids.set(cell, grid);
    }
    return grid;
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
    this.#restored = [];
    for (const decal of this.#decals.splice(0)) destroyDecal(decal);
    for (const decal of this.#skin.splice(0)) {
      decal.scene.destroy();
      decal.model.destroy();
    }
  }
}

/**
 * Where a rigid shape of a drawn instance is now (its space → world): on its skeleton node
 * (`node`: that pose node) when the instance is posed, else as its model places it (-1).
 */
function drawnPartWorld(
  instance: ModelInstance,
  part: ModelPart,
): { readonly world: Mat4; readonly node: number } {
  const pose = instance.pose;
  const node = pose && part.node !== undefined ? (instance.poseNodes?.[part.node] ?? -1) : -1;
  if (pose && node >= 0) {
    return {
      world: multiply(
        multiply(instance.world, pose.worlds.subarray(node * 16, node * 16 + 16)),
        part.local ?? identity(),
      ),
      node,
    };
  }
  return { world: multiply(instance.world, part.world), node: -1 };
}

/** Frees a hit's decal from the GPU. */
function destroyDecal(decal: LivingDecal): void {
  decal.gpu?.destroy();
  if (decal.shapes) {
    decal.shapes.scene.destroy();
    decal.shapes.model.destroy();
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
