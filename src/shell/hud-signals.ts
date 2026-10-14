// What the game tells its HUD as it plays: the activation target under the crosshair, the
// notifications scripts post (Debug.Notification), messages, subtitles. The play session and
// the scripts' world send here; in Play the HUD (the game's hudmenu.swf, hud-controller.ts)
// listens, and the sandbox shows them its own way (the prompt, the terminal).

export interface HudTarget {
  /** "Open", "Take", ... */
  readonly verb: string;
  /** What it is (a door's destination, an item's name). */
  readonly name: string;
}

export interface HudSink {
  target(target: HudTarget | undefined): void;
  notification(text: string): void;
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
}
