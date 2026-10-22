// Blood on a weapon (docs/rendering.md, "Weapon blood"; the engine's BSTempEffectWeaponBlood): a
// melee hit on flesh shows the weapon model's hidden blood shapes (ModelPart.weaponBlood), fresh
// for fWeaponBloodLifetime seconds, then drying away over fWeaponBloodFadeDuration: the blood
// shader's cutoff rises from 0 to 1, so the thin parts of its mask (the texture's green) go
// first and the thick drops last, with an edge of fWeaponBloodFalloffThreshold; the wet sheen
// (the lighting blood shape) fades with it. Another hit makes it fresh again.
// TODO(M13): the engine's own curve (how it drives the effect's AlphaTestRef and the lighting
// shape's alpha from its blend amount) is not documented; this is the straight reading of the
// three settings. Platform-independent.

/** The settings it follows (CombatSettings' weapon blood). */
export interface WeaponBloodSettings {
  readonly weaponBloodLifetime: number;
  readonly weaponBloodFadeDuration: number;
  readonly weaponBloodFalloffThreshold: number;
}

/**
 * How far blood `age` seconds old has dried: 0 fresh .. 1 gone (the blood shader's cutoff).
 */
export function weaponBloodCutoff(age: number, settings: WeaponBloodSettings): number {
  if (!(age >= 0)) return 1;
  const fresh = Math.max(0, settings.weaponBloodLifetime);
  if (age <= fresh) return 0;
  const fade = settings.weaponBloodFadeDuration;
  return fade > 0 ? Math.min(1, (age - fresh) / fade) : 1;
}

/** One weapon's blood: what its blood shapes show (src/render/scene-renderer.ts's level). */
export class WeaponBlood {
  /** The blood shader's cutoff (1: no blood). */
  cutoff = 1;
  /** Its soft edge. */
  falloff: number;
  /** The wet sheen's alpha. */
  sheen = 0;
  /** Bumped whenever the values above change. */
  version = 0;
  #age = Infinity;
  readonly #settings: WeaponBloodSettings;

  constructor(settings: WeaponBloodSettings) {
    this.#settings = settings;
    this.falloff = settings.weaponBloodFalloffThreshold;
  }

  /** Bloodied: the weapon struck flesh. */
  hit(): void {
    this.#age = 0;
    this.#set();
  }

  /** Time passes (seconds). */
  advance(seconds: number): void {
    if (this.#age === Infinity || seconds <= 0) return;
    this.#age += seconds;
    if (this.#age > this.#settings.weaponBloodLifetime + this.#settings.weaponBloodFadeDuration)
      this.#age = Infinity;
    this.#set();
  }

  #set(): void {
    const cutoff = weaponBloodCutoff(this.#age, this.#settings);
    const falloff = this.#settings.weaponBloodFalloffThreshold;
    if (cutoff === this.cutoff && falloff === this.falloff) return;
    this.cutoff = cutoff;
    this.falloff = falloff;
    this.sheen = 1 - cutoff;
    this.version++;
  }
}
