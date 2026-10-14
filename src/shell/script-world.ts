// The running game's scripts and the world on screen: what scripts do (enable, move, animate,
// push, activate references, show messages, play sounds) reaches the viewers that show those
// references, and what the scripts ask of the world (which references are loaded, where a
// moving one is now) comes from them. The script runtime's WorldBridge.

import type { Vec3 } from '../scripting/runtime/game-state.ts';
import type { WorldBridge } from '../scripting/runtime/runtime.ts';
import type { Terminal } from './terminal.ts';

/** A viewer that shows references to the scripts (the interior or the world viewer). */
export interface ScriptView {
  /** The references whose 3D is loaded now. */
  loadedReferences(): Iterable<number>;
  loaded(reference: number): boolean;
  /** Where a loaded reference is now (moving objects, actors); undefined if not shown here. */
  livePlacement?(reference: number): { position: Vec3; rotation?: Vec3 } | undefined;
  /** Scripts changed what is enabled: the view applies the new states. */
  enableStatesChanged(): void;
  /** A script moved or scaled a reference. */
  moved?(reference: number): void;
  /** A behavior graph or NIF sequence event (PlayAnimation): false if it has none. */
  animationEvent?(reference: number, event: string): boolean;
  /** SetMotionType (1 dynamic .. 4 keyframed). */
  motionTypeChanged?(reference: number, motionType: number): void;
  impulse?(reference: number, direction: Vec3, magnitude: number): void;
  /** What activating a reference does by default (a script's Activate). */
  activate?(reference: number): void;
}

/** SetMotionType's keyframed motion. */
export const MOTION_KEYFRAMED = 4;

export class ScriptWorld implements WorldBridge {
  readonly #views = new Set<ScriptView>();
  readonly #terminal: Terminal;
  #enableQueued = false;

  constructor(terminal: Terminal) {
    this.#terminal = terminal;
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

  livePlacement(reference: number): { position: Vec3; rotation?: Vec3 } | undefined {
    for (const view of this.#views) {
      const placement = view.livePlacement?.(reference);
      if (placement) return placement;
    }
    return undefined;
  }

  animationEvent(reference: number, event: string): boolean {
    let handled = false;
    for (const view of this.#views)
      handled = (view.animationEvent?.(reference, event) ?? false) || handled;
    return handled;
  }

  motionTypeChanged(reference: number, motionType: number): void {
    for (const view of this.#views) view.motionTypeChanged?.(reference, motionType);
  }

  impulse(reference: number, direction: Vec3, magnitude: number): void {
    for (const view of this.#views) view.impulse?.(reference, direction, magnitude);
  }

  activate(reference: number): void {
    for (const view of this.#views) view.activate?.(reference);
  }

  // TODO(M9): the HUD's notifications and the game's message boxes; until then the terminal.
  notification(text: string): void {
    this.#terminal.log('papyrus', text);
  }

  messageBox(text: string, buttons?: readonly string[]): Promise<number> {
    const choices = buttons && buttons.length > 0 ? ` [${buttons.join(' | ')}]` : '';
    this.#terminal.log('papyrus', `${text}${choices}`);
    return Promise.resolve(0);
  }

  helpMessage(text: string): void {
    this.#terminal.log('papyrus', text);
  }

  objective(_quest: number, _index: number, text: string): void {
    this.#terminal.log('quest', `objective: ${text}`, 'ok');
  }
}
