// Screen blood: when the player takes a bleeding hit (or a script calls Game.TriggerScreenBlood),
// splatters of blood land on the screen and fade. Each splatter has a size (a share of the
// screen's height) between fBloodSplatterMinSize and fBloodSplatterMaxSize and an opacity between
// fBloodSplatterMinOpacity and fBloodSplatterMaxOpacity, or (fBloodSplatterOpacityChance of them)
// between fBloodSplatterMinOpacity2 and fBloodSplatterMaxOpacity2; it lasts fBloodSplatterDuration
// seconds, full until fBloodSplatterFadeStart of its life, then fading out. At most
// iBloodSplatterMaxCount show at once (the oldest go first). A flare (fxbloodflare.dds) glints on
// each, fBloodSplatterFlareSize of the screen, offset from the splatter's middle by
// fBloodSplatterFlareOffsetScale of its size, at fBloodSplatterFlareMult of its opacity. The
// textures are the GMSTs sBloodSplatterAlpha01OPTFilename (the splatter's shape),
// sBloodSplatterColor01OPTFilename (its colour) and sBloodSplatterFlare01Filename.
// Platform-independent.
//
// TODO(M13): the engine's exact reading of the settings (whether the duration is in seconds and
// the fade start a share of it, the flare's direction) is not read from the executable; these
// follow the settings' names and values.

/** The screen blood's settings (GMSTs), with the vanilla values as defaults. */
export interface ScreenBloodSettings {
  readonly maxCount: number;
  readonly minSize: number;
  readonly maxSize: number;
  readonly minOpacity: number;
  readonly maxOpacity: number;
  readonly minOpacity2: number;
  readonly maxOpacity2: number;
  readonly opacityChance: number;
  readonly duration: number;
  readonly fadeStart: number;
  readonly flareSize: number;
  readonly flareOffsetScale: number;
  readonly flareMult: number;
}

export const SCREEN_BLOOD_DEFAULTS: ScreenBloodSettings = {
  maxCount: 25,
  minSize: 0.12,
  maxSize: 0.18,
  minOpacity: 0.5,
  maxOpacity: 1,
  minOpacity2: 0.3,
  maxOpacity2: 0.6,
  opacityChance: 0.3,
  duration: 20,
  fadeStart: 0.4,
  flareSize: 0.065,
  flareOffsetScale: 0.45,
  flareMult: 0.95,
};

/** The settings from the game settings (a GMST's number by name, if it has one). */
export function screenBloodSettings(
  setting: (name: string) => number | undefined,
): ScreenBloodSettings {
  const d = SCREEN_BLOOD_DEFAULTS;
  const f = (name: string, fallback: number): number => setting(name) ?? fallback;
  return {
    maxCount: Math.max(0, Math.floor(f('iBloodSplatterMaxCount', d.maxCount))),
    minSize: f('fBloodSplatterMinSize', d.minSize),
    maxSize: f('fBloodSplatterMaxSize', d.maxSize),
    minOpacity: f('fBloodSplatterMinOpacity', d.minOpacity),
    maxOpacity: f('fBloodSplatterMaxOpacity', d.maxOpacity),
    minOpacity2: f('fBloodSplatterMinOpacity2', d.minOpacity2),
    maxOpacity2: f('fBloodSplatterMaxOpacity2', d.maxOpacity2),
    opacityChance: f('fBloodSplatterOpacityChance', d.opacityChance),
    duration: f('fBloodSplatterDuration', d.duration),
    fadeStart: f('fBloodSplatterFadeStart', d.fadeStart),
    flareSize: f('fBloodSplatterFlareSize', d.flareSize),
    flareOffsetScale: f('fBloodSplatterFlareOffsetScale', d.flareOffsetScale),
    flareMult: f('fBloodSplatterFlareMult', d.flareMult),
  };
}

/** One splatter as it is drawn now: its middle and size (screen 0..1, size of the height). */
export interface SplatDraw {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** Turned by (radians). */
  readonly rotation: number;
  readonly alpha: number;
  /** The flare's middle, size and alpha (0: no flare). */
  readonly flareX: number;
  readonly flareY: number;
  readonly flareSize: number;
  readonly flareAlpha: number;
}

interface Splat {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly rotation: number;
  readonly opacity: number;
  readonly born: number;
  /** The flare's way from the middle (radians). */
  readonly flareAngle: number;
}

/** How much of a splatter's opacity shows at an age (seconds): full, then fading to nothing. */
export function splatFade(age: number, settings: ScreenBloodSettings): number {
  const duration = Math.max(settings.duration, 1e-3);
  if (age < 0 || age >= duration) return 0;
  const start = Math.min(Math.max(settings.fadeStart, 0), 1) * duration;
  if (age <= start) return 1;
  return 1 - (age - start) / Math.max(duration - start, 1e-3);
}

/**
 * How many splatters a hit on the player puts on the screen: one, two for a power attack.
 * TODO(M13): the engine's count per hit is not documented.
 */
export function splattersForHit(heavy: boolean): number {
  return heavy ? 2 : 1;
}

/** The splatters on the screen. */
export class ScreenBlood {
  readonly #settings: ScreenBloodSettings;
  readonly #splats: Splat[] = [];

  constructor(settings: ScreenBloodSettings = SCREEN_BLOOD_DEFAULTS) {
    this.#settings = settings;
  }

  get count(): number {
    return this.#splats.length;
  }

  /** Puts `count` splatters on the screen at `now` (seconds). */
  splatter(count: number, now: number, random: () => number = Math.random): void {
    const s = this.#settings;
    const between = (a: number, b: number): number => a + (b - a) * random();
    for (let i = 0; i < Math.floor(count); i++) {
      const second = random() < s.opacityChance;
      this.#splats.push({
        // Kept off the very edges, so most of a splatter shows.
        x: between(0.1, 0.9),
        y: between(0.1, 0.9),
        size: between(s.minSize, s.maxSize),
        rotation: between(0, Math.PI * 2),
        opacity: second
          ? between(s.minOpacity2, s.maxOpacity2)
          : between(s.minOpacity, s.maxOpacity),
        born: now,
        flareAngle: between(0, Math.PI * 2),
      });
    }
    const over = this.#splats.length - s.maxCount;
    if (over > 0) this.#splats.splice(0, over);
  }

  /** The splatters as they show at `now` (those past their time go). */
  frame(now: number): SplatDraw[] {
    const s = this.#settings;
    const out: SplatDraw[] = [];
    for (let i = this.#splats.length - 1; i >= 0; i--) {
      const splat = this.#splats[i];
      if (!splat) continue;
      const fade = splatFade(now - splat.born, s);
      if (fade <= 0 && now - splat.born >= 0) {
        this.#splats.splice(i, 1);
        continue;
      }
      const alpha = splat.opacity * fade;
      const offset = splat.size * s.flareOffsetScale;
      out.unshift({
        x: splat.x,
        y: splat.y,
        size: splat.size,
        rotation: splat.rotation,
        alpha,
        flareX: splat.x + Math.cos(splat.flareAngle) * offset,
        flareY: splat.y + Math.sin(splat.flareAngle) * offset,
        flareSize: s.flareSize,
        flareAlpha: alpha * s.flareMult,
      });
    }
    return out;
  }

  clear(): void {
    this.#splats.length = 0;
  }
}
