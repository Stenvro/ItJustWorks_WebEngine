// What the game tells its HUD as it plays: the activation target under the crosshair, the
// notifications scripts post (Debug.Notification), quest updates, help messages, and the user
// events the player presses (a help message waits for one). The play session and the scripts'
// world send here; in Play the HUD (the game's hudmenu.swf, hud-controller.ts) listens, and the
// sandbox shows them its own way (the prompt, the terminal).

import type { QuestUpdate } from '../scripting/runtime/runtime.ts';

export interface HudTarget {
  /** "Open", "Take", ... */
  readonly verb: string;
  /** What it is (a door's destination, an item's name). */
  readonly name: string;
}

/** Message.ShowAsHelpMessage's: shown for `seconds` every `interval`, at most `times` times. */
export interface HelpMessage {
  readonly text: string;
  /** The user event that ends it ("Activate", "Jump", ...). */
  readonly event: string;
  readonly seconds: number;
  readonly interval: number;
  readonly times: number;
}

export interface HudSink {
  target(target: HudTarget | undefined): void;
  notification(text: string): void;
  questUpdate(update: QuestUpdate): void;
  helpMessage(message: HelpMessage): void;
  resetHelpMessage(event: string): void;
  userEvent(name: string): void;
}

export class HudSignals {
  /** The HUD listening (Play), if any. */
  sink: HudSink | undefined;

  /** Whether a HUD shows these (the sandbox's own prompt and notices then stay quiet). */
  get listening(): boolean {
    return this.sink !== undefined;
  }

  target(target: HudTarget | undefined): void {
    this.sink?.target(target);
  }

  notification(text: string): void {
    this.sink?.notification(text);
  }

  questUpdate(update: QuestUpdate): void {
    this.sink?.questUpdate(update);
  }

  helpMessage(message: HelpMessage): void {
    this.sink?.helpMessage(message);
  }

  resetHelpMessage(event: string): void {
    this.sink?.resetHelpMessage(event);
  }

  userEvent(name: string): void {
    this.sink?.userEvent(name);
  }
}
