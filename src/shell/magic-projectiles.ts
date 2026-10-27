// What spells, staffs, scrolls and shouts send flying (docs/ai.md, "Magic in combat"; the
// rules: src/gameplay/magic/projectile-flight.ts): a cast's projectile (its costliest effect's
// MGEF projectile, PROJ) leaves the caster's hand (the voice: its head) along the aim. Missiles,
// lobbers and arrow-like bolts fly through the physics steps, drawn as their model, sounding
// their flight sound, until they meet a surface (the physics world, the spell layer), an actor
// (its ragdoll bodies' owner, or its capsule) or their range; beams reach at once; flames are a
// concentration spell's sprays; cones sweep every actor within their spread at once. Where one
// ends: the actor hit takes the spell (the casting engine's deliver: wards, absorption, OnHit,
// skill), a Target Location spell takes effect there (summons, runes), the explosion bursts (its
// sound, the casting engine's explode), the area reaches those near (area), the effect's impact
// data set sounds on the surface hit, and the impact's sound level is a noise for detection.
// What shows (src/shell/magic-fx.ts): a projectile carries its light (PROJ light); with the
// Muzzle Flash flag its muzzle flash model and light show where it leaves for its muzzle flash
// duration; a cone's wave sweeps out at its speed to its range, a beam's model reaches from the
// hand to what it met (src/shell/magic-beams.ts: its procedural lightning stretched); an
// explosion shows its model and light, puts its image-space modifier on the player within its
// image-space radius (aimed at it), leaves its placed object (a hazard: the hazard engine) and
// sends its spawned projectile on to the nearest other actor (chain lightning); an impact
// (the effect's and the explosion's impact data set) leaves its decal, model and hazard. A
// chained hop is weaker by fMagicChainExplosionEffectivenessDelta for each actor the chain
// reached (observed in the original). TODO(M13): the hop count of chained explosions (one
// hop each here; the engine's limit is not read).

import {
  flightKind,
  inCone,
  launchFlight,
  normalize,
  pathHitsActor,
  pointAt,
  stepFlight,
  withinProximity,
  type ActorShape,
  type Flight,
} from '../gameplay/magic/projectile-flight.ts';
import { chainEffectiveness } from '../gameplay/magic/explosions.ts';
import { ImpactPlacements } from '../gameplay/magic/impact-placement.ts';
import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld, RayHit } from '../physics/physics-world.ts';
import { conePush, loadImpulseSettings, projectileKnock } from '../gameplay/impulses.ts';
import type { Vec3 } from '../render/math.ts';
import type { RenderPort } from '../render/render-port.ts';
import type { GpuScene, InstanceMotion, ModelInstance } from '../render/scene-renderer.ts';
import type { Delivered } from '../scripting/runtime/casting-engine.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { SoundInstance } from '../audio/sound-instance.ts';
import { meshPath } from '../world/actors.ts';
import { EffectArchetype, type MagicEffectRecord } from '../world/magic-effects.ts';
import { Delivery } from '../world/magic-records.ts';
import {
  ExplosionFlag,
  ProjectileFlag,
  type ExplosionRecord,
  type ProjectileRecord,
} from '../world/projectile-data.ts';
import type { CellLight } from '../world/cell-loader.ts';
import type { LightRecord } from '../world/cell-records.ts';
import type { Impact } from '../world/impact-records.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { HitImpact } from './combat-impacts.ts';
import { MagicBeams } from './magic-beams.ts';
import { MagicFlames, type FlameStream } from './magic-flames.ts';
import { startObjectGraph } from './object-graphs.ts';
import { alongMatrix, cellLight, type MagicFx } from './magic-fx.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** Something projectiles can meet: an actor and its shape now. */
export interface ProjectileTarget {
  readonly reference: number;
  readonly shape: ActorShape;
  /** Which way it faces (radians about z: a ward meets what comes from the front). */
  readonly heading: number;
}

export interface MagicProjectilesOptions {
  readonly session: GameSession;
  readonly renderer: RenderPort;
  readonly terminal: Terminal;
  /** The living actors of the loaded area (the player too). */
  readonly targets: () => Iterable<ProjectileTarget>;
  /** A sound at a place is a noise the actors may hear (src/shell/actor-senses.ts). */
  readonly noise?: (at: Vec3, owner: number | undefined, soundLevel: number) => void;
  /** A hostile spell took hold on an actor (who was attacked, by whom). */
  readonly hit?: (target: number, caster: number) => void;
  /** What shows for a moment (muzzle flashes, explosions, impacts, cones' waves). */
  readonly fx?: MagicFx;
  /** An impact on a surface: its sound and decal; the impact (IPCT) it was. */
  readonly impact?: (hit: HitImpact) => Promise<Impact | undefined>;
}

/** One projectile on its way. */
interface Flying {
  readonly delivered: Delivered;
  readonly projectile: ProjectileRecord;
  readonly effect: MagicEffectRecord | undefined;
  readonly flight: Flight;
  /** A concentration spray: the seconds of the spell it carries. */
  readonly seconds: number | undefined;
  /** Drawn: its instance (moved each frame) and scene. */
  instance: ModelInstance | undefined;
  scene: GpuScene | undefined;
  readonly motion: InstanceMotion;
  sound: Promise<SoundInstance | undefined> | undefined;
  /** Its light (PROJ light), once read. */
  light: LightRecord | undefined;
  /** A flame's spray: the stream that shows it, and where it left (its reach is measured). */
  readonly stream: FlameStream | undefined;
  readonly origin: Vec3;
  done: boolean;
}

/** How far a ray steps past a caster's own bodies it starts inside (units, tries). */
const SELF_STEP = 4;
const SELF_TRIES = 8;

/** A projectile is at least this wide to those who see it coming (units). */
const THREAT_RADIUS = 8;

/** A human's capsule where a mover has none (units; TODO(M13): the race's bounds). */
const DEFAULT_HEIGHT = 128;
const DEFAULT_RADIUS = 24;

/** Physics layers that are actors (their hits are the actor's, not a surface's). */
const ACTOR_LAYERS: ReadonlySet<number> = new Set([
  Layer.biped,
  Layer.bipedNoCc,
  Layer.charController,
  Layer.deadBip,
]);

/** Archetypes a Target Location spell places where it lands. */
const PLACING: ReadonlySet<number> = new Set([
  EffectArchetype.summonCreature,
  EffectArchetype.spawnHazard,
  EffectArchetype.spawnScriptedRef,
]);

/** The capsule of an actor of a given height and scale (projectile-flight's ActorShape). */
export function actorShape(feet: Vec3, height: number | undefined, scale = 1): ActorShape {
  return {
    feet,
    height: height ?? DEFAULT_HEIGHT * scale,
    radius: DEFAULT_RADIUS * scale,
  };
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class MagicProjectiles {
  readonly #options: MagicProjectilesOptions;
  readonly #flying = new Set<Flying>();
  readonly #beams: MagicBeams;
  readonly #flames: MagicFlames;
  #physics: PhysicsWorld | undefined;
  /** Seconds the projectiles have run (the impacts' clock). */
  #clock = 0;
  /** Impacts placed and still showing (their placement radius keeps others off). */
  readonly #placements = new ImpactPlacements();
  /** The gameplay impulses' settings (src/gameplay/impulses.ts), once read. */
  readonly #impulses: ReturnType<typeof loadImpulseSettings>;

  constructor(options: MagicProjectilesOptions) {
    this.#options = options;
    this.#impulses = loadImpulseSettings(() => options.session.settings());
    this.#beams = new MagicBeams({
      session: options.session,
      renderer: options.renderer,
      terminal: options.terminal,
      ...(options.fx && { fx: options.fx }),
    });
    this.#flames = new MagicFlames({
      session: options.session,
      renderer: options.renderer,
      terminal: options.terminal,
      ...(options.fx && { fx: options.fx }),
    });
  }

  /** The physics world they fly in (undefined: the play ended; they are gone). */
  attach(physics: PhysicsWorld | undefined): void {
    this.#physics = physics;
    if (!physics) this.clear();
  }

  /**
   * What flies now, as the actors see it coming (the combat AI's threats: what they sidestep):
   * where each is, its way, how wide (its collision radius, at least a hand's), whose.
   */
  *threats(): Iterable<{
    readonly key: object;
    readonly position: Vec3;
    readonly velocity: Vec3;
    readonly radius: number;
    readonly source: number | undefined;
  }> {
    for (const flying of this.#flying) {
      if (flying.done) continue;
      yield {
        key: flying,
        position: flying.flight.position,
        velocity: flying.flight.velocity,
        radius: Math.max(THREAT_RADIUS, flying.projectile.collisionRadius),
        source: flying.delivered.caster,
      };
    }
  }

  /** What flies now (the QA monitors): each projectile's editor id, where it is, whose. */
  *flying(): Iterable<{ readonly projectile: string; readonly at: Vec3; readonly caster: number }> {
    for (const flying of this.#flying) {
      // A flame's sprays show as their stream (flames()).
      if (flying.done || flying.stream) continue;
      yield {
        projectile: flying.projectile.editorId,
        at: flying.flight.position,
        caster: flying.delivered.caster,
      };
    }
  }

  /** The flame streams showing (the QA monitors): each one's projectile and place. */
  flames(): Iterable<{ readonly projectile: string; readonly at: Vec3 }> {
    return this.#flames.shown();
  }

  /** Their drawn scenes. */
  *scenes(): Iterable<GpuScene> {
    for (const flying of this.#flying) if (flying.scene) yield flying.scene;
    yield* this.#beams.scenes();
    yield* this.#flames.scenes();
  }

  /**
   * A cast leaves `origin` along `direction` (a fire and forget spell released, a concentration
   * spell's spray with the `seconds` it carries, a shout, a script's cast). `target`: the actor
   * aimed at (a Target Actor spell reaches it; a Touch spell or one without a projectile
   * reaches it at once). `follow`: where the casting hand is now (a beam stays on it).
   * Resolves once it is on its way.
   */
  async launch(
    delivered: Delivered,
    origin: Vec3,
    direction: Vec3,
    options: {
      readonly target?: number | undefined;
      readonly seconds?: number;
      readonly follow?: () => Vec3 | undefined;
    } = {},
  ): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const casting = runtime.casting;
    const effect = await casting.mainEffect(delivered.item);
    let projectile =
      effect?.projectile === undefined ? undefined : await casting.projectile(effect.projectile);
    // A Target Location spell reaches as far as its caster's perks let it (Mod Spell Range
    // (Target Loc.): Rune Master, five times).
    if (projectile && delivered.item.delivery === Delivery.targetLocation) {
      const range = await runtime.perks.apply(
        EntryPoint.modSpellRangeTargetLoc,
        delivered.caster,
        projectile.range,
        [delivered.item.formId],
        { spell: delivered.item.formId },
      );
      if (range !== projectile.range) projectile = { ...projectile, range };
    }
    const seconds = options.seconds;
    const at = (reference: number): Promise<number> =>
      this.#reach(runtime, delivered, reference, {
        ...(seconds !== undefined && { seconds }),
      });
    const delivery = delivered.item.delivery;
    // A Self spell is its caster's; a Touch spell (or one without a projectile) reaches the
    // actor aimed at.
    if (delivery === Delivery.self) {
      await at(delivered.caster);
      return;
    }
    if (!projectile || delivery === Delivery.touch) {
      if (options.target !== undefined) await at(options.target);
      else if (delivery === Delivery.targetLocation)
        await casting.deliver(delivered, delivered.caster);
      return;
    }
    const aim = normalize(direction);
    // Its muzzle flash where it leaves (its model and light, for its duration).
    const fx = this.#options.fx;
    if (fx && (projectile.flags & ProjectileFlag.muzzleFlash) !== 0)
      fx.show(projectile.muzzleFlashModel, projectile.muzzleFlashLight, origin, {
        kind: 'muzzle-flash',
        owner: delivered.caster,
        direction: aim,
        duration: projectile.muzzleFlashDuration > 0 ? projectile.muzzleFlashDuration : 0.1,
        fades: true,
      });
    switch (flightKind(projectile)) {
      case 'cone':
        await this.#cone(runtime, delivered, projectile, origin, aim, seconds);
        return;
      case 'instant':
        await this.#instant(runtime, delivered, projectile, effect, origin, aim, seconds, {
          ...(options.follow && { follow: options.follow }),
        });
        return;
      default:
        this.#fly(delivered, projectile, effect, origin, aim, seconds, options.follow);
    }
  }

  /** The spell reaches an actor; a hostile one that took hold is a hit (who attacked whom). */
  async #reach(
    runtime: ScriptRuntime,
    delivered: Delivered,
    target: number,
    options: { readonly facing?: boolean; readonly seconds?: number },
  ): Promise<number> {
    // A chain explosion's hop is weaker by each actor the chain reached before (explosions.ts
    // chainEffectiveness: the first one hit, then each hop).
    const hops = delivered.chained ?? 0;
    const effectiveness =
      hops > 0 ? chainEffectiveness(hops, await runtime.casting.explosionSettings()) : undefined;
    const applied = await runtime.casting.deliver(delivered, target, {
      ...options,
      ...(effectiveness !== undefined && { effectiveness }),
    });
    if (applied > 0 && target !== delivered.caster && (await runtime.magic.hostile(delivered.item)))
      this.#options.hit?.(target, delivered.caster);
    return applied;
  }

  /**
   * A missile, lobber, bolt or spray takes flight (drawn as its model, with its light and
   * sound). A flame's spray flies unseen: its caster's stream shows it (magic-flames.ts), kept
   * at the hand or mouth (`follow`).
   */
  #fly(
    delivered: Delivered,
    projectile: ProjectileRecord,
    effect: MagicEffectRecord | undefined,
    origin: Vec3,
    aim: Vec3,
    seconds: number | undefined,
    follow?: () => Vec3 | undefined,
  ): void {
    const { session, renderer, terminal } = this.#options;
    const stream =
      flightKind(projectile) === 'spray'
        ? this.#flames.spray(delivered.caster, projectile, origin, aim, follow)
        : undefined;
    const flying: Flying = {
      delivered,
      projectile,
      effect,
      flight: launchFlight(projectile, origin, aim),
      seconds,
      instance: undefined,
      scene: undefined,
      motion: { version: 0 },
      sound: undefined,
      light: undefined,
      stream,
      origin: [...origin],
      done: false,
    };
    this.#flying.add(flying);
    if (projectile.sound !== undefined) {
      flying.sound = session.playSound(projectile.sound, () => flying.flight.position);
    }
    if (stream) return;
    void this.#options.fx?.lightRecord(projectile.light).then((light) => {
      flying.light = light;
    });
    const path = projectile.model;
    if (!path) return;
    session
      .model(meshPath(path))
      .then((model) => {
        if (!model || flying.done) return;
        const graph = startObjectGraph(model, flying.delivered.caster);
        const instance: ModelInstance = {
          model,
          world: placementOf(flying.flight),
          motion: flying.motion,
          ...(graph && { graph }),
        };
        flying.instance = instance;
        flying.scene = renderer.scene.createScene([instance]);
      })
      .catch((error: unknown) => {
        terminal.log('magic', `${projectile.editorId}: ${describe(error)}`, 'warn');
      });
  }

  /** A beam (or hitscan): the first surface or actor along its range, at once. */
  async #instant(
    runtime: ScriptRuntime,
    delivered: Delivered,
    projectile: ProjectileRecord,
    effect: MagicEffectRecord | undefined,
    origin: Vec3,
    aim: Vec3,
    seconds: number | undefined,
    options: { readonly follow?: () => Vec3 | undefined } = {},
  ): Promise<void> {
    const range = projectile.range > 0 ? projectile.range : 10000;
    const end: Vec3 = pointAt(
      origin,
      [origin[0] + aim[0], origin[1] + aim[1], origin[2] + aim[2]],
      range,
    );
    const hit = this.#sweep(delivered.caster, origin, end, projectile.collisionRadius);
    const point = hit ? pointAt(origin, end, hit.t) : end;
    this.#knock(projectile, hit?.ray, aim);
    // The beam from the hand to what it met (its model stretched to it, and its light).
    this.#beams.show(projectile, origin, aim, range * (hit ? hit.t : 1), options.follow);
    await this.#impact(runtime, delivered, projectile, effect, point, aim, hit, seconds);
  }

  /**
   * A cone (Unrelenting Force, Fire Breath): every actor within its range and spread that it
   * can see from its apex takes the spell at once, and so does every object whose collision it
   * meets there (L_CONEPROJECTILE: a web burnt, a destructible broken, an object's OnHit).
   */
  async #cone(
    runtime: ScriptRuntime,
    delivered: Delivered,
    projectile: ProjectileRecord,
    origin: Vec3,
    aim: Vec3,
    seconds: number | undefined,
  ): Promise<void> {
    const range = projectile.range > 0 ? projectile.range : 1000;
    for (const target of [...this.#options.targets()]) {
      if (target.reference === delivered.caster) continue;
      if (!inCone(origin, aim, range, projectile.coneSpread, target.shape)) continue;
      const middle: Vec3 = [
        target.shape.feet[0],
        target.shape.feet[1],
        target.shape.feet[2] + target.shape.height / 2,
      ];
      if (this.#blocked(delivered.caster, origin, middle)) continue;
      await this.#reach(runtime, delivered, target.reference, {
        facing: facing(target, origin),
        ...(seconds !== undefined && { seconds }),
      });
    }
    const physics = this.#physics;
    const objects =
      physics?.objectsNear(origin, range, Layer.coneProjectile) ?? new Map<number, Vec3>();
    for (const [reference, middle] of objects) {
      if (reference === delivered.caster) continue;
      if (
        !inCone(origin, aim, range, projectile.coneSpread, { feet: middle, height: 0, radius: 0 })
      )
        continue;
      // Seen from its apex: nothing else first on the way to the object's body.
      const way: Vec3 = [middle[0] - origin[0], middle[1] - origin[1], middle[2] - origin[2]];
      const first = physics?.raycast(origin, way, Math.hypot(...way), Layer.coneProjectile);
      if (
        first &&
        first.owner?.reference !== reference &&
        first.owner?.reference !== delivered.caster
      )
        continue;
      await runtime.casting.deliver(delivered, reference, {
        facing: false,
        projectile: projectile.formId,
        ...(seconds !== undefined && { seconds }),
      });
    }
    // Its force pushes the moving bodies it sweeps (clutter flies, corpses tumble).
    const force = projectile.impactForce;
    if (force > 0)
      physics?.pushCone(
        origin,
        aim,
        range,
        projectile.coneSpread,
        Layer.coneProjectile,
        (layer, mass, distance) =>
          conePush(force, distance, range, layer, mass, this.#impulses.current),
        delivered.caster,
      );
    // Its sound from its apex; its wave (its model and light) sweeps out to its range.
    if (projectile.sound !== undefined)
      void this.#options.session.playSound(projectile.sound, origin);
    const speed = projectile.speed > 0 ? projectile.speed : range;
    this.#options.fx?.show(projectile.model, projectile.light, origin, {
      kind: 'cone',
      direction: aim,
      speed,
      range,
      duration: range / speed + 0.25,
    });
  }

  /** A projectile's impact force pushes the moving body it met (src/gameplay/impulses.ts). */
  #knock(projectile: ProjectileRecord, ray: RayHit | undefined, aim: Vec3): void {
    if (!ray || !(projectile.impactForce > 0)) return;
    const force = projectile.impactForce;
    this.#physics?.knock(ray.collider, ray.point, aim, (layer, mass) =>
      projectileKnock(force, layer, mass, this.#impulses.current),
    );
  }

  /**
   * Whether an explosion seen from `from` reaches an actor (WorldBridge.explosionReaches; the
   * engine's sight of an explosion: src/gameplay/magic/explosions.ts): no surface between it
   * and the actor's middle, or the one met lies within `buffer` units of the actor. Undefined:
   * the actor or the physics is not here to ask.
   */
  reaches(from: Vec3, target: number, buffer: number): boolean | undefined {
    const physics = this.#physics;
    let shape: ActorShape | undefined;
    for (const entry of this.#options.targets())
      if (entry.reference === target) shape = entry.shape;
    if (!physics || !shape) return undefined;
    const middle: Vec3 = [shape.feet[0], shape.feet[1], shape.feet[2] + shape.height / 2];
    const way: Vec3 = [middle[0] - from[0], middle[1] - from[1], middle[2] - from[2]];
    const distance = Math.hypot(...way);
    if (distance < 1) return true;
    const hit = physics.raycast(from, way, distance, Layer.spell);
    if (!hit || ACTOR_LAYERS.has(hit.layer) || hit.owner?.kind === 'actor') return true;
    return distance - hit.distance <= buffer;
  }

  /** Whether a surface stands between two points (line of sight for cones and areas). */
  #blocked(caster: number, from: Vec3, to: Vec3): boolean {
    const physics = this.#physics;
    if (!physics) return false;
    const direction: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const distance = Math.hypot(...direction);
    const hit = physics.raycast(from, direction, distance, Layer.spell);
    return (
      hit !== undefined &&
      !ACTOR_LAYERS.has(hit.layer) &&
      hit.owner?.kind !== 'actor' &&
      hit.owner?.reference !== caster
    );
  }

  /**
   * What a path from `from` to `to` meets first: an actor (its capsule, or its bodies in the
   * physics world) or a surface; the caster's own bodies are passed through.
   */
  #sweep(
    caster: number,
    from: Vec3,
    to: Vec3,
    radius: number,
  ):
    | {
        readonly t: number;
        readonly actor?: ProjectileTarget;
        readonly material: number;
        readonly kind: 'object' | 'landscape' | 'actor' | undefined;
        readonly normal?: Vec3;
        /** The object hit (its reference), if a surface of one. */
        readonly reference?: number;
        /** The physics world's hit, when it was one (its body is pushed: #knock). */
        readonly ray?: RayHit;
      }
    | undefined {
    let best:
      | {
          t: number;
          actor?: ProjectileTarget;
          material: number;
          kind: 'object' | 'landscape' | 'actor' | undefined;
          normal?: Vec3;
          reference?: number;
          ray?: RayHit;
        }
      | undefined;
    const targets = new Map<number, ProjectileTarget>();
    for (const target of this.#options.targets()) {
      targets.set(target.reference, target);
      if (target.reference === caster) continue;
      const t = pathHitsActor(from, to, radius, target.shape);
      if (t !== undefined && (!best || t < best.t))
        best = { t, actor: target, material: 0, kind: 'actor' };
    }
    const physics = this.#physics;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    if (!physics || length <= 0) return best;
    const direction: Vec3 = [
      (to[0] - from[0]) / length,
      (to[1] - from[1]) / length,
      (to[2] - from[2]) / length,
    ];
    let start = 0;
    for (let tries = 0; tries < SELF_TRIES && start < length; tries++) {
      const origin = pointAt(from, to, start / length);
      const hit = physics.raycast(origin, direction, length - start, Layer.spell);
      if (!hit) break;
      const distance = start + hit.distance;
      const owner = hit.owner;
      // The caster's own bodies (an actor's arm, a trap's casting object) are passed through.
      if (owner !== undefined && owner.kind !== 'landscape' && owner.reference === caster) {
        start = distance + SELF_STEP;
        continue;
      }
      const t = distance / length;
      if (best && best.t <= t) break;
      const actor =
        owner?.kind === 'actor' || ACTOR_LAYERS.has(hit.layer)
          ? owner && targets.get(owner.reference)
          : undefined;
      if (actor) best = { t, actor, material: 0, kind: 'actor', ray: hit };
      else if (!ACTOR_LAYERS.has(hit.layer))
        best = {
          t,
          material: hit.material,
          kind: owner?.kind,
          normal: hit.normal,
          ...(owner?.kind === 'object' && owner.reference !== 0 && { reference: owner.reference }),
          ray: hit,
        };
      else if (hit.collider.parent()?.isDynamic() === true)
        // A corpse's ragdoll (no target): the spell ends on it, and pushes it.
        best = { t, material: hit.material, kind: 'actor', normal: hit.normal, ray: hit };
      break;
    }
    return best;
  }

  /** Every frame: the flying fly on; those that met something or ran out end there. */
  frame(seconds: number): void {
    if (seconds > 0) {
      this.#clock += seconds;
      this.#beams.frame(seconds);
      this.#flames.frame(seconds);
    }
    if (seconds <= 0 || this.#flying.size === 0) return;
    const runtime = this.#options.session.scriptsReady;
    for (const flying of [...this.#flying]) {
      if (flying.done) continue;
      const { from, to } = stepFlight(flying.flight, seconds);
      const hit = this.#sweep(flying.delivered.caster, from, to, flying.projectile.collisionRadius);
      // Its alternative trigger: within its proximity of an actor it bursts.
      const near =
        !hit &&
        (flying.projectile.flags & ProjectileFlag.altTrigger) !== 0 &&
        [...this.#options.targets()].some(
          (target) =>
            target.reference !== flying.delivered.caster &&
            withinProximity(flying.projectile, to, target.shape),
        );
      if (hit || near || flying.flight.spent) {
        const point = hit ? pointAt(from, to, hit.t) : to;
        flying.flight.position = point;
        this.#knock(flying.projectile, hit?.ray, normalize(flying.flight.velocity));
        this.#end(flying);
        // A flame reaches as far as its spray went (its full range when it met nothing).
        if (flying.stream) {
          const o = flying.origin;
          this.#flames.reached(
            flying.stream,
            hit || near
              ? Math.hypot(point[0] - o[0], point[1] - o[1], point[2] - o[2])
              : flying.projectile.range,
          );
        }
        if (runtime) {
          const aim = normalize(flying.flight.velocity);
          void this.#impact(
            runtime,
            flying.delivered,
            flying.projectile,
            flying.effect,
            point,
            aim,
            hit,
            flying.seconds,
          ).catch((error: unknown) => {
            this.#options.terminal.log('magic', `impact: ${describe(error)}`, 'warn');
          });
        }
        continue;
      }
      if (flying.instance) {
        flying.instance.world.set(placementOf(flying.flight));
        flying.motion.version++;
      }
    }
  }

  /**
   * Where a projectile ends: the actor hit takes the spell, a Target Location spell takes effect
   * there, its explosion bursts, its area reaches those near, its impact sounds on the surface.
   */
  async #impact(
    runtime: ScriptRuntime,
    delivered: Delivered,
    projectile: ProjectileRecord,
    effect: MagicEffectRecord | undefined,
    point: Vec3,
    aim: Vec3,
    hit:
      | {
          readonly actor?: ProjectileTarget;
          readonly material: number;
          readonly kind: 'object' | 'landscape' | 'actor' | undefined;
          readonly reference?: number;
          readonly normal?: Vec3;
        }
      | undefined,
    seconds: number | undefined,
  ): Promise<void> {
    const casting = runtime.casting;
    const { session, noise } = this.#options;
    const actor = hit?.actor;
    const reached = hit !== undefined || (projectile.flags & ProjectileFlag.explosion) !== 0;
    if (delivered.item.delivery === Delivery.targetLocation) {
      // A Target Location spell makes what it makes where it landed, on whatever it met or
      // where it ran out (a summon, a hazard: magic-engine's `at`); its other effects reach
      // those near by its explosion and area.
      const effects: number[] = [];
      for (const [index, entry] of delivered.item.effects.entries()) {
        const archetype = (await runtime.magic.effect(entry.effect))?.archetype;
        if (archetype !== undefined && PLACING.has(archetype)) effects.push(index);
      }
      if (effects.length > 0)
        await casting.deliver(delivered, delivered.caster, { at: point, effects });
    } else if (actor) {
      await this.#reach(runtime, delivered, actor.reference, {
        facing: facing(actor, [point[0] - aim[0], point[1] - aim[1], point[2] - aim[2]]),
        ...(seconds !== undefined && { seconds }),
      });
    } else if (hit?.reference !== undefined) {
      // An object hit takes the spell (its scripts hear of it; a destructible one's health
      // takes its Damage Health effects: the magic engine's, destruction-engine.ts).
      await casting.deliver(delivered, hit.reference, {
        facing: false,
        projectile: projectile.formId,
        ...(seconds !== undefined && { seconds }),
      });
    }
    // Its explosion (the projectile's, with the Explosion flag; else the effect's).
    const explosion =
      ((projectile.flags & ProjectileFlag.explosion) !== 0 ? projectile.explosion : undefined) ??
      effect?.explosion;
    if (explosion !== undefined && reached) {
      const record = await casting.explosion(explosion);
      if (record?.sound !== undefined) void session.playSound(record.sound, point);
      if (record?.sound2 !== undefined) void session.playSound(record.sound2, point);
      if (record)
        await this.#burst(
          runtime,
          delivered.caster,
          delivered,
          record,
          point,
          aim,
          hit,
          actor?.reference,
          projectile,
        );
      // It faces off the surface it burst on (else back the way the spell came): its sight
      // starts from there.
      const facingOut: Vec3 = hit?.normal ?? [-aim[0], -aim[1], -aim[2]];
      await casting.explode(delivered.caster, explosion, point, undefined, facingOut);
      noise?.(point, delivered.caster, record?.soundLevel ?? 1);
      // Destructible objects within its radius take the spell too (a fireball's burst on webs),
      // the one hit straight aside (it took it above).
      for (const { reference } of await runtime.destruction.within(
        point,
        record?.radius ?? 0,
        hit?.reference,
      )) {
        await casting.deliver(delivered, reference, { facing: false });
      }
    }
    if (reached) {
      await casting.area(delivered, point, {
        ...(actor && { exclude: actor.reference }),
        ...(seconds !== undefined && { seconds }),
      });
    }
    // The effect's impact on the surface hit (MGEF impact data set: its sound, decal, model,
    // hazard; a noise).
    if (hit && !actor && effect?.impactData !== undefined) {
      const impact = await this.#surface(
        runtime,
        delivered.caster,
        effect.impactData,
        hit,
        point,
        aim,
      );
      if (impact) noise?.(point, delivered.caster, impact.soundLevel);
    }
  }

  /** An impact on a surface: its sound and decal, its model (for its duration) and hazard. */
  async #surface(
    runtime: ScriptRuntime,
    caster: number,
    impactDataSet: number,
    hit: {
      readonly material: number;
      readonly kind: 'object' | 'landscape' | 'actor' | undefined;
      readonly normal?: Vec3;
    },
    point: Vec3,
    aim: Vec3,
  ): Promise<Impact | undefined> {
    let placeable: boolean | undefined;
    const decide = (impact: Impact): boolean =>
      (placeable ??= this.#placements.place(impact, point, this.#clock));
    const impact = this.#options.impact
      ? await this.#options.impact({
          impactDataSet,
          materialId: hit.material,
          position: point,
          direction: aim,
          heavy: false,
          placeable: decide,
        })
      : await this.#options.session.soundSystem?.impactOfSet(
          impactDataSet,
          hit.material,
          hit.kind,
          point,
        );
    if (!impact) return undefined;
    // Within its placement radius of one of its kind still showing: only its sound (a breath's
    // sprays leave a fire every so far, not one each).
    if (!decide(impact)) return impact;
    // Its model along the surface's normal (or the way the spell came), for its duration.
    if (impact.model)
      this.#options.fx?.show(impact.model, undefined, point, {
        kind: 'impact',
        direction: impact.orientation === 0 && hit.normal ? hit.normal : aim,
        ...(impact.duration > 0 && { duration: impact.duration }),
      });
    if (impact.hazard !== undefined) await runtime.hazards.place(impact.hazard, point, caster);
    return impact;
  }

  /**
   * An explosion that is no spell's bursts at a point (a destruction stage's: the destruction
   * engine applies its damage and force through the casting engine's explode): its sounds, what
   * #burst shows and leaves, a noise for detection. `source`: whose it is (the attacker, else the
   * object that blew up).
   */
  async burst(explosionId: number, point: Vec3, source: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const record = runtime && (await runtime.casting.explosion(explosionId));
    if (!runtime || !record) return;
    const { session, noise } = this.#options;
    if (record.sound !== undefined) void session.playSound(record.sound, point);
    if (record.sound2 !== undefined) void session.playSound(record.sound2, point);
    await this.#burst(runtime, source, undefined, record, point, [0, 0, 1], undefined, undefined);
    noise?.(point, source, record.soundLevel);
  }

  /**
   * An explosion bursts (beside its sounds and the casting engine's explode): its model and
   * light, its image-space modifier on a player within its image-space radius, its impact on
   * the surface there, its placed object, its spawned projectile (a spell's: `delivered`) on to
   * the nearest other actor.
   */
  async #burst(
    runtime: ScriptRuntime,
    caster: number,
    delivered: Delivered | undefined,
    explosion: ExplosionRecord,
    point: Vec3,
    aim: Vec3,
    hit:
      | {
          readonly material: number;
          readonly kind: 'object' | 'landscape' | 'actor' | undefined;
          readonly normal?: Vec3;
        }
      | undefined,
    struck: number | undefined,
    from?: ProjectileRecord,
  ): Promise<void> {
    const { fx, session } = this.#options;
    const upright = (explosion.flags & ExplosionFlag.alwaysUsesWorldOrientation) !== 0;
    fx?.show(explosion.model, explosion.light, point, {
      kind: 'explosion',
      ...(!upright && { direction: aim }),
      fades: true,
    });
    const modifier = explosion.imageSpaceModifier;
    const player = [...this.#options.targets()].find((target) => target.reference === PLAYER_REF);
    if (modifier !== undefined && player) {
      const feet = player.shape.feet;
      const distance = Math.hypot(feet[0] - point[0], feet[1] - point[1], feet[2] - point[2]);
      if (distance <= explosion.imageSpaceRadius)
        void session.imageSpaceModifiers.apply(modifier, 1, { target: () => point });
    }
    if (explosion.impactDataSet !== undefined && hit && hit.kind !== 'actor')
      await this.#surface(runtime, caster, explosion.impactDataSet, hit, point, aim);
    const placed = explosion.placedObject;
    if (placed !== undefined) {
      const hazard = await runtime.hazards.place(placed, point, caster);
      if (hazard === undefined) {
        const reference = await runtime.placeAt(placed, caster, 1);
        runtime.move(reference, [...point]);
      }
    }
    // Its projectile flies on from it, at the nearest other living actor within its range
    // (chain lightning), else on the way the spell came; carrying the same spell. TODO(M13):
    // an explosion that is no spell's (a destruction stage's) sending its projectile (no
    // vanilla destruction explosion has one). An explosion with the Chain flag and no projectile
    // of its own (Chain Lightning's) sends on the projectile that burst (`from`). TODO(M13): the
    // Chain flag's rule is inferred from the data (xEdit names it; the engine's use is unread).
    const spawned =
      explosion.spawnProjectile ??
      ((explosion.flags & ExplosionFlag.chain) !== 0 ? from?.formId : undefined);
    const projectile =
      spawned === undefined || !delivered ? undefined : await runtime.casting.projectile(spawned);
    if (projectile && delivered) {
      const range = projectile.range > 0 ? projectile.range : 2048;
      let best: { direction: Vec3; distance: number } | undefined;
      for (const target of this.#options.targets()) {
        if (target.reference === delivered.caster || target.reference === struck) continue;
        const middle: Vec3 = [
          target.shape.feet[0],
          target.shape.feet[1],
          target.shape.feet[2] + target.shape.height / 2,
        ];
        const direction: Vec3 = [middle[0] - point[0], middle[1] - point[1], middle[2] - point[2]];
        const distance = Math.hypot(...direction);
        if (distance > range || (best && best.distance <= distance)) continue;
        if (this.#blocked(delivered.caster, point, middle)) continue;
        best = { direction, distance };
      }
      const chained = { ...delivered, chained: (delivered.chained ?? 0) + 1 };
      const direction = normalize(best?.direction ?? aim);
      // A beam (chain lightning's jump) reaches at once; others fly.
      if ((delivered.chained ?? 0) < 1) {
        if (flightKind(projectile) === 'instant')
          await this.#instant(runtime, chained, projectile, undefined, point, direction, undefined);
        else this.#fly(chained, projectile, undefined, point, direction, undefined);
      }
    }
  }

  /** The lights of what flies now (PROJ light). */
  *lights(): Iterable<CellLight> {
    for (const flying of this.#flying) {
      if (flying.light && !flying.done) yield cellLight(0, flying.flight.position, flying.light, 1);
    }
    yield* this.#beams.lights();
    yield* this.#flames.lights();
  }

  #end(flying: Flying): void {
    flying.done = true;
    this.#flying.delete(flying);
    flying.scene?.destroy();
    flying.scene = undefined;
    void flying.sound?.then((sound) => sound?.stop());
  }

  /** Every projectile goes (the play ended, the view changed). */
  clear(): void {
    for (const flying of [...this.#flying]) this.#end(flying);
    this.#placements.clear();
    this.#beams.clear();
    this.#flames.clear();
  }
}

/** A flying projectile's world matrix: at its position, along its velocity. */
function placementOf(flight: Flight): Float32Array {
  return alongMatrix(flight.position, normalize(flight.velocity));
}

/** Whether a target faces a point (within 90° of its heading: a ward meets it). */
function facing(target: ProjectileTarget, from: Vec3): boolean {
  const dx = from[0] - target.shape.feet[0];
  const dy = from[1] - target.shape.feet[1];
  if (dx === 0 && dy === 0) return true;
  const toward = Math.atan2(dx, dy);
  const delta = Math.atan2(Math.sin(toward - target.heading), Math.cos(toward - target.heading));
  return Math.abs(delta) <= Math.PI / 2;
}
