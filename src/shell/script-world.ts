// The running game's scripts and the world on screen: what scripts do (enable, move, animate,
// push, activate references, show messages, play sounds, put image-space modifiers on the
// screen) reaches the viewers that show those references, and what the scripts ask of the
// world (which references are loaded, where a moving one is now) comes from them. The script
// runtime's WorldBridge.

import type { Vec3 } from '../scripting/runtime/game-state.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { MagicEffectShown } from '../scripting/runtime/magic-engine.ts';
import type { SceneSpeech } from '../scripting/runtime/scene-host.ts';
import type {
  ActorCombatState,
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
import type { ScriptGraph } from '../animation/script-graphs.ts';
import type { ScreenModifiers } from './screen-modifiers.ts';
import type { Terminal } from './terminal.ts';
import type { HudSignals } from './hud-signals.ts';
import type { Talking } from './world-lines.ts';
import { LookRequests, type HeadTrackKind } from '../ai/head-tracking.ts';

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
  /** SetMotionType (1 dynamic .. 4 keyframed). */
  motionTypeChanged?(reference: number, motionType: number): void;
  impulse?(reference: number, direction: Vec3, magnitude: number): void;
  /** How many are inside a reference's trigger volume now. */
  triggerCount?(reference: number): number;
  /** A named node of a shown reference's model: where it is in the world. */
  nodeWorld?(reference: number, node: string): Mat4 | undefined;
  /** What activating a reference does by default (a script's Activate). */
  activate?(reference: number): void;
  /**
   * An actor's look changed (Actor.SetRace; the player's appearance in the race menu): the
   * view makes its 3D again; resolves once it shows the new look.
   */
  lookChanged?(reference: number): Promise<void>;
  /** An actor died: the view lays it down as its ragdoll (its pose follows its bodies). */
  killed?(reference: number): void;
  /** The package an actor of the view runs now (its AI), if any. */
  currentPackage?(reference: number): number | undefined;
  /** EvaluatePackage: the actor chooses its package again. */
  evaluatePackage?(reference: number): void;
  /** What an actor of the view uses now (its furniture), if anything. */
  interaction?(reference: number): ActorInteraction | undefined;
  /** How an actor of the view (the player too) moves now. */
  motion?(reference: number): ActorMotion | undefined;
  /** PlayIdle: an actor of the view plays an idle (false: the view does not hold it). */
  playIdle?(actor: number, idle: number, target: number | undefined): boolean;
  /** Vehicles and mounts of the view (src/shell/actor-vehicles.ts, actor-mounts.ts). */
  vehicleChanged?(actor: number): void;
  tether?(cart: number, horse: number): void;
  mountOf?(actor: number): number | undefined;
  riderOf?(horse: number): number | undefined;
  dismount?(actor: number): boolean;
  /** Whether a furniture's marker (any marker, without one) is used by an actor of the view. */
  furnitureInUse?(reference: number, marker?: number): boolean;
  /** The view's fights (src/shell/actor-combat.ts): its actors' and the player's. */
  combat?(): CombatBridge | undefined;
}

/** What scripts ask of and tell combat (ActorCombat). */
export interface CombatBridge {
  state(actor: number): ActorCombatState | undefined;
  startCombat(actor: number, target: number): void;
  stopCombat(actor: number): void;
  drawWeapon(actor: number, draw: boolean): void;
  bleedout(actor: number, source: number | undefined): void;
  firstPerson(): boolean;
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

  /** A response of a scene's line (src/shell/scene-lines.ts answers). */
  sceneLine: ((speech: SceneSpeech) => Promise<void> | undefined) | undefined;

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
    for (const view of this.#views)
      handled = (view.graphOf?.(reference)?.send(event) ?? false) || handled;
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

  impulse(reference: number, direction: Vec3, magnitude: number): void {
    for (const view of this.#views) view.impulse?.(reference, direction, magnitude);
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

  activate(reference: number): void {
    for (const view of this.#views) view.activate?.(reference);
  }

  /** Actor.SetRace: the actor is made again in its new race where it is shown. */
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

  raceChanged(actor: number): void {
    this.lookChanged(actor).catch((error: unknown) => {
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
  killed(actor: number): void {
    for (const view of this.#views) view.killed?.(actor);
  }

  currentPackage(actor: number): number | undefined {
    for (const view of this.#views) {
      const running = view.currentPackage?.(actor);
      if (running !== undefined) return running;
    }
    return undefined;
  }

  evaluatePackage(actor: number): void {
    for (const view of this.#views) view.evaluatePackage?.(actor);
  }

  interaction(actor: number): ActorInteraction | undefined {
    for (const view of this.#views) {
      const using = view.interaction?.(actor);
      if (using) return using;
    }
    return undefined;
  }

  playIdle(actor: number, idle: number, target: number | undefined): boolean {
    let played = false;
    for (const view of this.#views)
      played = (view.playIdle?.(actor, idle, target) ?? false) || played;
    return played;
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

  startCombat(actor: number, target: number): void {
    for (const fights of this.#fights()) fights.startCombat(actor, target);
  }

  stopCombat(actor: number): void {
    for (const fights of this.#fights()) fights.stopCombat(actor);
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

  readonly #playing = new Map<number, Promise<SoundInstance | undefined>>();
  #nextSound = 1;

  /**
   * A sound (SNDR) at a reference where the world shows it (Sound.Play, a magic effect's): it
   * follows the reference as it moves. Its instance id (0: it did not play).
   */
  playSound(sound: number, source: number): number {
    const system = this.sounds?.();
    if (!system || !this.livePlacement(source)) return 0;
    const id = this.#nextSound++;
    let last: Vec3 | undefined;
    const playing = system.play(sound, () => {
      last = this.livePlacement(source)?.position ?? last;
      return last ?? [0, 0, 0];
    });
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
   * hit shader (EFSH), art (ARTO), visuals (RFCT) and light are not drawn yet. TODO(M11)
   * visuals: effect shaders and art objects on actors, lights that follow them.
   */
  magicEffect(shown: MagicEffectShown): void {
    if (shown.event === 'start' && shown.target === PLAYER_REF)
      this.#terminal.log('magic', `effect ${shown.effect.toString(16)} on the player`);
  }

  music(type: number, add: boolean): void {
    const music = this.sounds?.()?.music;
    if (add) music?.add(type);
    else music?.remove(type);
  }

  /** The session's image-space modifiers (what ImageSpaceModifier's functions change). */
  modifiers: ScreenModifiers | undefined;

  imageSpace(
    modifier: number,
    action: 'apply' | 'remove' | 'crossfade' | 'removeCrossfade' | 'popTo',
    value: number,
    other?: number,
  ): void {
    const modifiers = this.modifiers;
    if (!modifiers) return;
    switch (action) {
      case 'apply':
        void modifiers.apply(modifier, value);
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
