// The screen blood of a game (src/render/screen-blood-data.ts): splattered when the player takes
// a hit that bleeds (src/shell/actor-combat.ts) or a script calls Game.TriggerScreenBlood, drawn
// by the renderer over the finished image with the textures the GMSTs name.

import type { ScreenBloodFrame } from '../render/screen-blood.ts';
import { ScreenBlood, screenBloodSettings } from '../render/screen-blood-data.ts';
import type { TextureCache } from '../render/texture-cache.ts';
import type { GameSettings } from '../world/game-settings.ts';

const TEXTURES = {
  shape: ['sBloodSplatterAlpha01OPTFilename', 'textures\\blood\\screenbloodalpha01opt.dds'],
  color: ['sBloodSplatterColor01OPTFilename', 'textures\\blood\\screenbloodcolor01opt.dds'],
  flare: ['sBloodSplatterFlare01Filename', 'textures\\blood\\fxbloodflare.dds'],
} as const;

/** A texture path as the GMSTs give it (relative to textures\, or with it). */
export function bloodTexturePath(path: string): string {
  const lower = path.replace(/\//g, '\\').toLowerCase();
  return lower.startsWith('textures\\') ? lower : `textures\\${lower}`;
}

export class ScreenBloodView {
  readonly #settings: Promise<GameSettings>;
  readonly #textures: TextureCache;
  readonly #now: () => number;
  #blood: ScreenBlood | undefined;
  #loaded: { shape?: GPUTexture; color?: GPUTexture; flare?: GPUTexture } | undefined;
  #loading = false;

  constructor(
    settings: Promise<GameSettings>,
    textures: TextureCache,
    now: () => number = () => performance.now() / 1000,
  ) {
    this.#settings = settings;
    this.#textures = textures;
    this.#now = now;
    void settings.then((gmst) => {
      this.#blood ??= new ScreenBlood(screenBloodSettings((name) => gmst.number(name)));
    });
  }

  /** Puts `count` splatters on the screen. */
  splatter(count: number): void {
    if (!(count > 0)) return;
    this.#blood ??= new ScreenBlood();
    this.#blood.splatter(count, this.#now());
  }

  clear(): void {
    this.#blood?.clear();
  }

  /** What the renderer draws now; undefined: nothing (or its textures still load). */
  frame(): ScreenBloodFrame | undefined {
    const blood = this.#blood;
    if (!blood || blood.count === 0) return undefined;
    const splats = blood.frame(this.#now());
    if (splats.length === 0) return undefined;
    const textures = this.#loaded;
    if (!textures) {
      this.#load();
      return undefined;
    }
    if (!textures.shape || !textures.color) return undefined;
    return { shape: textures.shape, color: textures.color, flare: textures.flare, splats };
  }

  #load(): void {
    if (this.#loading) return;
    this.#loading = true;
    void (async () => {
      const gmst = await this.#settings;
      const get = async ([name, fallback]: readonly [string, string]) => {
        const path = bloodTexturePath((gmst.string(name) ?? '') || fallback);
        return this.#textures.get(path, true).catch(() => undefined);
      };
      const [shape, color, flare] = await Promise.all([
        get(TEXTURES.shape),
        get(TEXTURES.color),
        get(TEXTURES.flare),
      ]);
      this.#loaded = {
        ...(shape && { shape }),
        ...(color && { color }),
        ...(flare && { flare }),
      };
    })();
  }
}
