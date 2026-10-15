// The active image-space modifiers and what they make of an imagespace, as the engine's
// ImageSpaceManager keeps them: modifiers applied at a strength (Apply, Remove, PopTo), the
// cross-fade chain (ApplyCrossFade, RemoveCrossFade), their timelines, and the imagespace and
// screen effects that result each frame. Platform-independent.
// Combining (Creation Kit, "ImageSpace Modifiers"): most values are multiplied and added to;
// the tint colour is the average of the modifiers' tints weighted by their alpha, with the
// highest alpha as the amount; blur radius and double vision are the highest of any modifier.
// Notes: docs/rendering.md ("Image-space modifiers").

import {
  NO_SCREEN_EFFECTS,
  type ImageSpace,
  type ImageSpaceHdr,
  type ScreenEffects,
} from './image-space.ts';
import {
  evaluateModifier,
  modifierFinished,
  modifierKeyTime,
  type ImageSpaceModifier,
  type ModifierFrame,
  type MultAdd,
  type Rgba,
} from './image-space-modifier.ts';
import type { Rgb } from './weather.ts';

interface Instance {
  readonly modifier: ImageSpaceModifier;
  strength: number;
  /** Seconds since it was applied. */
  age: number;
  readonly loop: boolean;
  /** Cross-fade weight (1 for applied modifiers) and where and how fast it is heading. */
  fade: number;
  fadeTarget: number;
  /** Change of `fade` per second (Infinity: at once). */
  fadeRate: number;
}

/** An active modifier as the dev panel and logs show it. */
export interface ActiveModifier {
  readonly formId: number;
  readonly editorId: string;
  /** Strength times cross-fade weight. */
  readonly weight: number;
  /** Where on its timeline it is (0..1). */
  readonly time: number;
  readonly crossFade: boolean;
}

export interface ApplyOptions {
  /**
   * Start an animated modifier over when its duration has passed instead of ending it (for
   * engine callers that keep one up, e.g. a magic effect's for its duration).
   * TODO(M11): check which engine callers loop.
   */
  readonly loop?: boolean;
}

const HDR_KEYS: readonly (keyof ImageSpaceHdr)[] = [
  'eyeAdaptSpeed',
  'bloomBlurRadius',
  'bloomThreshold',
  'bloomScale',
  'receiveBloomThreshold',
  'white',
  'sunlightScale',
  'skyScale',
  'eyeAdaptStrength',
];

const rateFor = (seconds: number): number => (seconds > 0 ? 1 / seconds : Infinity);

/** Sends a cross-fade weight towards `target` at `rate` per second (at once if infinite). */
function head(instance: Instance, target: number, rate: number): void {
  instance.fadeTarget = target;
  instance.fadeRate = rate;
  if (rate === Infinity) instance.fade = target;
}

export class ImageSpaceModifiers {
  /** Modifiers applied by Apply / PopTo, by form id. */
  readonly #applied = new Map<number, Instance>();
  /** The cross-fade chain: the last is shown, those before it faded out (or fading). */
  readonly #chain: Instance[] = [];
  /** Removed from the chain, fading out. */
  #leaving: Instance[] = [];

  /** Whether any modifier is active. */
  get empty(): boolean {
    return this.#applied.size === 0 && this.#chain.length === 0 && this.#leaving.length === 0;
  }

  /** The active modifiers (applied, then the cross-fade chain). */
  get active(): readonly ActiveModifier[] {
    const list = (instances: Iterable<Instance>, crossFade: boolean): ActiveModifier[] =>
      [...instances].map((instance) => ({
        formId: instance.modifier.formId,
        editorId: instance.modifier.editorId,
        weight: instance.strength * instance.fade,
        time: modifierKeyTime(instance.modifier, instance.age, instance.loop),
        crossFade,
      }));
    return [
      ...list(this.#applied.values(), false),
      ...list(this.#chain, true),
      ...list(this.#leaving, true),
    ];
  }

  isActive(formId: number): boolean {
    return (
      this.#applied.has(formId) ||
      this.#chain.some((instance) => instance.modifier.formId === formId) ||
      this.#leaving.some((instance) => instance.modifier.formId === formId)
    );
  }

  /** ImageSpaceModifier.Apply: shows the modifier at a strength (again from its start). */
  apply(modifier: ImageSpaceModifier, strength = 1, options: ApplyOptions = {}): void {
    this.#applied.set(modifier.formId, {
      modifier,
      strength,
      age: 0,
      loop: options.loop ?? false,
      fade: 1,
      fadeTarget: 1,
      fadeRate: Infinity,
    });
  }

  /** ImageSpaceModifier.Remove: takes the modifier off the screen at once (also the chain's). */
  remove(formId: number): void {
    this.#applied.delete(formId);
    const top = this.#chain.at(-1);
    const kept = this.#chain.filter((instance) => instance.modifier.formId !== formId);
    this.#chain.splice(0, this.#chain.length, ...kept);
    this.#leaving = this.#leaving.filter((instance) => instance.modifier.formId !== formId);
    const newTop = this.#chain.at(-1);
    if (newTop && newTop !== top) {
      newTop.fade = 1;
      newTop.fadeTarget = 1;
    }
  }

  /**
   * ImageSpaceModifier.ApplyCrossFade: puts the modifier on the cross-fade chain, fading from
   * the chain's last modifier to it over `seconds`.
   */
  applyCrossFade(modifier: ImageSpaceModifier, seconds: number): void {
    const rate = rateFor(seconds);
    const top = this.#chain.at(-1);
    if (top?.modifier.formId === modifier.formId) {
      head(top, 1, rate);
      return;
    }
    const index = this.#chain.findIndex((instance) => instance.modifier.formId === modifier.formId);
    const earlier = index >= 0 ? this.#chain.splice(index, 1)[0] : undefined;
    const leaving = this.#leaving.find((instance) => instance.modifier.formId === modifier.formId);
    if (leaving) this.#leaving = this.#leaving.filter((instance) => instance !== leaving);
    if (top) head(top, 0, rate);
    const resumed = earlier ?? leaving;
    const instance: Instance = {
      modifier,
      strength: 1,
      age: resumed?.age ?? 0,
      loop: false,
      fade: resumed?.fade ?? 0,
      fadeTarget: 1,
      fadeRate: rate,
    };
    head(instance, 1, rate);
    this.#chain.push(instance);
  }

  /**
   * ImageSpaceModifier.RemoveCrossFade: fades the chain's last modifier out over `seconds`;
   * the one before it fades back in.
   * TODO(M13): check against the game that the earlier modifier comes back.
   */
  removeCrossFade(seconds: number): void {
    const rate = rateFor(seconds);
    const top = this.#chain.pop();
    if (top) {
      head(top, 0, rate);
      if (top.fade > 0) this.#leaving.push(top);
    }
    const next = this.#chain.at(-1);
    if (next) head(next, 1, rate);
  }

  /**
   * ImageSpaceModifier.PopTo: takes `from` off and shows `to` at once at a strength; on the
   * cross-fade chain `to` takes `from`'s place.
   */
  popTo(from: number, to: ImageSpaceModifier, strength = 1): void {
    const swap = (instance: Instance): Instance =>
      instance.modifier.formId === from
        ? { ...instance, modifier: to, strength, age: 0 }
        : instance;
    const chained = [...this.#chain, ...this.#leaving].some(
      (instance) => instance.modifier.formId === from,
    );
    this.#chain.splice(0, this.#chain.length, ...this.#chain.map(swap));
    this.#leaving = this.#leaving.map(swap);
    const applied = this.#applied.delete(from);
    if (applied || !chained) this.apply(to, strength);
  }

  /** Takes every modifier off at once. */
  clear(): void {
    this.#applied.clear();
    this.#chain.length = 0;
    this.#leaving = [];
  }

  /** Advances the timelines and cross-fades; animated modifiers end after their duration. */
  advance(seconds: number): void {
    if (!(seconds > 0)) return;
    const step = (instance: Instance): void => {
      instance.age += seconds;
      const change = instance.fadeRate * seconds;
      instance.fade =
        instance.fade < instance.fadeTarget
          ? Math.min(instance.fadeTarget, instance.fade + change)
          : Math.max(instance.fadeTarget, instance.fade - change);
    };
    const ended = (instance: Instance): boolean =>
      !instance.loop && modifierFinished(instance.modifier, instance.age);
    for (const [formId, instance] of this.#applied) {
      step(instance);
      if (ended(instance)) this.#applied.delete(formId);
    }
    const top = this.#chain.at(-1);
    for (const instance of this.#chain) step(instance);
    const kept = this.#chain.filter((instance) => !ended(instance));
    this.#chain.splice(0, this.#chain.length, ...kept);
    const newTop = this.#chain.at(-1);
    if (newTop && newTop !== top) head(newTop, 1, newTop.fadeRate);
    for (const instance of this.#leaving) step(instance);
    this.#leaving = this.#leaving.filter((instance) => instance.fade > 0 && !ended(instance));
  }

  /** The active modifiers at their strengths now, laid onto `base` (itself when none acts). */
  modify(base: ImageSpace): ImageSpace {
    const frames: { frame: ModifierFrame; weight: number }[] = [];
    for (const instance of [...this.#applied.values(), ...this.#chain, ...this.#leaving]) {
      const weight = instance.strength * instance.fade;
      if (weight === 0) continue;
      const time = modifierKeyTime(instance.modifier, instance.age, instance.loop);
      frames.push({ frame: evaluateModifier(instance.modifier, time), weight });
    }
    return frames.length === 0 ? base : combineModifiers(base, frames);
  }
}

/**
 * Lays modifier frames, each at a weight (strength × cross-fade), onto an imagespace.
 * A channel at weight w multiplies by 1 + (mult − 1) w and adds add × w; several modifiers'
 * factors multiply and their summands add up.
 * TODO(M13): check the order of several modifiers' multiply/add against the game.
 */
export function combineModifiers(
  base: ImageSpace,
  frames: readonly { readonly frame: ModifierFrame; readonly weight: number }[],
): ImageSpace {
  const channel = (value: number, pick: (frame: ModifierFrame) => MultAdd): number => {
    let mult = 1;
    let add = 0;
    for (const { frame, weight } of frames) {
      const c = pick(frame);
      mult *= 1 + (c.mult - 1) * weight;
      add += c.add * weight;
    }
    return value * mult + add;
  };
  const hdr = Object.fromEntries(
    HDR_KEYS.map((key) => [key, channel(base.hdr[key], (frame) => frame.hdr[key])]),
  ) as Record<keyof ImageSpaceHdr, number>;

  // Tint: the alpha-weighted average colour, the highest alpha as the amount. The base
  // imagespace's tint takes part as one more tint. TODO(M13): check the base's share.
  const tint = averageColor(
    [
      [...base.tintColor, base.tintAmount],
      ...frames.map(({ frame, weight }) => weighted(frame.tint, weight)),
    ],
    base.tintColor,
  );
  const fade = averageColor(
    frames.map(({ frame, weight }) => weighted(frame.fade, weight)),
    NO_SCREEN_EFFECTS.fadeColor,
  );
  const highest = (pick: (frame: ModifierFrame) => number): number =>
    frames.reduce((max, { frame, weight }) => Math.max(max, pick(frame) * weight), 0);
  const strongest = <T>(
    pick: (frame: ModifierFrame) => T,
    strength: (value: T) => number,
  ): { value: T; strength: number } | undefined => {
    let best: { value: T; strength: number } | undefined;
    for (const { frame, weight } of frames) {
      const value = pick(frame);
      const s = strength(value) * weight;
      if (s > (best?.strength ?? 0)) best = { value, strength: s };
    }
    return best;
  };

  const radial = strongest(
    (frame) => frame.radialBlur,
    (blur) => blur.strength,
  );
  // TODO(M11): radial blur and depth of field that "use target" follow the modifier's target
  // (an explosion, a spell's target) on the screen; until then the record's centre and focus.
  const field = strongest(
    (frame) => frame.depthOfField,
    (dof) => (dof.mode === 'none' ? 0 : dof.strength),
  );
  const effects: ScreenEffects = {
    fadeColor: fade.color,
    fadeAmount: Math.min(1, Math.max(0, fade.amount)),
    blurRadius: Math.min(
      7,
      highest((frame) => frame.blurRadius),
    ),
    doubleVision: highest((frame) => frame.doubleVision),
    radialBlur: radial
      ? {
          strength: radial.strength,
          rampUp: radial.value.rampUp,
          start: radial.value.start,
          rampDown: radial.value.rampDown,
          downStart: radial.value.downStart,
          center: radial.value.center,
        }
      : NO_SCREEN_EFFECTS.radialBlur,
    motionBlur: highest((frame) => frame.motionBlur),
  };
  return {
    hdr,
    saturation: channel(base.saturation, (frame) => frame.saturation),
    brightness: channel(base.brightness, (frame) => frame.brightness),
    contrast: channel(base.contrast, (frame) => frame.contrast),
    tintAmount: tint.amount,
    tintColor: tint.color,
    // A modifier's depth of field takes the place of the imagespace's.
    // TODO(M13): check how the game mixes a modifier's depth of field with the weather's.
    depthOfField: field
      ? {
          strength: field.strength,
          distance: field.value.distance,
          range: field.value.range,
          blurRadius: field.value.blurRadius,
          sky: field.value.sky,
          mode: field.value.mode,
        }
      : base.depthOfField,
    effects,
  };
}

const weighted = (color: Rgba, weight: number): Rgba => [
  color[0],
  color[1],
  color[2],
  color[3] * weight,
];

/** Colours averaged by their alpha; the highest alpha is the amount. */
function averageColor(colors: readonly Rgba[], fallback: Rgb): { color: Rgb; amount: number } {
  let total = 0;
  let amount = 0;
  const sum = [0, 0, 0];
  for (const [r, g, b, a] of colors) {
    if (!(a > 0)) continue;
    total += a;
    amount = Math.max(amount, a);
    sum[0] = (sum[0] ?? 0) + r * a;
    sum[1] = (sum[1] ?? 0) + g * a;
    sum[2] = (sum[2] ?? 0) + b * a;
  }
  if (total <= 0) return { color: fallback, amount: 0 };
  return {
    color: [(sum[0] ?? 0) / total, (sum[1] ?? 0) / total, (sum[2] ?? 0) / total],
    amount,
  };
}
