import { describe, expect, it } from 'vitest';
import { eventEnabled, UserEventFlag } from '../../../formats/controlmap/controlmap.ts';
import type { Controls } from '../runtime.ts';
import { disabledControlFlags } from './game.ts';

const ALL_ON: Controls = {
  movement: true,
  fighting: true,
  camSwitch: true,
  looking: true,
  sneaking: true,
  menu: true,
  activate: true,
  journalTabs: true,
  disablePov: 0,
  aiDriven: false,
};

/** The control map's flags of some gameplay events (interface\controls\pc\controlmap.txt). */
const FLAGS = {
  forward: 0x801,
  look: 0x2,
  activate: 0x804,
  togglePov: 0x820,
  zoomIn: 0x220,
  jump: 0xc01,
  sneak: 0x881,
  attack: 0x841,
  tween: 0x908,
  quicksave: 0,
};

describe('the controls the scripts switch off (Game.DisablePlayerControls)', () => {
  it('switches nothing off while every control is on', () => {
    expect(disabledControlFlags(ALL_ON)).toBe(0);
  });

  it("keeps the camera switch and the wheel's zoom off with abCamSwitch", () => {
    const disabled = disabledControlFlags({ ...ALL_ON, camSwitch: false });
    expect(eventEnabled(FLAGS.togglePov, disabled)).toBe(false);
    expect(eventEnabled(FLAGS.zoomIn, disabled)).toBe(false);
    expect(eventEnabled(FLAGS.forward, disabled)).toBe(true);
  });

  it("MQ101's cart (movement, fighting, the camera, sneaking, menus, activation off): only looking", () => {
    const disabled = disabledControlFlags({
      ...ALL_ON,
      movement: false,
      fighting: false,
      camSwitch: false,
      sneaking: false,
      menu: false,
      activate: false,
      journalTabs: false,
    });
    for (const flags of [
      FLAGS.forward,
      FLAGS.activate,
      FLAGS.togglePov,
      FLAGS.jump,
      FLAGS.sneak,
      FLAGS.attack,
      FLAGS.tween,
    ]) {
      expect(eventEnabled(flags, disabled)).toBe(false);
    }
    expect(eventEnabled(FLAGS.look, disabled)).toBe(true);
    // Events of no group (the quick save) are never the scripts'.
    expect(eventEnabled(FLAGS.quicksave, disabled)).toBe(true);
  });

  it('keeps sneaking with movement when only fighting is off', () => {
    const disabled = disabledControlFlags({ ...ALL_ON, fighting: false });
    expect(disabled).toBe(UserEventFlag.fighting);
    expect(eventEnabled(FLAGS.attack, disabled)).toBe(false);
    expect(eventEnabled(FLAGS.sneak, disabled)).toBe(true);
  });
});
