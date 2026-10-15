// The running game's scripts and the world on screen: what scripts do (enable, move, animate,
// push, activate references, show messages, play sounds, put image-space modifiers on the
// screen) reaches the viewers that show those references, and what the scripts ask of the
// world (which references are loaded, where a moving one is now) comes from them. The script
// runtime's WorldBridge.

import type { Vec3 } from '../scripting/runtime/game-state.ts';
import type {
  LivePlacement,
  MenuRequest,
  QuestUpdate,
  WorldBridge,
} from '../scripting/runtime/runtime.ts';
import { multiply, type Mat4 } from '../render/math.ts';
import type { ModelInstance } from '../render/scene-renderer.ts';
import { matrixPlacement } from '../world/cell-loader.ts';
import type { SoundSystem } from '../audio/sound-system.ts';
import type { ScriptGraph } from '../animation/script-graphs.ts';
import type { ScreenModifiers } from './screen-modifiers.ts';
import type { Terminal } from './terminal.ts';
import type { HudSignals } from './hud-signals.ts';

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
}

/** SetMotionType's keyframed motion. */
export const MOTION_KEYFRAMED = 4;

export class ScriptWorld implements WorldBridge {
  readonly #views = new Set<ScriptView>();
  readonly #terminal: Terminal;
  #enableQueued = false;

  /** The HUD the notifications go to in Play. */
  readonly hud: HudSignals;

  /** A line an actor says (Say): the session's line speaker answers. */
  say:
    | ((
        speaker: number,
        topic: number | undefined,
        speakAs: number | undefined,
        inHead: boolean,
      ) => void)
    | undefined;

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

  /** The session's sound system (music types scripts add and remove). */
  sounds: (() => SoundSystem | undefined) | undefined;

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
