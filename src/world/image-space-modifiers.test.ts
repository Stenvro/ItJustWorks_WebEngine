import { describe, expect, it } from 'vitest';
import { NEUTRAL_IMAGE_SPACE, type ImageSpace } from './image-space.ts';
import {
  IMAD_CHANNEL_COUNT,
  IMAD_CINEMATIC_CHANNELS,
  IMAD_HDR_CHANNELS,
  type ColorKey,
  type FloatKey,
  type ImageSpaceModifier,
  type MultAddCurves,
} from './image-space-modifier.ts';
import { ImageSpaceModifiers } from './image-space-modifiers.ts';

const at = (value: number): FloatKey[] => [{ time: 0, value }];
const ramp = (from: number, to: number): FloatKey[] => [
  { time: 0, value: from },
  { time: 1, value: to },
];

/** A synthetic modifier: nothing changes but what `changes` sets. */
function modifier(
  formId: number,
  changes: {
    animatable?: boolean;
    duration?: number;
    channels?: Record<number, Partial<MultAddCurves>>;
    tint?: ColorKey[];
    fade?: ColorKey[];
    blurRadius?: FloatKey[];
    doubleVision?: FloatKey[];
    radialStrength?: FloatKey[];
    dofStrength?: FloatKey[];
    motionBlur?: FloatKey[];
  } = {},
): ImageSpaceModifier {
  return {
    formId,
    editorId: `Imod${String(formId)}`,
    animatable: changes.animatable ?? false,
    duration: changes.duration ?? 1,
    channels: Array.from({ length: IMAD_CHANNEL_COUNT }, (_, i) => ({
      mult: changes.channels?.[i]?.mult ?? [],
      add: changes.channels?.[i]?.add ?? [],
    })),
    tint: changes.tint ?? [],
    fade: changes.fade ?? [],
    blurRadius: changes.blurRadius ?? [],
    doubleVision: changes.doubleVision ?? [],
    radialBlur: {
      strength: changes.radialStrength ?? [],
      rampUp: at(0.5),
      start: at(0.25),
      rampDown: [],
      downStart: [],
      center: [0.5, 0.5],
      useTarget: false,
    },
    depthOfField: {
      strength: changes.dofStrength ?? [],
      distance: at(300),
      range: at(200),
      useTarget: false,
      mode: 'frontBack',
      sky: true,
      blurRadius: 3,
    },
    motionBlur: changes.motionBlur ?? [],
  };
}

const base: ImageSpace = {
  ...NEUTRAL_IMAGE_SPACE,
  hdr: { ...NEUTRAL_IMAGE_SPACE.hdr, bloomScale: 2, sunlightScale: 1.5 },
  brightness: 1.2,
  tintAmount: 0.2,
  tintColor: [0, 0, 1],
  depthOfField: { strength: 0.5, distance: 20000, range: 10000, blurRadius: 2, sky: false },
};

describe('modifiers that use their target', () => {
  it('centre their radial blur on it and focus their depth of field at its distance', () => {
    const imod = modifier(7, { radialStrength: at(1), dofStrength: at(1) });
    const aiming: ImageSpaceModifier = {
      ...imod,
      radialBlur: { ...imod.radialBlur, useTarget: true },
      depthOfField: { ...imod.depthOfField, useTarget: true },
    };
    const stack = new ImageSpaceModifiers();
    stack.apply(aiming, 1, { target: () => [100, 0, 0] });
    const view = { project: () => [0.25, 0.75] as const, distance: () => 1234 };
    const shown = stack.modify(base, view);
    expect(shown.effects?.radialBlur.center).toEqual([0.25, 0.75]);
    expect(shown.depthOfField.distance).toBe(1234);
    // Without a view (or a target) the record's centre and focus.
    const plain = stack.modify(base);
    expect(plain.effects?.radialBlur.center).toEqual([0.5, 0.5]);
    expect(plain.depthOfField.distance).toBe(300);
  });
});

const brightness = IMAD_CINEMATIC_CHANNELS.brightness;
const saturation = IMAD_CINEMATIC_CHANNELS.saturation;

describe('ImageSpaceModifiers', () => {
  it('leaves the imagespace alone without modifiers', () => {
    const stack = new ImageSpaceModifiers();
    expect(stack.empty).toBe(true);
    expect(stack.modify(base)).toBe(base);
  });

  it('multiplies and adds by the strength', () => {
    const stack = new ImageSpaceModifiers();
    stack.apply(
      modifier(1, {
        channels: {
          [brightness]: { add: at(-0.15) },
          [IMAD_HDR_CHANNELS.bloomScale]: { mult: at(3) },
          [IMAD_HDR_CHANNELS.sunlightScale]: { mult: at(0), add: at(4) },
        },
      }),
      0.5,
    );
    const space = stack.modify(base);
    expect(space.brightness).toBeCloseTo(1.2 - 0.075);
    // 2 × (1 + (3 − 1) × 0.5)
    expect(space.hdr.bloomScale).toBeCloseTo(4);
    // 1.5 × 0.5 + 4 × 0.5
    expect(space.hdr.sunlightScale).toBeCloseTo(2.75);
    expect(space.saturation).toBe(1);
  });

  it('combines several: factors multiply, summands add', () => {
    const stack = new ImageSpaceModifiers();
    stack.apply(modifier(1, { channels: { [saturation]: { mult: at(0.5), add: at(0.1) } } }));
    stack.apply(modifier(2, { channels: { [saturation]: { mult: at(0.5), add: at(0.2) } } }));
    expect(stack.modify(base).saturation).toBeCloseTo(0.25 + 0.3);
  });

  it('averages tints by their alpha and takes the highest alpha', () => {
    const stack = new ImageSpaceModifiers();
    stack.apply(modifier(1, { tint: [{ time: 0, color: [1, 0, 0, 0.6] }] }));
    const space = stack.modify(base);
    expect(space.tintAmount).toBeCloseTo(0.6);
    // The imagespace's blue tint (0.2) and the red one (0.6).
    expect(space.tintColor[0]).toBeCloseTo(0.75);
    expect(space.tintColor[2]).toBeCloseTo(0.25);
  });

  it('fades to a colour and takes the highest blur and double vision', () => {
    const stack = new ImageSpaceModifiers();
    stack.apply(
      modifier(1, {
        fade: [{ time: 0, color: [0, 0, 0, 1] }],
        blurRadius: at(2),
        doubleVision: at(0.05),
      }),
    );
    stack.apply(modifier(2, { blurRadius: at(5), motionBlur: at(0.1) }));
    const effects = stack.modify(base).effects;
    expect(effects?.fadeAmount).toBe(1);
    expect(effects?.fadeColor).toEqual([0, 0, 0]);
    expect(effects?.blurRadius).toBe(5);
    expect(effects?.doubleVision).toBeCloseTo(0.05);
    expect(effects?.motionBlur).toBeCloseTo(0.1);
  });

  it('takes the strongest radial blur and depth of field', () => {
    const stack = new ImageSpaceModifiers();
    stack.apply(modifier(1, { radialStrength: at(0.1), dofStrength: at(1) }), 0.5);
    const space = stack.modify(base);
    expect(space.effects?.radialBlur).toMatchObject({ strength: 0.05, rampUp: 0.5, start: 0.25 });
    expect(space.depthOfField).toMatchObject({
      strength: 0.5,
      distance: 300,
      range: 200,
      blurRadius: 3,
      mode: 'frontBack',
    });
    // Without one the imagespace's own depth of field stays.
    const plain = new ImageSpaceModifiers();
    plain.apply(modifier(2, { blurRadius: at(1) }));
    expect(plain.modify(base).depthOfField).toBe(base.depthOfField);
  });

  it('plays animated modifiers once, keeps static ones until removed', () => {
    const stack = new ImageSpaceModifiers();
    const fading = modifier(1, {
      animatable: true,
      duration: 2,
      fade: [
        { time: 0, color: [0, 0, 0, 0] },
        { time: 1, color: [0, 0, 0, 1] },
      ],
    });
    stack.apply(fading);
    stack.apply(modifier(2, { blurRadius: at(1) }));
    stack.advance(1);
    expect(stack.modify(base).effects?.fadeAmount).toBeCloseTo(0.5);
    stack.advance(1.5);
    expect(stack.isActive(1)).toBe(false);
    expect(stack.isActive(2)).toBe(true);
    stack.remove(2);
    expect(stack.empty).toBe(true);
  });

  it('loops animated modifiers when asked', () => {
    const stack = new ImageSpaceModifiers();
    stack.apply(modifier(1, { animatable: true, duration: 2, blurRadius: ramp(0, 4) }), 1, {
      loop: true,
    });
    stack.advance(5);
    expect(stack.isActive(1)).toBe(true);
    expect(stack.modify(base).effects?.blurRadius).toBeCloseTo(2);
  });

  it('cross-fades along the chain and back', () => {
    const stack = new ImageSpaceModifiers();
    const dark = modifier(1, { channels: { [brightness]: { mult: at(0) } } });
    const red = modifier(2, { tint: [{ time: 0, color: [1, 0, 0, 1] }] });
    stack.applyCrossFade(dark, 2);
    expect(stack.modify(NEUTRAL_IMAGE_SPACE).brightness).toBe(1);
    stack.advance(1);
    expect(stack.modify(NEUTRAL_IMAGE_SPACE).brightness).toBeCloseTo(0.5);
    stack.advance(1);
    expect(stack.modify(NEUTRAL_IMAGE_SPACE).brightness).toBeCloseTo(0);
    // The next one fades in while the dark one fades out.
    stack.applyCrossFade(red, 1);
    stack.advance(0.5);
    let space = stack.modify(NEUTRAL_IMAGE_SPACE);
    expect(space.brightness).toBeCloseTo(0.5);
    expect(space.tintAmount).toBeCloseTo(0.5);
    stack.advance(0.5);
    space = stack.modify(NEUTRAL_IMAGE_SPACE);
    expect(space.brightness).toBeCloseTo(1);
    expect(space.tintAmount).toBeCloseTo(1);
    // Removing the last brings the one before back.
    stack.removeCrossFade(1);
    stack.advance(1);
    space = stack.modify(NEUTRAL_IMAGE_SPACE);
    expect(space.tintAmount).toBe(0);
    expect(space.brightness).toBeCloseTo(0);
    expect(stack.isActive(2)).toBe(false);
    stack.removeCrossFade(0);
    stack.advance(0.1);
    expect(stack.empty).toBe(true);
  });

  it('pops from one modifier to another at once', () => {
    const stack = new ImageSpaceModifiers();
    const fadeOut = modifier(1, { fade: [{ time: 0, color: [0, 0, 0, 0.5] }] });
    const hold = modifier(2, { fade: [{ time: 0, color: [0, 0, 0, 1] }] });
    stack.apply(fadeOut);
    stack.popTo(1, hold, 1);
    expect(stack.isActive(1)).toBe(false);
    expect(stack.modify(base).effects?.fadeAmount).toBe(1);
    // On the chain, the new one takes the old one's place.
    const chained = new ImageSpaceModifiers();
    chained.applyCrossFade(fadeOut, 0);
    chained.popTo(1, hold, 1);
    expect(chained.active).toMatchObject([{ formId: 2, crossFade: true, weight: 1 }]);
    // Popping from one that is not shown still shows the other.
    const fresh = new ImageSpaceModifiers();
    fresh.popTo(7, hold, 0.5);
    expect(fresh.active).toMatchObject([{ formId: 2, weight: 0.5 }]);
  });

  it('applies again from the start', () => {
    const stack = new ImageSpaceModifiers();
    const flash = modifier(1, { animatable: true, duration: 1, blurRadius: ramp(4, 0) });
    stack.apply(flash);
    stack.advance(0.75);
    expect(stack.modify(base).effects?.blurRadius).toBeCloseTo(1);
    stack.apply(flash, 1);
    expect(stack.modify(base).effects?.blurRadius).toBeCloseTo(4);
    stack.clear();
    expect(stack.empty).toBe(true);
  });
});
