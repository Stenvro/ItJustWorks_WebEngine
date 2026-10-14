// Ruffle, the Flash player the game's Scaleform menus run in: loaded on demand from /ruffle/
// (served from its npm package, tools/ruffle-plugin.ts), with the part of its JavaScript API
// the engine uses (https://ruffle.rs, "Using Ruffle", the JavaScript API v1).

/** What a player loads a movie with: its bytes, and the configuration it plays under. */
export interface RuffleLoadOptions {
  readonly data: Uint8Array;
  /** The movie's file name; relative URLs in it (imports, loadMovie) resolve against `base`. */
  readonly swfFileName: string;
  readonly base?: string;
  readonly allowScriptAccess?: boolean;
  /** null: the stage is transparent. */
  readonly backgroundColor?: string | null;
  readonly wmode?: 'window' | 'opaque' | 'transparent' | 'direct' | 'gpu';
  readonly letterbox?: 'off' | 'fullscreen' | 'on';
  readonly scale?: 'showAll' | 'noBorder' | 'exactFit' | 'noScale';
  readonly forceScale?: boolean;
  readonly autoplay?: 'auto' | 'on' | 'off';
  readonly unmuteOverlay?: 'visible' | 'hidden';
  readonly splashScreen?: boolean;
  readonly contextMenu?: 'on' | 'rightClickOnly' | 'off';
  readonly preloader?: boolean;
  readonly quality?: 'low' | 'medium' | 'high' | 'best';
  readonly showSwfDownload?: boolean;
  readonly openUrlMode?: 'allow' | 'confirm' | 'deny';
  readonly logLevel?: 'error' | 'warn' | 'info' | 'debug' | 'trace';
}

export interface RuffleApi {
  load(options: RuffleLoadOptions): Promise<void>;
  play(): void;
  pause(): void;
  /** Calls a function the movie registered with ExternalInterface.addCallback. */
  callExternalInterface(name: string, ...args: unknown[]): unknown;
  /** trace() output and the player's messages. */
  traceObserver: ((message: string) => void) | null;
  readonly isPlaying: boolean;
  volume: number;
}

export interface RufflePlayerElement extends HTMLElement {
  ruffle(version?: number): RuffleApi;
}

interface RuffleSource {
  createPlayer(): RufflePlayerElement;
}

interface RuffleGlobal {
  config?: Record<string, unknown>;
  newest?(): RuffleSource | null;
}

declare global {
  interface Window {
    RufflePlayer?: RuffleGlobal;
  }
}

const BASE = '/ruffle/';
let loading: Promise<RuffleSource> | undefined;

/** Ruffle, loaded once. */
export function loadRuffle(): Promise<RuffleSource> {
  loading ??= new Promise<RuffleSource>((resolve, reject) => {
    const global: RuffleGlobal = window.RufflePlayer ?? {};
    // Its core and WebAssembly lie next to its script; the page polls for no Flash content.
    global.config = { ...global.config, publicPath: BASE, polyfills: false };
    window.RufflePlayer = global;
    const script = document.createElement('script');
    script.src = `${BASE}ruffle.js`;
    script.async = true;
    script.addEventListener('load', () => {
      const source = window.RufflePlayer?.newest?.();
      if (source) resolve(source);
      else reject(new Error('Ruffle loaded without a player'));
    });
    script.addEventListener('error', () => {
      reject(new Error('Ruffle could not be loaded'));
    });
    document.head.append(script);
  });
  return loading;
}
