// Casting in the world, for the player and the NPCs alike (docs/ai.md, "Magic in combat"): the
// casting engine (src/scripting/runtime/casting-engine.ts) keeps the casts; here they are
// animated and sent on their way. A cast begun plays its start in the actor's graph (the idle
// tree's ActionRightAttack / ActionLeftAttack leaf: MRh_SpellAimedStart, MLh_WardStart, ...;
// casting.ts castStartEvent), its MGEF sounds (charge as it charges, ready once it is, release
// as it fires, the concentration loop while a concentration spell is held), its casting art
// in the hand (MGEF casting art, ARTO, on the hand's magic node; dual cast: the dual-cast art at
// its scale) and its casting light there (MGEF light: the hand's glow). Ready: ActionRightReady
// (MRh_SpellReady_Event); fired or stopped: ActionRightRelease (MRh_SpellRelease_Event), its
// projectile leaving the hand's magic node along the actor's aim (src/shell/magic-projectiles.ts);
// a concentration spell sprays every relaunch interval of its projectile (each spray carries
// that much of the spell); let go before it was ready: ActionRightInterrupt. A ward hit plays
// ActionWardHit (wardAbsorb, WardBreak). Shouts: ActionVoice (shoutStart), ActionVoiceRelease
// as the words are let out (the shout's spell from the head), ActionVoiceInterrupt.
//
// The AI's API (5.2's combat AI calls it): castAt(actor, hand, target) — the hand's spell, or the
// spell the casting engine chooses for the purpose — healSelf, summon, drinkPotion, shoutAt.
// NPCs draw their magic first (the combat mechanics' draw: src/shell/actor-combat.ts), release a
// fire and forget spell once it is ready, hold a concentration spell for a while. While an aimed
// cast lasts the arms aim along it (the graphs' BSDirectAtModifiers: setDirectAtTarget).
// A staff's or a scroll's start, or one the tree does not play, is sent as the tree would pick
// it. TODO(M13): the dual-cast animations.

import type { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { castStartEvent } from '../gameplay/magic/casting.ts';
import { aimDirection, normalize } from '../gameplay/magic/projectile-flight.ts';
import { wordsByHold } from '../gameplay/magic/shouts.ts';
import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import { SoundLevel } from '../ai/detection.ts';
import { multiply, type Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuScene, InstanceMotion, ModelInstance } from '../render/scene-renderer.ts';
import type { SoundInstance } from '../audio/sound-instance.ts';
import {
  CastingSource,
  type ActiveCast,
  type CastEvent,
  type CastPurpose,
  type Delivered,
} from '../scripting/runtime/casting-engine.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { meshPath } from '../world/actors.ts';
import { EffectArchetype, EffectFlag, effectSound, EffectSound } from '../world/magic-effects.ts';
import { ActorValue } from '../world/actor-values.ts';
import { Delivery, parseArtObject } from '../world/magic-records.ts';
import { CastType } from '../world/spell-records.ts';
import type { ActorFurniture, FurnitureUser } from './actor-furniture.ts';
import type { StagedActor } from './actor-stage.ts';
import type { PlacedActor } from './actors.ts';
import type { GameSession } from './game-session.ts';
import type { MagicProjectiles } from './magic-projectiles.ts';
import type { PlayerView } from './race-menu.ts';
import type { Terminal } from './terminal.ts';
import { cellLight, type MagicFx } from './magic-fx.ts';
import type { CellLight } from '../world/cell-loader.ts';
import type { LightRecord } from '../world/cell-records.ts';

export interface ActorCastingOptions {
  readonly session: GameSession;
  readonly renderer: Renderer;
  readonly terminal: Terminal;
  readonly furniture: ActorFurniture;
  readonly projectiles: MagicProjectiles;
  readonly get: (reference: number) => StagedActor | undefined;
  readonly userOf: (staged: StagedActor) => FurnitureUser;
  readonly player?: () => PlayerView | undefined;
  /** The height of an actor's eyes over its feet (its controller's), if it has one. */
  readonly height?: (reference: number) => number | undefined;
  /** Whether an actor's weapons or magic are drawn, and drawing them (src/shell/actor-combat.ts). */
  readonly drawn?: (reference: number) => boolean;
  readonly draw?: (reference: number) => Promise<boolean>;
  /**
   * An actor cast (a spell sent at a target, one on itself) or shouted, as loud as the spell's
   * casting sound level: its observers hear it (detection's action noise), those near comment
   * on the player's (PlayerCastProjectileSpell, PlayerCastSelfSpell, PlayerShout).
   */
  readonly acted?: (
    actor: number,
    kind: 'projectile' | 'self' | 'shout',
    soundLevel: number,
  ) => void;
  /** The magic effects' lights (LIGH records, read once). */
  readonly fx?: MagicFx;
}

/**
 * The hands' and the voice's nodes, the first the skeleton has: the character skeleton's, the
 * dragon's head magic node (its breath leaves its mouth).
 */
const NODES: Readonly<Record<number, readonly string[]>> = {
  [CastingSource.left]: ['NPC L MagicNode [LMag]'],
  [CastingSource.right]: ['NPC R MagicNode [RMag]'],
  [CastingSource.voice]: ['NPC Head [Head]', 'NPC Head MagicNode [Hmag]', 'NPC Head'],
};

/**
 * A breath (a concentration shout: the dragons' fire and frost breath) sprays this long at
 * most: the exhale clips' length (Shout_FlightExhaleFlame, Shout_HoverExhaleFlame: 3 s); the
 * graph's shoutStop ends it as its exhale does.
 */
const BREATH_SECONDS = 3;
/** A breath coming is a threat as wide as this (units: what the AI sidesteps). TODO(M13). */
const BREATH_RADIUS = 96;
/** ... and this fast while it is drawn in (its projectile's speed once it flies). */
const BREATH_SPEED = 1000;

/** The idle tree's actions by hand: attack (start), ready, release, interrupt. */
const ACTIONS: Readonly<Record<number, { ready: string; release: string; interrupt: string }>> = {
  [CastingSource.left]: {
    ready: 'ActionLeftReady',
    release: 'ActionLeftRelease',
    interrupt: 'ActionLeftInterrupt',
  },
  [CastingSource.right]: {
    ready: 'ActionRightReady',
    release: 'ActionRightRelease',
    interrupt: 'ActionRightInterrupt',
  },
};

/**
 * An NPC holds a concentration spell while it serves: at a target while the target lives and
 * stays within its projectile's reach (and the magicka lasts: the casting engine ends it); one
 * without a target this long at most, a healing spell less once its health is whole.
 * TODO(M13): how long the engine holds a ward is not documented.
 */
const NPC_WARD_SECONDS = 2.5;
/** How often an NPC's held concentration spell is looked at (seconds). */
const HOLD_CHECK_SECONDS = 0.25;
/** The reach of a concentration spell without a projectile range (units). */
const HOLD_REACH = 2048;
/** A concentration spell without a projectile (Self, Touch) acts this often (seconds). */
const HELD_INTERVAL = 0.25;
/** The BSDirectAtModifiers' kind for bows and spells (userInfo), and how far off the aimed point is. */
const AIM = 2;
const AIM_DISTANCE = 2048;
/** An actor's eyes and chest without a controller (units over its feet; a human's). */
const EYE_HEIGHT = 110;
const CHEST_HEIGHT = 90;

/** A cast the world shows: its sounds, its art, its sprays. */
interface Shown {
  readonly cast: ActiveCast;
  /** The actor aimed at (NPCs), if any. */
  target: number | undefined;
  /** Seconds to the next spray of a concentration spell. */
  spray: number;
  /** An NPC lets go then (seconds left), if it decides. */
  holdFor: number | undefined;
  /** Seconds to an NPC's next look at whether its concentration spell still serves. */
  holdCheck: number;
  sounds: Promise<SoundInstance | undefined>[];
  loop: Promise<SoundInstance | undefined> | undefined;
  art: { instance: ModelInstance; scene: GpuScene; motion: InstanceMotion } | undefined;
  /** The casting light in the hand (MGEF light), once read. */
  light: LightRecord | undefined;
  /** The art's scale (a dual cast's: MGEF dual cast scale). */
  scale: number;
  done: boolean;
}

/** A source's node in an actor's pose (model space), the first its skeleton has. */
function nodeOf(placed: PlacedActor, source: number): Float32Array | undefined {
  for (const node of NODES[source] ?? []) {
    const local = placed.pose.world(node);
    if (local) return local;
  }
  return undefined;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorCasting {
  readonly #options: ActorCastingOptions;
  /** Casts shown, by "actor:source". */
  readonly #shown = new Map<string, Shown>();
  /** NPCs' shouts going on: the target and the words. */
  readonly #shouts = new Map<number, { target: number | undefined; words: number; left: number }>();
  /** Breaths sprayed (concentration shouts let out): what fired, at whom, how long left. */
  readonly #breaths = new Map<
    number,
    {
      readonly delivered: Delivered;
      readonly target: number | undefined;
      left: number;
      spray: number;
    }
  >();
  /** The player's aim (the camera's forward), set by the player's casting. */
  playerAim: (() => Vec3) | undefined;
  #runtime: ScriptRuntime | undefined;
  #stop: (() => void) | undefined;

  constructor(options: ActorCastingOptions) {
    this.#options = options;
  }

  /** Hears the running game's casts (again when a new game starts). */
  #listen(): ScriptRuntime | undefined {
    const runtime = this.#options.session.scriptsReady;
    if (runtime === this.#runtime) return runtime;
    this.#stop?.();
    this.#stop = undefined;
    this.#runtime = runtime;
    if (!runtime) return undefined;
    const listener = (event: CastEvent): void => {
      this.#heard(runtime, event);
    };
    runtime.casting.listeners.add(listener);
    this.#stop = () => runtime.casting.listeners.delete(listener);
    return runtime;
  }

  /** The actor as a user of the idle tree (the player: its avatar). */
  #user(actor: number): FurnitureUser | undefined {
    if (actor === PLAYER_REF) {
      const view = this.#options.player?.();
      const avatar = view?.avatar;
      if (!view || !avatar) return undefined;
      const player = view.play.player;
      return {
        reference: PLAYER_REF,
        get placed() {
          return avatar.body;
        },
        get position() {
          return player.feet;
        },
        get heading() {
          return avatar.bodyYaw;
        },
        moveTo: () => undefined,
        send: (event) => avatar.send(event),
      };
    }
    const staged = this.#options.get(actor);
    return staged && !staged.dead ? this.#options.userOf(staged) : undefined;
  }

  #placed(actor: number): PlacedActor | undefined {
    if (actor === PLAYER_REF) return this.#options.player?.()?.avatar?.body;
    return this.#options.get(actor)?.placed;
  }

  /** Where an actor's feet are and which way it faces. */
  #place(actor: number): { feet: Vec3; heading: number } | undefined {
    if (actor === PLAYER_REF) {
      const player = this.#options.player?.()?.play.player;
      return player && { feet: player.feet, heading: player.yaw };
    }
    const staged = this.#options.get(actor);
    return staged && { feet: staged.position, heading: staged.heading };
  }

  /** A source's node in the world (a hand's magic node, the head), else at the actor's eyes. */
  origin(actor: number, source: number): Vec3 | undefined {
    const placed = this.#placed(actor);
    const instance = placed?.instances[0];
    const local = placed && nodeOf(placed, source);
    if (instance && local) {
      const world = multiply(instance.world, local);
      return [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
    }
    const place = this.#place(actor);
    if (!place) return undefined;
    const eye = this.#options.height?.(actor) ?? EYE_HEIGHT;
    return [place.feet[0], place.feet[1], place.feet[2] + eye];
  }

  /** Where an actor aims from a point: the player along the camera, an NPC at its target's chest. */
  #aim(actor: number, from: Vec3, target: number | undefined): Vec3 {
    if (actor === PLAYER_REF && this.playerAim) return this.playerAim();
    const at = target === undefined ? undefined : this.#place(target);
    if (at) {
      const chest =
        (this.#options.height?.(target ?? 0) ?? EYE_HEIGHT) * (CHEST_HEIGHT / EYE_HEIGHT);
      return normalize([at.feet[0] - from[0], at.feet[1] - from[1], at.feet[2] + chest - from[2]]);
    }
    return aimDirection(this.#place(actor)?.heading ?? 0, 0);
  }

  // --- Casts ----------------------------------------------------------------------------------

  /**
   * A cast begins from a source (the player's attack button with magic drawn, an NPC's castAt):
   * the casting engine begins it (refusals: its meter blinks), the graph plays its start.
   */
  async start(
    actor: number,
    source: number,
    options: { readonly dual?: boolean; readonly target?: number } = {},
  ): Promise<boolean> {
    const runtime = this.#listen();
    const user = this.#user(actor);
    if (!runtime || !user) return false;
    const hand = source === CastingSource.left ? 'left' : 'right';
    const result = await runtime.casting.begin(actor, source, {
      ...(options.dual !== undefined && { dual: options.dual }),
    });
    if (result !== 'started') return false;
    const cast = runtime.casting.casting(actor, source);
    if (!cast) return false;
    const shown = this.#show(cast, options.target);
    const item = cast.castable.item;
    const main = await runtime.casting.mainEffect(item);
    const event = castStartEvent(hand, {
      castType: item.castType,
      delivery: item.delivery,
      ward: item.keywords.includes(0x1ea69),
      telekinesis: main?.archetype === EffectArchetype.telekinesis,
    });
    // A spell's start is the idle tree's attack action (its leaf by GetCurrentCastingType,
    // GetCurrentDeliveryType, SpellHasKeyword); a staff's or a scroll's, or where the tree has
    // none (undrawn: IsWeaponMagicOut is the combat mechanics'), the event it would pick.
    const action = hand === 'left' ? 'ActionLeftAttack' : 'ActionRightAttack';
    const played =
      cast.castable.via === 'spell' && (await this.#options.furniture.playAction(user, action));
    if (!played) user.send(event);
    if (cast.dual) user.send(castStartEvent(hand === 'left' ? 'right' : 'left', item));
    // Its charge sound, from the hand.
    const charge = main && effectSound(main, EffectSound.charge);
    if (charge !== undefined) shown.sounds.push(this.#sound(charge, actor, source));
    // Its art in the hand (a dual cast's own art, at its scale), its light there.
    const dualArt = cast.dual ? main?.dualCastArt : undefined;
    if (dualArt !== undefined)
      shown.scale = main && main.dualCastScale > 0 ? main.dualCastScale : 1;
    void this.#art(shown, dualArt ?? main?.castingArt);
    void this.#options.fx?.lightRecord(main?.light).then((light) => {
      shown.light = light;
    });
    return true;
  }

  /** The casting lights in the hands (MGEF light) while the casts last. */
  lights(): CellLight[] {
    const lights: CellLight[] = [];
    for (const shown of this.#shown.values()) {
      if (!shown.light || shown.done) continue;
      const at = this.origin(shown.cast.actor, shown.cast.source);
      if (at) lights.push(cellLight(shown.cast.actor, at, shown.light, 1));
    }
    return lights;
  }

  /** The source lets go (the button released; an NPC's cast once ready or held long enough). */
  async letGo(actor: number, source: number): Promise<void> {
    const runtime = this.#listen();
    if (!runtime) return;
    await runtime.casting.release(actor, source);
  }

  #key(actor: number, source: number): string {
    return `${String(actor)}:${String(source)}`;
  }

  #show(cast: ActiveCast, target: number | undefined): Shown {
    const key = this.#key(cast.actor, cast.source);
    this.#end(key);
    const shown: Shown = {
      cast,
      target,
      spray: 0,
      holdFor:
        cast.actor === PLAYER_REF || target !== undefined
          ? undefined
          : cast.castable.item.castType === CastType.concentration
            ? NPC_WARD_SECONDS
            : undefined,
      holdCheck: HOLD_CHECK_SECONDS,
      sounds: [],
      loop: undefined,
      art: undefined,
      light: undefined,
      scale: 1,
      done: false,
    };
    this.#shown.set(key, shown);
    return shown;
  }

  #sound(sound: number, actor: number, source: number): Promise<SoundInstance | undefined> {
    const system = this.#options.session.soundSystem;
    if (!system) return Promise.resolve(undefined);
    let last: Vec3 = this.origin(actor, source) ?? [0, 0, 0];
    return system.play(
      sound,
      () => {
        last = this.origin(actor, source) ?? last;
        return last;
      },
      0,
      actor,
    );
  }

  /** The casting art (ARTO) in the hand while the cast lasts. */
  async #art(shown: Shown, art: number | undefined): Promise<void> {
    const runtime = this.#runtime;
    if (art === undefined || !runtime) return;
    const record = await runtime.forms.record(art);
    const model = record ? parseArtObject(record)?.model : undefined;
    if (!model || shown.done) return;
    try {
      const gpu = await this.#options.session.model(meshPath(model));
      if (!gpu || this.#gone(shown)) return;
      const motion: InstanceMotion = { version: 0 };
      const instance: ModelInstance = { model: gpu, world: new Float32Array(16), motion };
      this.#placeArt(shown, instance);
      shown.art = { instance, scene: this.#options.renderer.scene.createScene([instance]), motion };
    } catch (error) {
      this.#options.terminal.log('magic', `${model}: ${describe(error)}`, 'warn');
    }
  }

  /** Whether a cast shown has ended (meanwhile: its art comes too late). */
  #gone(shown: Shown): boolean {
    return shown.done;
  }

  #placeArt(shown: Shown, instance: ModelInstance): void {
    const placed = this.#placed(shown.cast.actor);
    const local = placed && nodeOf(placed, shown.cast.source);
    const world = placed?.instances[0]?.world;
    if (!local || !world) return;
    const matrix = multiply(world, local);
    if (shown.scale !== 1) for (let i = 0; i < 12; i++) matrix[i] = (matrix[i] ?? 0) * shown.scale;
    instance.world.set(matrix);
  }

  /** Its scenes (the casting art in the hands). */
  *scenes(): Iterable<GpuScene> {
    for (const shown of this.#shown.values()) if (shown.art) yield shown.art.scene;
  }

  #end(key: string): void {
    const shown = this.#shown.get(key);
    if (!shown) return;
    this.#shown.delete(key);
    shown.done = true;
    for (const sound of shown.sounds) void sound.then((instance) => instance?.stop());
    void shown.loop?.then((instance) => instance?.stop());
    shown.art?.scene.destroy();
    // Its arms no longer aim (unless the other hand still casts).
    const still = [...this.#shown.values()].some((other) => other.cast.actor === shown.cast.actor);
    if (!still)
      for (const graph of this.#graphs(shown.cast.actor)) graph.setDirectAtTarget(AIM, undefined);
  }

  /** An actor's graphs (the player's body and first-person ones). */
  #graphs(actor: number): BehaviorRuntime[] {
    const graphs: BehaviorRuntime[] = [];
    const body = this.#placed(actor)?.behavior;
    if (body) graphs.push(body);
    const first =
      actor === PLAYER_REF ? this.#options.player?.()?.avatar?.firstPerson?.behavior : undefined;
    if (first) graphs.push(first);
    return graphs;
  }

  /**
   * An aimed cast turns the arms toward where it goes: the graphs' BSDirectAtModifiers of bows
   * and spells (userInfo 2) get the aimed point (behavior-runtime setDirectAtTarget).
   */
  #aimArms(shown: Shown): void {
    const { cast } = shown;
    if (cast.castable.item.delivery < Delivery.aimed) return;
    const origin = this.origin(cast.actor, cast.source);
    if (!origin) return;
    const aim = this.#aim(cast.actor, origin, shown.target);
    const point: Vec3 = [
      origin[0] + aim[0] * AIM_DISTANCE,
      origin[1] + aim[1] * AIM_DISTANCE,
      origin[2] + aim[2] * AIM_DISTANCE,
    ];
    for (const graph of this.#graphs(cast.actor)) graph.setDirectAtTarget(AIM, point);
  }

  /** What the casting engine tells: the graph, the sounds, the projectiles. */
  #heard(runtime: ScriptRuntime, event: CastEvent): void {
    const { actor, source } = event;
    const key = this.#key(actor, source);
    const user = this.#user(actor);
    const play = (action: string | undefined): void => {
      if (user && action) void this.#options.furniture.playAction(user, action);
    };
    const actions = ACTIONS[source];
    switch (event.kind) {
      case 'ready': {
        play(actions?.ready);
        const shown = this.#shown.get(key);
        const cast = event.cast;
        void (async () => {
          const main = cast && (await runtime.casting.mainEffect(cast.castable.item));
          if (!cast || !main || !shown || shown.done) return;
          const ready = effectSound(main, EffectSound.ready);
          if (ready !== undefined) shown.sounds.push(this.#sound(ready, actor, source));
          const loop = effectSound(main, EffectSound.concentrationLoop);
          if (loop !== undefined && cast.castable.item.castType === CastType.concentration)
            shown.loop = this.#sound(loop, actor, source);
        })();
        break;
      }
      case 'fire': {
        play(source === CastingSource.voice ? 'ActionVoiceRelease' : actions?.release);
        const shown = this.#shown.get(key);
        this.#end(key);
        if (event.delivered) void this.#send(runtime, event.delivered, source, shown?.target);
        break;
      }
      case 'stop':
        play(actions?.release);
        this.#end(key);
        break;
      case 'cancel':
        play(actions?.interrupt);
        this.#end(key);
        if (source === CastingSource.voice) play('ActionVoiceInterrupt');
        break;
      case 'ward':
        play('ActionWardHit');
        break;
      case 'shout': {
        play('ActionVoiceRelease');
        const shout = this.#shouts.get(actor);
        this.#shouts.delete(actor);
        const delivered = event.delivered;
        if (!delivered) break;
        // A concentration shout (a dragon's breath) sprays while its exhale lasts.
        if (delivered.item.castType === CastType.concentration) {
          this.#breaths.set(actor, {
            delivered,
            target: shout?.target,
            left: BREATH_SECONDS,
            spray: 0,
          });
          const main = runtime.casting.mainEffect(delivered.item);
          void main.then((effect) => {
            const release = effect && effectSound(effect, EffectSound.release);
            if (release !== undefined) void this.#sound(release, actor, source);
            this.#options.acted?.(actor, 'shout', effect?.castingSoundLevel ?? 1);
          });
          break;
        }
        void this.#send(runtime, delivered, source, shout?.target);
        break;
      }
      default:
        break;
    }
  }

  /** What fired leaves the source's node along the actor's aim (its release sound with it). */
  async #send(
    runtime: ScriptRuntime,
    delivered: Delivered,
    source: number,
    target: number | undefined,
    seconds?: number,
  ): Promise<void> {
    const actor = delivered.caster;
    const origin = this.origin(actor, source);
    if (!origin) return;
    if (seconds === undefined) {
      const main = await runtime.casting.mainEffect(delivered.item);
      const release = main && effectSound(main, EffectSound.release);
      if (release !== undefined) void this.#sound(release, actor, source);
      const kind =
        delivered.via === 'shout'
          ? 'shout'
          : delivered.item.delivery === Delivery.self
            ? 'self'
            : 'projectile';
      // The caster's perks may silence it (Mod Spell Casting Sound Event, 0: Quiet Casting).
      const heard = await runtime.perks.apply(EntryPoint.modSpellCastingSoundEvent, actor, 1, [
        delivered.item.formId,
      ]);
      this.#options.acted?.(
        actor,
        kind,
        heard === 0 ? SoundLevel.silent : (main?.castingSoundLevel ?? 1),
      );
    }
    await this.#options.projectiles.launch(delivered, origin, this.#aim(actor, origin, target), {
      ...(target !== undefined && { target }),
      ...(seconds !== undefined && { seconds }),
    });
  }

  /**
   * Every frame: concentration spells spray (each relaunch interval of their projectile), NPCs
   * let go of their casts, the casting art follows the hands, NPCs' shouts are let out.
   */
  frame(seconds: number): void {
    const runtime = this.#listen();
    if (!runtime || seconds <= 0) return;
    for (const [key, shown] of [...this.#shown]) {
      const { cast } = shown;
      if (cast.hand.phase === 'done' && !runtime.casting.casting(cast.actor, cast.source)) {
        this.#end(key);
        continue;
      }
      if (shown.art) {
        this.#placeArt(shown, shown.art.instance);
        shown.art.motion.version++;
      }
      this.#aimArms(shown);
      // NPCs: a fire and forget spell goes once ready; a concentration spell after a while.
      if (cast.actor !== PLAYER_REF) {
        if (cast.hand.phase === 'ready') void this.letGo(cast.actor, cast.source);
        if (cast.hand.phase === 'casting' && shown.holdFor !== undefined) {
          shown.holdFor -= seconds;
          if (shown.holdFor <= 0) void this.letGo(cast.actor, cast.source);
        }
        if (cast.hand.phase === 'casting') {
          shown.holdCheck -= seconds;
          if (shown.holdCheck <= 0) {
            shown.holdCheck = HOLD_CHECK_SECONDS;
            void this.#serves(runtime, shown).then((serves) => {
              if (!serves && !shown.done) void this.letGo(cast.actor, cast.source);
            });
          }
        }
      }
      if (cast.hand.phase !== 'casting') continue;
      shown.spray -= seconds;
      if (shown.spray > 0) continue;
      void this.#spray(runtime, shown);
    }
    for (const [actor, breath] of [...this.#breaths]) {
      breath.left -= seconds;
      breath.spray -= seconds;
      if (breath.left <= 0) {
        this.#breaths.delete(actor);
        continue;
      }
      if (breath.spray > 0) continue;
      // Not again until this spray is on its way (it sets the next).
      breath.spray = Infinity;
      void this.#breathSpray(runtime, breath);
    }
    for (const [actor, shout] of this.#shouts) {
      shout.left -= seconds;
      if (shout.left > 0) continue;
      // Let out once (its 'shout' event sends it on its way, with the target kept here).
      shout.left = Infinity;
      void runtime.casting.releaseShout(actor, shout.words).then((delivered) => {
        if (!delivered) this.#shouts.delete(actor);
      });
    }
  }

  /**
   * Whether an NPC's concentration spell still serves (see NPC_WARD_SECONDS): its target alive
   * and in reach, or its health not whole for a healing spell.
   */
  async #serves(runtime: ScriptRuntime, shown: Shown): Promise<boolean> {
    const { cast, target } = shown;
    const item = cast.castable.item;
    if (target !== undefined && target !== cast.actor) {
      if (await runtime.actors.isDead(target)) return false;
      const from = this.#place(cast.actor)?.feet;
      const to = this.#place(target)?.feet;
      if (!from || !to) return false;
      const main = await runtime.casting.mainEffect(item);
      const projectile =
        main?.projectile === undefined
          ? undefined
          : await runtime.casting.projectile(main.projectile);
      const reach = projectile && projectile.range > 0 ? projectile.range : HOLD_REACH;
      return Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) <= reach;
    }
    const main = await runtime.casting.mainEffect(item);
    const heals =
      main?.archetype === EffectArchetype.valueModifier &&
      main.actorValue === ActorValue.health &&
      (main.flags & EffectFlag.detrimental) === 0;
    if (!heals) return true;
    const health = await runtime.actors.value(cast.actor, ActorValue.health);
    return health.current < health.max;
  }

  /** One spray of a breath: the interval's share of its shout's spell, from the head. */
  async #breathSpray(
    runtime: ScriptRuntime,
    breath: { readonly delivered: Delivered; readonly target: number | undefined; spray: number },
  ): Promise<void> {
    const main = await runtime.casting.mainEffect(breath.delivered.item);
    const projectile =
      main?.projectile === undefined
        ? undefined
        : await runtime.casting.projectile(main.projectile);
    const interval =
      projectile && projectile.relaunchInterval > 0 ? projectile.relaunchInterval : HELD_INTERVAL;
    breath.spray = interval;
    await this.#send(runtime, breath.delivered, CastingSource.voice, breath.target, interval);
  }

  /** The breath ends (the graph's shoutStop: its exhale is over). */
  stopBreath(actor: number): void {
    this.#breaths.delete(actor);
  }

  /**
   * Breaths coming at the actors (what they sidestep: the combat AI's threats): a shout drawn in
   * at a target, and a breath sprayed, from the head towards its target.
   */
  *threats(): Iterable<{
    readonly key: object;
    readonly position: Vec3;
    readonly velocity: Vec3;
    readonly radius: number;
    readonly source: number | undefined;
  }> {
    const coming = (
      key: object,
      actor: number,
      target: number | undefined,
    ):
      | { key: object; position: Vec3; velocity: Vec3; radius: number; source: number }
      | undefined => {
      const origin = this.origin(actor, CastingSource.voice);
      if (!origin || target === undefined) return undefined;
      const aim = this.#aim(actor, origin, target);
      return {
        key,
        position: origin,
        velocity: [aim[0] * BREATH_SPEED, aim[1] * BREATH_SPEED, aim[2] * BREATH_SPEED],
        radius: BREATH_RADIUS,
        source: actor,
      };
    };
    for (const [actor, shout] of this.#shouts) {
      const threat = coming(shout, actor, shout.target);
      if (threat) yield threat;
    }
    for (const [actor, breath] of this.#breaths) {
      const threat = coming(breath, actor, breath.target);
      if (threat) yield threat;
    }
  }

  /** A concentration spell's spray: what it carries is the interval's share of the spell. */
  async #spray(runtime: ScriptRuntime, shown: Shown): Promise<void> {
    const { cast } = shown;
    const main = await runtime.casting.mainEffect(cast.castable.item);
    const projectile =
      main?.projectile === undefined
        ? undefined
        : await runtime.casting.projectile(main.projectile);
    const interval =
      projectile && projectile.relaunchInterval > 0 ? projectile.relaunchInterval : HELD_INTERVAL;
    shown.spray = interval;
    const delivered = runtime.casting.held(cast.actor, cast.source);
    if (!delivered) return;
    await this.#send(runtime, delivered, cast.source, shown.target, interval);
  }

  // --- The AI's API ---------------------------------------------------------------------------

  /**
   * An NPC casts at a target from a hand ('both': dual cast): `spell` (equipped to the hand
   * first), else what the hand holds, else the spell the casting engine chooses for `purpose`
   * (attack by default). Whether the cast began.
   */
  async castAt(
    actor: number,
    hand: 'left' | 'right' | 'both',
    target: number | undefined,
    options: { readonly spell?: number; readonly purpose?: CastPurpose } = {},
  ): Promise<boolean> {
    const runtime = this.#listen();
    if (!runtime) return false;
    const source = hand === 'left' ? CastingSource.left : CastingSource.right;
    let spell = options.spell;
    if (spell === undefined && !(await runtime.casting.castable(actor, source)))
      spell = (await runtime.casting.chooseSpell(actor, options.purpose ?? 'attack'))?.formId;
    if (spell !== undefined) {
      await runtime.equipment.equipSpell(actor, spell, source);
      if (hand === 'both') await runtime.equipment.equipSpell(actor, spell, CastingSource.left);
    }
    // Its magic drawn first (the combat mechanics' draw: ActionDraw, Magic_Equip).
    if (this.#options.drawn?.(actor) === false) await this.#options.draw?.(actor);
    return this.start(actor, source, {
      dual: hand === 'both',
      ...(target !== undefined && { target }),
    });
  }

  /** An NPC heals itself (its best healing spell it has the magicka for). */
  async healSelf(actor: number): Promise<boolean> {
    const spell = (await this.#listen()?.casting.chooseSpell(actor, 'heal'))?.formId;
    return spell !== undefined && this.castAt(actor, 'right', actor, { spell });
  }

  /**
   * An NPC drinks the potion it carries that restores a value most (Health 24, Magicka 25,
   * Stamina 26: the magic system's useItem, its use sound). Whether it drank one.
   */
  async drinkPotion(actor: number, value: number): Promise<boolean> {
    const runtime = this.#listen();
    const potion = runtime && (await runtime.casting.choosePotion(actor, value));
    if (!runtime || potion === undefined) return false;
    return (await runtime.magic.useItem(actor, potion)) === 'used';
  }

  /** An NPC summons (its conjuration): toward the target, or before itself. */
  async summon(actor: number, target?: number): Promise<boolean> {
    const spell = (await this.#listen()?.casting.chooseSpell(actor, 'summon'))?.formId;
    return spell !== undefined && this.castAt(actor, 'right', target, { spell });
  }

  /**
   * An actor shouts its voice's shout at a target (Greybeards, draugr, dragons' breath):
   * `words` (default all it knows) are let out after their hold time (fShoutTime1 / 2).
   */
  async shoutAt(actor: number, target: number | undefined, words?: number): Promise<boolean> {
    const runtime = this.#listen();
    const user = this.#user(actor);
    if (!runtime || !user) return false;
    if ((await runtime.casting.beginShout(actor)) !== 'started') return false;
    const voice = (await runtime.equipment.of(actor)).voice;
    const shout = voice === undefined ? undefined : await runtime.casting.shout(voice);
    // A power in the voice was begun as a cast (castable): its cast shows.
    if (!shout) {
      const cast = runtime.casting.casting(actor, CastingSource.voice);
      if (cast) this.#show(cast, target);
      return cast !== undefined;
    }
    const known = runtime.casting.wordsKnown(actor, shout);
    const count = Math.min(words ?? known, known);
    const { shout: times } = await runtime.casting.settings();
    const hold = count >= 3 ? times.time2 : count === 2 ? times.time1 : 0;
    await this.#options.furniture.playAction(user, 'ActionVoice');
    this.#shouts.set(actor, { target, words: count, left: hold });
    return true;
  }

  /** The player's voice key: the shout begins (its graph's shoutStart), or a power is cast. */
  async voiceDown(): Promise<'shout' | 'power' | undefined> {
    const runtime = this.#listen();
    const user = this.#user(PLAYER_REF);
    if (!runtime || !user) return undefined;
    const result = await runtime.casting.beginShout(PLAYER_REF);
    if (result !== 'started') return undefined;
    const cast = runtime.casting.casting(PLAYER_REF, CastingSource.voice);
    if (cast) {
      // A power: cast as it is ready (the voice key need not be held).
      this.#show(cast, undefined).holdFor = undefined;
      await this.#options.furniture.playAction(user, 'ActionVoice');
      return 'power';
    }
    await this.#options.furniture.playAction(user, 'ActionVoice');
    return 'shout';
  }

  /** The player's voice key let go after `held` seconds: the words it was held for go. */
  async voiceUp(held: number): Promise<void> {
    const runtime = this.#listen();
    if (!runtime?.casting.isShouting(PLAYER_REF)) return;
    const voice = (await runtime.equipment.of(PLAYER_REF)).voice;
    const shout = voice === undefined ? undefined : await runtime.casting.shout(voice);
    if (!shout) return;
    const known = runtime.casting.wordsKnown(PLAYER_REF, shout);
    const { shout: times } = await runtime.casting.settings();
    await runtime.casting.releaseShout(PLAYER_REF, wordsByHold(held, known, times));
  }

  /** A power's cast (the voice) fires once ready. */
  powersFrame(): void {
    const runtime = this.#runtime;
    if (!runtime) return;
    const cast = runtime.casting.casting(PLAYER_REF, CastingSource.voice);
    if (cast?.hand.phase === 'ready') void this.letGo(PLAYER_REF, CastingSource.voice);
  }

  /** An actor left the stage or died: its casts stop. */
  remove(actor: number): void {
    this.#runtime?.casting.interrupt(actor);
    this.#shouts.delete(actor);
    this.#breaths.delete(actor);
    for (const key of [...this.#shown.keys()])
      if (key.startsWith(`${String(actor)}:`)) this.#end(key);
  }

  /** Everything stops (the view closes). */
  clear(): void {
    for (const key of [...this.#shown.keys()]) this.#end(key);
    this.#shouts.clear();
    this.#breaths.clear();
    this.#stop?.();
    this.#stop = undefined;
    this.#runtime = undefined;
  }
}
