import { describe, expect, it } from 'vitest';
import { eyeFrame, StealthMeter, type StealthMenu, type StealthReading } from './hud-stealth.ts';

/** A HUD that writes down what the meter asks of it. */
function hud(): StealthMenu & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    call: (name, ...args) => log.push(`call ${name} ${args.join(' ')}`),
    invoke: (path, ...args) =>
      log.push(`invoke ${path.split('.').slice(-2).join('.')} ${args.join(' ')}`),
    set: (path, value) => log.push(`set ${path.split('.').slice(-2).join('.')} ${String(value)}`),
  };
}

const texts = { detected: '[DETECTED]', hidden: '[HIDDEN]' };
const reading = (values: Partial<StealthReading>): StealthReading => ({
  sneaking: true,
  eye: 0,
  detected: 0,
  hidden: 0,
  ...values,
});

describe('the stealth meter', () => {
  it('maps how far the eye is open to its frames, shut 1 to open 100', () => {
    expect(eyeFrame(0)).toBe(1);
    expect(eyeFrame(0.5)).toBe(51);
    expect(eyeFrame(1)).toBe(100);
    expect(eyeFrame(2)).toBe(100);
  });

  it('shows while the player sneaks: the stealth mode, the meter fading in and out', () => {
    const menu = hud();
    const meter = new StealthMeter();
    meter.update(menu, reading({}), 0, texts);
    expect(menu.log).toEqual([
      'call ShowElements StealthMode true',
      'invoke StealthMeterInstance.gotoAndPlay FadeIn',
    ]);
    menu.log.length = 0;
    meter.update(menu, reading({ sneaking: false }), 16, texts);
    expect(menu.log).toEqual([
      'call ShowElements StealthMode false',
      'invoke StealthMeterInstance.gotoAndPlay FadeOut',
    ]);
  });

  it('opens the eye towards the reading, easing', () => {
    const menu = hud();
    const meter = new StealthMeter();
    meter.update(menu, reading({ eye: 1 }), 0, texts);
    menu.log.length = 0;
    // A tenth of a second: 0.4 of the way.
    meter.update(menu, reading({ eye: 1 }), 100, texts);
    expect(menu.log).toEqual(['invoke SneakAnimInstance.gotoAndStop 41']);
    meter.update(menu, reading({ eye: 1 }), 1000, texts);
    expect(menu.log.at(-1)).toBe('invoke SneakAnimInstance.gotoAndStop 100');
    menu.log.length = 0;
    // Unchanged: nothing sent.
    meter.update(menu, reading({ eye: 1 }), 1100, texts);
    expect(menu.log).toEqual([]);
  });

  it('flashes DETECTED and HIDDEN as they come, while sneaking', () => {
    const menu = hud();
    const meter = new StealthMeter();
    meter.update(menu, reading({}), 0, texts);
    menu.log.length = 0;
    meter.update(menu, reading({ detected: 1 }), 0, texts);
    expect(menu.log).toEqual([
      'set SneakTextInstance.text [DETECTED]',
      'invoke SneakTextHolder.gotoAndPlay Start',
    ]);
    menu.log.length = 0;
    meter.update(menu, reading({ detected: 1, hidden: 1 }), 0, texts);
    expect(menu.log[0]).toBe('set SneakTextInstance.text [HIDDEN]');
    menu.log.length = 0;
    // Standing, nothing flashes.
    meter.update(menu, reading({ sneaking: false, detected: 2 }), 0, texts);
    expect(menu.log.some((line) => line.includes('Start'))).toBe(false);
  });
});
