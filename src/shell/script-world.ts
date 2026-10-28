// The running game's scripts and the world on screen: what scripts do (enable, move, animate,
// push, activate references, show messages, play sounds, put image-space modifiers on the
// screen) reaches the viewers that show those references, and what the scripts ask of the
// world (which references are loaded, where a moving one is now) comes from them. The script
// runtime's WorldBridge.

import type { Vec3 } from '../scripting/runtime/game-state.ts';
import type { DestructionStage } from '../world/destruction-records.ts';
import type { BodyPush } from '../gameplay/magic/explosions.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { MagicEffectShown } from '../scripting/runtime/magic-engine.ts';
import type { SceneSpeech } from '../scripting/runtime/scene-host.ts';
import type {
  ActorCombatState,
  ActorFlightState,
  ActorInteraction,
  ActorMotion,
  LivePlacement,
  MenuRequest,
  QuestUpdate,
  WorldBridge,
} from '../scripting/runtime/runtime.ts';
import { multiply, type Mat4 } from '../render/math.ts';
import type { ModelInstance } from '../render/scene-renderer.ts';
import { matrixPlacement } from '../world/cell-loader.ts';
import type { SoundSystem } from '../audio/sound-system.ts';
import type { SoundInstance } from '../audio/sound-instance.ts';
import type { SavedGraph, ScriptGraph } from '../animation/script-graphs.ts';
import type { SavedActor, SavedProjectile, WorldSave } from '../save/world-save.ts';
import type { ScreenModifiers } from './screen-modifiers.ts';
import { SkyMode, type SkyWeather } from '../world/sky-weather.ts';
import type { Terminal } from './terminal.ts';
import type { HudSignals } from './hud-signals.ts';
import type { Talking } from './world-lines.ts';
import { rumbleGamepad } from './gamepad-input.ts';
import { LookRequests, type HeadTrackKind } from '../ai/head-tracking.ts';
import { bodyOfNode, type PhysicsWorld, type PlacedCollision } from '../physics/physics-world.ts';

/**
 * A view's script-made constraints (Game.AddHavokBallAndSocketConstraint,
 * RemoveHavokConstraints) on its physics: each reference's bodies by node, its objects' and its
 * actors' (a hanged corpse's ragdoll).
 */
export function scriptConstraints(
  physics: () => PhysicsWorld | undefined,
  placements: (reference: number) => Iterable<PlacedCollision>,
): Pick<ScriptView, 'ballAndSocket' | 'removeConstraints'> {
  const bodies = (a: number, nodeA: string, b: number, nodeB: string) => {
    const world = physics();
    const bodyA = bodyOfNode(placements(a), nodeA);
    const bodyB = bodyOfNode(placements(b), nodeB);
    return world && bodyA && bodyB ? { world, bodyA, bodyB } : undefined;
  };
  return {
    ballAndSocket: (a, nodeA, b, nodeB, offsetA, offsetB) => {
      const found = bodies(a, nodeA, b, nodeB);
      return (
        found?.world.joinBallAndSocket(found.bodyA, [...offsetA], found.bodyB, [...offsetB]) ??
        false
      );
    },
    removeConstraints: (a, nodeA, b, nodeB) => {
      const found = bodies(a, nodeA, b, nodeB);
      return (found?.world.removeScriptJoints(found.bodyA, found.bodyB) ?? 0) > 0;
    },
  };
}

/** A viewer that shows references to the scripts (the interior or the world viewer). */
export interface ScriptView {
  /** The references whose 3D is loaded now. */
  loadedReferences(): Iterable<number>;
  loaded(reference: number): boolean;
  /** Where a loaded reference is now (moving objects, actors); undefined if not shown here. */
  livePlacement?(reference: number): LivePlacement | undefined;
  /** A script created a reference (PlaceAtMe): the view shows it if it is there. */
  created?(reference: number): void;
  /** Scripts changed what is enabled: the view applies the new states. */
  enableStatesChanged(): void;
  /** A script moved or scaled a reference. */
  moved?(reference: number): void;
  /** A shown reference's running behavior graph (an object's or an actor's). */
  graphOf?(reference: number): ScriptGraph | undefined;
  /** A script sent an animation event to a reference's graph (PlayAnimation). */
  animated?(reference: number, event: string): void;
  /** SetMotionType (1 dynamic .. 4 keyframed). */
  motionTypeChanged?(reference: number, motionType: number): void;
  /** Weapon.Fire (WorldBridge.fireWeapon): a shot from a reference. */
  fireWeapon?(weapon: number, source: number, ammo: number | undefined): void;
  /** WorldBridge.ballAndSocket (scriptConstraints). */
  ballAndSocket?(
    a: number,
    nodeA: string,
    b: number,
    nodeB: string,
    offsetA: readonly [number, number, number],
    offsetB: readonly [number, number, number],
  ): boolean;
  /** WorldBridge.removeConstraints (scriptConstraints). */
  removeConstraints?(a: number, nodeA: string, b: number, nodeB: string): boolean;
  /** A push (WorldBridge.impulse). */
  impulse?(
    reference: number,
    direction: Vec3,
    magnitude: number,
    share?: (layer: number) => number,
  ): void;
  /** An explosion pushes a reference's moving bodies (WorldBridge.explosionPush). */
  explosionPush?(
    reference: number,
    center: Vec3,
    push: (layer: number, mass: number) => BodyPush,
  ): void;
  /** Whether an explosion seen from a point reaches an actor (WorldBridge.explosionReaches). */
  explosionReaches?(from: Vec3, target: number, buffer: number): boolean | undefined;
  /** Where a summon stands on the navmeshes (WorldBridge.summonPlace). */
  summonPlace?(from: Vec3, to: Vec3, radius: number): Vec3 | undefined;
  /**
   * A destructible reference's stage changed (src/shell/destruction-looks.ts): its look and
   * collision follow; `reached`: the stage just reached, whose debris is thrown.
   */
  destructionChanged?(reference: number, reached: DestructionStage | undefined): void;
  /** An explosion bursts at a point (a destruction stage's): its model, light, sounds. */
  explosion?(explosion: number, at: Vec3, source: number | undefined): void;
  /** How many are inside a reference's trigger volume now. */
  triggerCount?(reference: number): number;
  /** Whether a look along a direction meets the sun in the sky (a bow shot's sun gazing). */
  sunGazed?(direction: readonly [number, number, number]): boolean;
  /** SetOpen: a door of the view swings open or shut (src/shell/actor-doors.ts setOpen). */
  openChanged?(reference: number, open: boolean): void;
  /** A named node of a shown reference's model: where it is in the world. */
  nodeWorld?(reference: number, node: string): Mat4 | undefined;
  /** What activating a reference does by default (a script's Activate). */
  activate?(reference: number, activator: number | undefined): void;
  /**
   * An actor's look changed (Actor.SetRace; the player's appearance in the race menu): the
   * view makes its 3D again; resolves once it shows the new look.
   */
  lookChanged?(reference: number): Promise<void>;
  /**
   * An actor died: the view lays it down as its ragdoll (its pose follows its bodies); it cries
   * out unless the kill was silent (KillSilent).
   */
  killed?(reference: number, killer: number | undefined, silent: boolean): void;
  /** A magic effect begins or ends on an actor: what it shows (src/shell/actor-effects.ts). */
  magicEffect?(shown: MagicEffectShown): void;
  /** EffectShader.Play / Stop and VisualEffect.Play / Stop on a reference of the view. */
  effectShader?(shader: number, target: number, play: boolean, duration: number): void;
  visualEffect?(effect: number, target: number, play: boolean, duration: number): void;
  /** An art object on an actor of the view for a while (WorldBridge.artEffect). */
  artEffect?(art: number, target: number, seconds: number): void;
  /** The package an actor of the view runs now (its AI), if any. */
  currentPackage?(reference: number): number | undefined;
  /** The procedure its package runs now, by name (GetCurrentAIProcedure). */
  currentProcedure?(reference: number): string | undefined;
  /**
   * A random scene is about to begin with two actors of the view: whether they may still talk;
   * the view brings them together (undefined: it does not show them).
   */
  randomSceneStarts?(scene: number, first: number, second: number): boolean | undefined;
  /** Whether a speaker of the view faces its target for a line (undefined: not in the view). */
  facesForLine?(speaker: number, target: number): boolean | undefined;
  /** What a save keeps of the view's actors (their stage's: src/save/world-save.ts). */
  saveActors?(): readonly SavedActor[];
  /** What flies in this view (projectiles in flight, runes at rest), for a save. */
  saveProjectiles?(): readonly SavedProjectile[];
  /** The player passes into another cell or worldspace (a loading screen is up). */
  changingSpace?(): boolean;
  /** The regions of the player's cell (IsPlayerInRegion). */
  playerRegions?(): readonly number[];
  /** An impact data set's impact where a ray from a point meets a surface of the view. */
  impactAt?(impactDataSet: number, from: Vec3, direction: Vec3, length: number): boolean;
  /** PathToReference: an actor of the view walks to a reference (undefined: not shown here). */
  pathTo?(actor: number, target: number, walkRun: number): Promise<boolean> | undefined;
  /** EvaluatePackage: the actor chooses its package again (`restart`: anew, as ScriptWorld). */
  evaluatePackage?(reference: number, restart?: boolean): void;
  /** What an actor of the view uses now (its furniture), if anything. */
  interaction?(reference: number): ActorInteraction | undefined;
  /** How an actor of the view (the player too) moves now. */
  motion?(reference: number): ActorMotion | undefined;
  /** PlayIdle: an actor of the view plays an idle (false: the view does not hold it). */
  playIdle?(actor: number, idle: number, target: number | undefined): boolean;
  /** ForceFirstPerson / ForceThirdPerson: the player's camera of the view. */
  pointOfView?(pov: 'first' | 'third'): void;
  /** The camera shakes from a reference's place (none: the player's): Game.ShakeCamera. */
  shakeCamera?(strength: number, seconds: number, source: number | undefined): void;
  /** Splatters of blood on the screen: Game.TriggerScreenBlood. */
  screenBlood?(count: number): void;
  /** Game.ClearTempEffects: the view's temporary effects go (its hits' decals). */
  clearTempEffects?(): void;
  /** Where an actor would use a furniture of the view (its marker), if the view holds it. */
  interactionLocation?(
    furniture: number,
    from: Vec3,
  ): Promise<
    { readonly position: readonly [number, number, number]; readonly heading: number } | undefined
  >;
  /** AddDependentAnimatedObjectReference and its Remove (false: the view does not hold it). */
  dependentAnimated?(reference: number, dependent: number, added: boolean): boolean;
  /** Vehicles and mounts of the view (src/shell/actor-vehicles.ts, actor-mounts.ts). */
  vehicleChanged?(actor: number): void;
  tether?(cart: number, horse: number): void;
  mountOf?(actor: number): number | undefined;
  flyingMount?(
    actor: number,
  ): { readonly patrol: boolean; readonly travelling: boolean } | undefined;
  /** How a flier of the view flies (src/shell/actor-flight.ts). */
  flight?(actor: number): ActorFlightState | undefined;
  riderOf?(horse: number): number | undefined;
  dismount?(actor: number): boolean;
  /** Whether a furniture's marker (any marker, without one) is used by an actor of the view. */
  furnitureInUse?(reference: number, marker?: number): boolean;
  /** The view's fights (src/shell/actor-combat.ts): its actors' and the player's. */
  combat?(): CombatBridge | undefined;
  /** A script's cast the view flies (src/shell/actor-stage.ts launchSpell); false: it cannot. */
  launchSpell?(
    spell: number,
    source: number,
    target: number | undefined,
    blame: number | undefined,
  ): boolean;
}

/** What scripts ask of and tell combat (ActorCombat). */
export interface CombatBridge {
  state(actor: number): ActorCombatState | undefined;
  /** ShouldAttackKill (undefined: neither is one of its fighters). */
  attackKills(attacker: number, target: number): Promise<boolean> | undefined;
  /** IsLastHostileActor (undefined: it plays no part of the player's fights). */
  lastHostileActor(actor: number): boolean | undefined;
  startCombat(actor: number, target: number): void;
  stopCombat(actor: number): void;
  /** Whether an actor fights or holds another an enemy (src/shell/actor-combat-ai.ts). */
  hostile(actor: number, other: number): boolean;
  drawWeapon(actor: number, draw: boolean): void;
  bleedout(actor: number, source: number | undefined): void;
  firstPerson(): boolean;
  /** Knocks an actor down, pushed away from a point (src/shell/actor-knockdowns.ts). */
  knockDown(actor: number, from: Vec3 | undefined, force: number): Promise<void>;
  /** A Stagger effect's magnitude on an actor, from its caster's side. */
  staggerEffect(actor: number, magnitude: number, caster: number | undefined): void;
  /** Paralysis begins or ends on an actor: it lies as its ragdoll meanwhile. */
  paralyze(actor: number, on: boolean): void;
  /** Grab Actor: the target hangs as its ragdoll before its caster while it lasts. */
  grabActor(caster: number | undefined, target: number, on: boolean): void;
  /** Actor.ClearExtraArrows: the arrows stuck in an actor's body go. */
  clearExtraArrows(actor: number): void;
}

/**
 * What the actors of the play on screen notice (src/shell/actor-senses.ts): detection's answers
 * to the scripts, and what the scripts tell it.
 */
export type ScriptSenses = Required<
  Pick<
    WorldBridge,
    | 'lightLevel'
    | 'detects'
    | 'lineOfSight'
    | 'alarmed'
    | 'attacked'
    | 'alerted'
    | 'detectionEvent'
    | 'alarm'
    | 'startSneaking'
    | 'hideFromStealthMeter'
  >
>;

/** SetMotionType's keyframed motion. */
export const MOTION_KEYFRAMED = 4;

export class ScriptWorld implements WorldBridge {
  readonly #views = new Set<ScriptView>();
  readonly #terminal: Terminal;
  #enableQueued = false;

  /** The HUD the notifications go to in Play. */
  readonly hud: HudSignals;

  /**
   * Where actors are asked to look, by kind (src/ai/head-tracking.ts): scripts' SetLookAt and
   * scenes through lookAt; dialogue, combat and AI ask it directly (lookTargets.lookAt). The
   * actors' views read it every frame (src/shell/actor-looks.ts); it outlives them.
   */
  readonly lookTargets = new LookRequests();

  lookAt(actor: number, target: number | undefined, kind: HeadTrackKind = 'script'): void {
    this.lookTargets.lookAt(actor, target, kind);
  }

  headTracking(actor: number, on: boolean): void {
    this.lookTargets.setHeadTracking(actor, on);
  }

  /**
   * The expressions scripts hold on actors' faces (SetExpressionOverride: an mfg expression and
   * its strength 0..100, until ClearExpressionOverride), by actor: the faces read it every
   * frame (src/shell/actor-moods.ts); it outlives them.
   */
  readonly expressionOverrides = new Map<
    number,
    { readonly expression: number; readonly strength: number }
  >();

  expression(actor: number, mood: number | undefined, strength: number): void {
    if (mood === undefined) this.expressionOverrides.delete(actor);
    else this.expressionOverrides.set(actor, { expression: mood, strength });
  }

  /** What an actor says now (the session's lines answer: IsTalking, GetDialogueEmotion, ...). */
  talking: ((actor: number) => Talking | undefined) | undefined;

  /** A line an actor says (Say): the session's line speaker answers. */
  say:
    | ((
        speaker: number,
        topic: number | undefined,
        speakAs: number | undefined,
        inHead: boolean,
      ) => void)
    | undefined;

  /** Game hours pass at once (Game.ServeTime's days in jail): the session answers. */
  passTime: ((hours: number) => Promise<void>) | undefined;

  /** A response of a scene's line (src/shell/scene-lines.ts answers). */
  sceneLine: ((speech: SceneSpeech) => Promise<void> | undefined) | undefined;

  /** Whether the gamepad may rumble (the Vibration setting: [Controls] bGamePadRumble). */
  gamepadRumble: () => boolean = () => true;

  constructor(terminal: Terminal, hud: HudSignals) {
    this.#terminal = terminal;
    this.hud = hud;
  }

  /** A viewer shows references from now on (until the returned function is called). */
  attach(view: ScriptView): () => void {
    this.#views.add(view);
    return () => this.#views.delete(view);
  }

  // Enable states change in bursts (a script disables a dozen markers): the views apply them
  // once, after the scripts' current work.
  enableChanged(): void {
    if (this.#enableQueued) return;
    this.#enableQueued = true;
    queueMicrotask(() => {
      this.#enableQueued = false;
      for (const view of this.#views) view.enableStatesChanged();
    });
  }

  created(reference: number): void {
    for (const view of this.#views) view.created?.(reference);
  }

  moved(reference: number): void {
    for (const view of this.#views) view.moved?.(reference);
  }

  loaded(reference: number): boolean {
    // The player's 3D is loaded where a view has the player (HasLoaded3D: MQ101Scene1 waits
    // for it).
    if (reference === PLAYER_REF) return this.livePlacement(PLAYER_REF) !== undefined;
    for (const view of this.#views) if (view.loaded(reference)) return true;
    return false;
  }

  *loadedReferences(): Iterable<number> {
    for (const view of this.#views) yield* view.loadedReferences();
  }

  livePlacement(reference: number): LivePlacement | undefined {
    for (const view of this.#views) {
      const placement = view.livePlacement?.(reference);
      if (placement) return placement;
    }
    return undefined;
  }

  animationEvent(reference: number, event: string): boolean {
    let handled = false;
    for (const view of this.#views) {
      handled = (view.graphOf?.(reference)?.send(event) ?? false) || handled;
      view.animated?.(reference, event);
    }
    return handled;
  }

  animationVariable(reference: number, name: string): number | undefined {
    for (const view of this.#views) {
      const value = view.graphOf?.(reference)?.variable(name);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  setAnimationVariable(reference: number, name: string, value: number): void {
    for (const view of this.#views) view.graphOf?.(reference)?.setVariable(name, value);
  }

  motionTypeChanged(reference: number, motionType: number): void {
    for (const view of this.#views) view.motionTypeChanged?.(reference, motionType);
  }

  impulse(
    reference: number,
    direction: Vec3,
    magnitude: number,
    share?: (layer: number) => number,
  ): void {
    for (const view of this.#views) view.impulse?.(reference, direction, magnitude, share);
  }

  fireWeapon(weapon: number, source: number, ammo: number | undefined): void {
    for (const view of this.#views) view.fireWeapon?.(weapon, source, ammo);
  }

  ballAndSocket(
    a: number,
    nodeA: string,
    b: number,
    nodeB: string,
    offsetA: readonly [number, number, number],
    offsetB: readonly [number, number, number],
  ): boolean {
    let joined = false;
    for (const view of this.#views)
      joined = view.ballAndSocket?.(a, nodeA, b, nodeB, offsetA, offsetB) === true || joined;
    return joined;
  }

  removeConstraints(a: number, nodeA: string, b: number, nodeB: string): boolean {
    let removed = false;
    for (const view of this.#views)
      removed = view.removeConstraints?.(a, nodeA, b, nodeB) === true || removed;
    return removed;
  }

  explosionPush(
    reference: number,
    center: Vec3,
    push: (layer: number, mass: number) => BodyPush,
  ): void {
    for (const view of this.#views) view.explosionPush?.(reference, center, push);
  }

  explosionReaches(from: Vec3, target: number, buffer: number): boolean | undefined {
    for (const view of this.#views) {
      const reaches = view.explosionReaches?.(from, target, buffer);
      if (reaches !== undefined) return reaches;
    }
    return undefined;
  }

  summonPlace(from: Vec3, to: Vec3, radius: number): Vec3 | undefined {
    for (const view of this.#views) {
      const place = view.summonPlace?.(from, to, radius);
      if (place !== undefined) return place;
    }
    return undefined;
  }

  destructionChanged(reference: number, reached: DestructionStage | undefined): void {
    for (const view of this.#views) view.destructionChanged?.(reference, reached);
  }

  explosion(explosion: number, at: Vec3, source: number | undefined): void {
    // It bursts once, in the view that has its source (the attacker, the object that blew up):
    // the world viewer kept when an interior is played would show it too, never age it, and
    // place its hazards a second time.
    const views = [...this.#views];
    const own =
      source === undefined
        ? undefined
        : (views.find((view) => view.livePlacement?.(source) !== undefined) ??
          views.find((view) => view.loaded(source)));
    for (const view of own ? [own] : views) view.explosion?.(explosion, at, source);
  }

  openChanged(reference: number, open: boolean): void {
    for (const view of this.#views) view.openChanged?.(reference, open);
  }

  triggerCount(reference: number): number {
    let count = 0;
    for (const view of this.#views) count += view.triggerCount?.(reference) ?? 0;
    return count;
  }

  hasNode(reference: number, node: string): boolean {
    for (const view of this.#views) if (view.nodeWorld?.(reference, node)) return true;
    return false;
  }

  nodePlacement(reference: number, node: string): { position: Vec3; rotation: Vec3 } | undefined {
    for (const view of this.#views) {
      const world = view.nodeWorld?.(reference, node);
      if (world) {
        const placement = matrixPlacement(world);
        return { position: placement.position, rotation: placement.rotation };
      }
    }
    return undefined;
  }

  activate(reference: number, activator: number | undefined): void {
    for (const view of this.#views) view.activate?.(reference, activator);
  }

  impactEffect(
    reference: number,
    impactDataSet: number,
    node: string,
    direction: Vec3,
    length: number,
  ): boolean {
    const from =
      (node === '' ? undefined : this.nodePlacement(reference, node)?.position) ??
      this.livePlacement(reference)?.position;
    if (!from) return false;
    for (const view of this.#views) {
      if (view.impactAt?.(impactDataSet, from, direction, length) === true) return true;
    }
    return false;
  }

  /** Actors whose equipment changed, made again together once the scripts' turn is over. */
  readonly #dressing = new Set<number>();

  /**
   * What an actor wears changed (EquipItem, UnequipAll, the inventory): it is made again (once
   * for several changes in a row: a script dressing it piece by piece).
   */
  equipmentChanged(actor: number): void {
    if (this.#dressing.size === 0) {
      setTimeout(() => {
        const actors = [...this.#dressing];
        this.#dressing.clear();
        for (const changed of actors) {
          this.lookChanged(changed).catch((error: unknown) => {
            this.#terminal.log(
              'actor',
              `${changed.toString(16)}: not dressed again: ${error instanceof Error ? error.message : String(error)}`,
              'warn',
            );
          });
        }
      }, 0);
    }
    this.#dressing.add(actor);
  }

  /** Actor.SetRace: the actor is made again in its new race where it is shown. */
  raceChanged(actor: number): Promise<void> {
    return this.lookChanged(actor).catch((error: unknown) => {
      this.#terminal.log(
        'actor',
        `${actor.toString(16)}: not made again in its race: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    });
  }

  /**
   * An actor's look changed (its race; the player's appearance): the views showing it make it
   * again; resolves once they have.
   */
  killed(actor: number, killer?: number, silent = false): void {
    for (const view of this.#views) view.killed?.(actor, killer, silent);
  }

  currentPackage(actor: number): number | undefined {
    for (const view of this.#views) {
      const running = view.currentPackage?.(actor);
      if (running !== undefined) return running;
    }
    return undefined;
  }

  /**
   * What a save keeps of the loaded world (src/save/world-save.ts): every view's actors, and the
   * graphs of the loaded objects that moved from where they started (a lever pulled).
   */
  saveWorld(): WorldSave {
    const actors: SavedActor[] = [];
    const graphs: [number, SavedGraph][] = [];
    const seen = new Set<number>();
    for (const view of this.#views) {
      for (const actor of view.saveActors?.() ?? []) {
        if (seen.has(actor.reference)) continue;
        seen.add(actor.reference);
        actors.push(actor);
      }
    }
    const graphed = new Set<number>();
    for (const view of this.#views) {
      for (const reference of view.loadedReferences()) {
        if (seen.has(reference) || graphed.has(reference)) continue;
        const state = view.graphOf?.(reference)?.save?.();
        if (!state) continue;
        graphed.add(reference);
        graphs.push([reference, state]);
      }
    }
    const projectiles = [...this.#views].flatMap((view) => view.saveProjectiles?.() ?? []);
    return { actors, graphs, ...(projectiles.length > 0 && { projectiles }) };
  }

  savedGraph(reference: number): SavedGraph | undefined {
    for (const view of this.#views) {
      const state = view.graphOf?.(reference)?.save?.();
      if (state) return state;
    }
    return undefined;
  }

  facesForLine(speaker: number, target: number): boolean | undefined {
    for (const view of this.#views) {
      const answer = view.facesForLine?.(speaker, target);
      if (answer !== undefined) return answer;
    }
    return undefined;
  }

  randomSceneStarts(scene: number, first: number, second: number): boolean | undefined {
    for (const view of this.#views) {
      const answer = view.randomSceneStarts?.(scene, first, second);
      if (answer !== undefined) return answer;
    }
    return undefined;
  }

  currentProcedure(actor: number): string | undefined {
    for (const view of this.#views) {
      const procedure = view.currentProcedure?.(actor);
      if (procedure !== undefined) return procedure;
    }
    return undefined;
  }

  changingSpace(): boolean {
    for (const view of this.#views) if (view.changingSpace?.() === true) return true;
    return false;
  }

  /** Whether a look along a direction meets the sun (TESPlayerBowShotEvent's sun gazing). */
  sunGazed(direction: readonly [number, number, number]): boolean {
    for (const view of this.#views) if (view.sunGazed?.(direction) === true) return true;
    return false;
  }

  playerRegions(): readonly number[] {
    return [...this.#views].flatMap((view) => view.playerRegions?.() ?? []);
  }

  pathTo(actor: number, target: number, walkRun: number): Promise<boolean> | undefined {
    for (const view of this.#views) {
      const going = view.pathTo?.(actor, target, walkRun);
      if (going) return going;
    }
    return undefined;
  }

  evaluatePackage(actor: number, restart = false): void {
    for (const view of this.#views) view.evaluatePackage?.(actor, restart);
  }

  interaction(actor: number): ActorInteraction | undefined {
    for (const view of this.#views) {
      const using = view.interaction?.(actor);
      if (using) return using;
    }
    return undefined;
  }

  /** Spell.Cast's projectile, flown by the view that shows its source (the first that can). */
  launchSpell(
    spell: number,
    source: number,
    target: number | undefined,
    blame: number | undefined,
  ): boolean {
    for (const view of this.#views) {
      if (view.loaded(source) || view.livePlacement?.(source) !== undefined) {
        if (view.launchSpell?.(spell, source, target, blame) === true) return true;
      }
    }
    return false;
  }

  pointOfView(pov: 'first' | 'third'): void {
    for (const view of this.#views) view.pointOfView?.(pov);
  }

  shakeCamera(strength: number, seconds: number, source?: number): void {
    for (const view of this.#views) view.shakeCamera?.(strength, seconds, source);
  }

  screenBlood(count: number): void {
    for (const view of this.#views) view.screenBlood?.(count);
  }

  clearTempEffects(): void {
    for (const view of this.#views) view.clearTempEffects?.();
  }

  /** Game.RequestSave / RequestAutoSave: Play saves as soon as it may; elsewhere only noted. */
  requestSave(kind: 'save' | 'autosave'): void {
    if (this.hud.menus?.requestSave) this.hud.menus.requestSave(kind);
    else
      this.#terminal.log(
        'papyrus',
        `a script asks for a${kind === 'save' ? '' : 'n'} ${kind}: saves are made only in Play`,
      );
  }

  /** Game.ShakeController: the player's gamepad rumbles (src/shell/gamepad-input.ts). */
  shakeController(small: number, big: number, seconds: number): void {
    if (this.gamepadRumble()) rumbleGamepad(small, big, seconds);
  }

  playIdle(actor: number, idle: number, target: number | undefined): boolean {
    let played = false;
    for (const view of this.#views)
      played = (view.playIdle?.(actor, idle, target) ?? false) || played;
    return played;
  }

  async interactionLocation(
    furniture: number,
    from: Vec3,
  ): Promise<
    { readonly position: readonly [number, number, number]; readonly heading: number } | undefined
  > {
    for (const view of this.#views) {
      const found = await view.interactionLocation?.(furniture, from);
      if (found) return found;
    }
    return undefined;
  }

  dependentAnimated(reference: number, dependent: number, added: boolean): boolean {
    let took = false;
    for (const view of this.#views)
      took = (view.dependentAnimated?.(reference, dependent, added) ?? false) || took;
    return took;
  }

  vehicleChanged(actor: number): void {
    for (const view of this.#views) view.vehicleChanged?.(actor);
  }

  tether(cart: number, horse: number): void {
    for (const view of this.#views) view.tether?.(cart, horse);
  }

  mountOf(actor: number): number | undefined {
    for (const view of this.#views) {
      const horse = view.mountOf?.(actor);
      if (horse !== undefined) return horse;
    }
    return undefined;
  }

  flyingMount(
    actor: number,
  ): { readonly patrol: boolean; readonly travelling: boolean } | undefined {
    for (const view of this.#views) {
      const mount = view.flyingMount?.(actor);
      if (mount) return mount;
    }
    return undefined;
  }

  flight(actor: number): ActorFlightState | undefined {
    for (const view of this.#views) {
      const flight = view.flight?.(actor);
      if (flight !== undefined) return flight;
    }
    return undefined;
  }

  riderOf(horse: number): number | undefined {
    for (const view of this.#views) {
      const rider = view.riderOf?.(horse);
      if (rider !== undefined) return rider;
    }
    return undefined;
  }

  dismount(actor: number): boolean {
    let done = false;
    for (const view of this.#views) done = (view.dismount?.(actor) ?? false) || done;
    return done;
  }

  motion(actor: number): ActorMotion | undefined {
    for (const view of this.#views) {
      const motion = view.motion?.(actor);
      if (motion) return motion;
    }
    return undefined;
  }

  /** The senses of the play on screen (its actors' detection), while one runs. */
  senses: ScriptSenses | undefined;

  lightLevel(actor: number): number {
    return this.senses?.lightLevel(actor) ?? 0;
  }

  detects(observer: number, target: number): boolean {
    return this.senses?.detects(observer, target) ?? false;
  }

  lineOfSight(viewer: number, target: number): boolean {
    return this.senses?.lineOfSight(viewer, target) ?? false;
  }

  alarmed(actor: number): boolean {
    return this.senses?.alarmed(actor) ?? false;
  }

  attacked(actor: number): boolean {
    return this.senses?.attacked(actor) ?? false;
  }

  alerted(actor: number): boolean {
    return this.senses?.alerted(actor) ?? false;
  }

  detectionEvent(at: number, owner: number | undefined, soundLevel: number): void {
    this.senses?.detectionEvent(at, owner, soundLevel);
  }

  alarm(
    source: number,
    criminal: number | undefined,
    act: 'attack' | 'trespass' | 'steal' | 'stop',
  ): void {
    this.senses?.alarm(source, criminal, act);
  }

  startSneaking(actor: number): void {
    this.senses?.startSneaking(actor);
  }

  hideFromStealthMeter(actor: number, hidden: boolean): void {
    this.senses?.hideFromStealthMeter(actor, hidden);
  }

  /** The fights of the views (their combat). */
  *#fights(): Iterable<CombatBridge> {
    for (const view of this.#views) {
      const fights = view.combat?.();
      if (fights) yield fights;
    }
  }

  combat(actor: number): ActorCombatState | undefined {
    for (const fights of this.#fights()) {
      const state = fights.state(actor);
      if (state) return state;
    }
    return undefined;
  }

  async attackKills(attacker: number, target: number): Promise<boolean> {
    for (const fights of this.#fights()) {
      const kills = fights.attackKills(attacker, target);
      if (kills) return kills;
    }
    return false;
  }

  lastHostileActor(actor: number): boolean {
    for (const fights of this.#fights()) {
      const last = fights.lastHostileActor(actor);
      if (last !== undefined) return last;
    }
    return true;
  }

  startCombat(actor: number, target: number): void {
    for (const fights of this.#fights()) fights.startCombat(actor, target);
  }

  stopCombat(actor: number): void {
    for (const fights of this.#fights()) fights.stopCombat(actor);
  }

  hostile(actor: number, other: number): boolean {
    for (const fights of this.#fights()) if (fights.hostile(actor, other)) return true;
    return false;
  }

  drawWeapon(actor: number, draw: boolean): void {
    for (const fights of this.#fights()) fights.drawWeapon(actor, draw);
  }

  bleedout(actor: number, source: number | undefined): void {
    for (const fights of this.#fights()) fights.bleedout(actor, source);
  }

  firstPerson(): boolean {
    for (const fights of this.#fights()) if (fights.firstPerson()) return true;
    return false;
  }

  /** PushActorAway, KnockAreaEffect, a trap's push: knocked down, away from a reference. */
  pushAway(pushed: number, from: number, force: number): void {
    const at = this.livePlacement(from)?.position;
    for (const fights of this.#fights()) void fights.knockDown(pushed, at && [...at], force);
  }

  /** An explosion's knock-down: knocked down, away from where it burst. */
  knockDown(actor: number, from: Vec3, force: number): void {
    for (const fights of this.#fights()) void fights.knockDown(actor, from, force);
  }

  stagger(actor: number, magnitude: number, caster: number | undefined): void {
    for (const fights of this.#fights()) fights.staggerEffect(actor, magnitude, caster);
  }

  paralyze(actor: number, on: boolean): void {
    for (const fights of this.#fights()) fights.paralyze(actor, on);
  }

  grabActor(caster: number | undefined, target: number, on: boolean): void {
    for (const fights of this.#fights()) fights.grabActor(caster, target, on);
  }

  clearExtraArrows(actor: number): void {
    for (const fights of this.#fights()) fights.clearExtraArrows(actor);
  }

  furnitureInUse(furniture: number, marker?: number): boolean {
    for (const view of this.#views) if (view.furnitureInUse?.(furniture, marker)) return true;
    return false;
  }

  async lookChanged(actor: number): Promise<void> {
    const changing: Promise<void>[] = [];
    for (const view of this.#views) {
      const done = view.lookChanged?.(actor);
      if (done) changing.push(done);
    }
    await Promise.all(changing);
  }

  /** The session's sound system (music types scripts add and remove). */
  sounds: (() => SoundSystem | undefined) | undefined;

  /** A script asked for a sound at a reference (the headless simulation records it). */
  onSound: ((sound: number, source: number) => void) | undefined;

  readonly #playing = new Map<number, Promise<SoundInstance | undefined>>();
  #nextSound = 1;

  /**
   * A sound (SNDR) at a reference where the world shows it (Sound.Play, a magic effect's): it
   * follows the reference as it moves. Its instance id (0: it did not play).
   */
  playSound(sound: number, source: number): number {
    this.onSound?.(sound, source);
    const system = this.sounds?.();
    if (!system || !this.livePlacement(source)) return 0;
    const id = this.#nextSound++;
    let last: Vec3 | undefined;
    const playing = system.play(
      sound,
      () => {
        last = this.livePlacement(source)?.position ?? last;
        return last ?? [0, 0, 0];
      },
      0,
      source,
    );
    this.#playing.set(id, playing);
    void playing.then((instance) => {
      if (!instance) this.#playing.delete(id);
    });
    return id;
  }

  stopSound(id: number): void {
    const playing = this.#playing.get(id);
    this.#playing.delete(id);
    void playing?.then((instance) => instance?.stop());
  }

  /**
   * A magic effect begins or ends on an actor: its sound plays (magic-engine.ts plays it); its
   * hit shader (EFSH), art (ARTO), visuals (RFCT: their art and shader) and light show on it
   * where a view shows it (src/shell/actor-effects.ts), Detect Life on those it finds,
   * Clairvoyance's trail.
   */
  magicEffect(shown: MagicEffectShown): void {
    if (shown.event === 'start' && shown.target === PLAYER_REF)
      this.#terminal.log('magic', `effect ${shown.effect.toString(16)} on the player`);
    for (const view of this.#views) view.magicEffect?.(shown);
  }

  /** EffectShader.Play (seconds; −1 until Stop) and Stop. */
  effectShader(shader: number, target: number, play: boolean, duration: number): void {
    for (const view of this.#views) view.effectShader?.(shader, target, play, duration);
  }

  /** VisualEffect.Play (seconds; −1 until Stop) and Stop (TODO(M13): facing its target). */
  artEffect(art: number, target: number, seconds: number): void {
    for (const view of this.#views) view.artEffect?.(art, target, seconds);
  }

  visualEffect(effect: number, target: number, play: boolean, duration: number): void {
    for (const view of this.#views) view.visualEffect?.(effect, target, play, duration);
  }

  music(type: number, add: boolean): void {
    const music = this.sounds?.()?.music;
    if (add) music?.add(type);
    else music?.remove(type);
  }

  /** The session's image-space modifiers (what ImageSpaceModifier's functions change). */
  modifiers: ScreenModifiers | undefined;

  /** The sky's weather (the session's): what the Weather functions drive and read. */
  sky: SkyWeather | undefined;

  setWeather(weather: number, force: boolean, override: boolean, accelerate: boolean): void {
    if (force) this.sky?.forceWeather(weather, override);
    else this.sky?.setWeather(weather, override, accelerate);
  }

  releaseWeatherOverride(): void {
    this.sky?.releaseOverride();
  }

  currentWeather(): number | undefined {
    return this.sky?.current;
  }

  outgoingWeather(): number | undefined {
    return this.sky?.outgoing;
  }

  weatherTransition(): number {
    return this.sky?.transition ?? 1;
  }

  skyMode(): number {
    return this.sky?.mode ?? SkyMode.full;
  }

  findWeather(classification: number): number | undefined {
    return this.sky?.findWeather(classification);
  }

  windSpeed(): number {
    return this.sky?.windSpeed ?? 0;
  }

  imageSpace(
    modifier: number,
    action: 'apply' | 'remove' | 'crossfade' | 'removeCrossfade' | 'popTo',
    value: number,
    other?: number,
    target?: number,
  ): void {
    const modifiers = this.modifiers;
    if (!modifiers) return;
    switch (action) {
      case 'apply':
        void modifiers.apply(
          modifier,
          value,
          target === undefined ? {} : { target: () => this.livePlacement(target)?.position },
        );
        break;
      case 'remove':
        void modifiers.remove(modifier);
        break;
      case 'crossfade':
        void modifiers.crossFade(modifier, value);
        break;
      case 'removeCrossfade':
        void modifiers.removeCrossFade(value);
        break;
      case 'popTo':
        if (other !== undefined) void modifiers.popTo(modifier, other, value);
        else void modifiers.remove(modifier);
        break;
    }
  }

  /** Debug.Notification: the HUD's notifications (Play), the terminal in the sandbox. */
  notification(text: string): void {
    if (this.hud.listening) this.hud.notification(text);
    else this.#terminal.log('papyrus', text);
  }

  /** A menu a script opens (Play); elsewhere only noted. Resolves once it has closed. */
  menu(request: MenuRequest): Promise<number> {
    if (this.hud.menus) return this.hud.menus.open(request);
    this.#terminal.log('papyrus', `the ${request.name} is opened only in Play`);
    return Promise.resolve(0);
  }

  /** The title cards (Play); elsewhere only noted. */
  titleSequence(action: 'show' | 'hide' | 'start', name?: string): void {
    if (this.hud.screen) this.hud.screen.titles(action, name);
    else this.#terminal.log('papyrus', `title sequence: ${action} ${name ?? ''}`);
  }

  /** Game.PlayBink: the video over the game (Play); elsewhere only noted. */
  video(file: string): void {
    if (this.hud.screen) this.hud.screen.video(file);
    else this.#terminal.log('papyrus', `the video ${file} plays only in Play`);
  }

  /** Game.FadeOutGame: the game's fader (Play); elsewhere only noted. */
  fade(out: boolean, black: boolean, secondsBefore: number, duration: number): void {
    if (this.hud.screen) this.hud.screen.fade(out, black, secondsBefore, duration);
    else this.#terminal.log('papyrus', `the game fades ${out ? 'out' : 'in'} only in Play`);
  }

  /** Game.FastTravel: the player goes there (Play); elsewhere only noted. */
  fastTravel(destination: number): void {
    if (this.hud.menus) this.hud.menus.fastTravel(destination);
    else this.#terminal.log('papyrus', 'fast travel happens only in Play');
  }

  /** Debug.MessageBox, Message.Show: the game's message box (Play), the terminal otherwise. */
  messageBox(text: string, buttons?: readonly string[]): Promise<number> {
    if (this.hud.menus) return this.hud.menus.messageBox(text, buttons ?? []);
    const choices = buttons && buttons.length > 0 ? ` [${buttons.join(' | ')}]` : '';
    this.#terminal.log('papyrus', `${text}${choices}`);
    return Promise.resolve(0);
  }

  /** Message.ShowAsHelpMessage: the HUD's help text (Play), the terminal in the sandbox. */
  helpMessage(text: string, event: string, seconds: number, interval: number, times: number): void {
    if (this.hud.listening) this.hud.helpMessage({ text, event, seconds, interval, times });
    else this.#terminal.log('papyrus', text);
  }

  resetHelpMessage(event: string): void {
    this.hud.resetHelpMessage(event);
  }

  /** A quest's update: the HUD's quest notifications (Play), the terminal in the sandbox. */
  questUpdate(update: QuestUpdate): void {
    if (this.hud.listening) {
      this.hud.questUpdate(update);
      return;
    }
    const what = update.objective
      ? `objective ${update.status}: ${update.objective.text}`
      : `${update.name} ${update.status}`;
    this.#terminal.log('quest', what, update.status === 'failed' ? 'warn' : 'ok');
  }
}

/** A named node of an instance's model in the world (its rest place under the instance). */
export function instanceNodeWorld(
  instance: ModelInstance | undefined,
  node: string,
): Mat4 | undefined {
  const local = instance?.model.nodeWorlds.get(node.toLowerCase());
  return instance && local ? multiply(instance.world, local) : undefined;
}
