import { describe, expect, it } from 'vitest';
import { eventEnabled, UserEventFlag } from '../../../formats/controlmap/controlmap.ts';
import type { NativeFunction } from '../../papyrus-vm.ts';
import type { Value } from '../../values.ts';
import type { Controls, ScriptRuntime } from '../runtime.ts';
import { disabledControlFlags, povSwitchAllowed, registerGame } from './game.ts';

const ALL_ON: Controls = {
  movement: true,
  fighting: true,
  camSwitch: true,
  looking: true,
  sneaking: true,
  menu: true,
  activate: true,
  journalTabs: true,
  povLocks: [],
  aiDriven: false,
};

/** The control map's flags of some gameplay events (interface\controls\pc\controlmap.txt). */
const FLAGS = {
  forward: 0x801,
  look: 0x2,
  jump: 0xc01,
  sneak: 0x881,
  attack: 0x841,
  tween: 0x908,
  journal: 0x808,
  quicksave: 0,
};

describe('the controls the scripts switch off (Game.DisablePlayerControls)', () => {
  it('switches nothing off while every control is on', () => {
    expect(disabledControlFlags(ALL_ON)).toBe(0);
  });

  it('switches no group with abCamSwitch nor abActivate (the player controls’ own)', () => {
    expect(disabledControlFlags({ ...ALL_ON, camSwitch: false, activate: false })).toBe(0);
  });

  it('switches the main four alone with abMenu: the journal and the wait menu stay', () => {
    const disabled = disabledControlFlags({ ...ALL_ON, menu: false });
    expect(disabled).toBe(UserEventFlag.mainFour);
    expect(eventEnabled(FLAGS.tween, disabled)).toBe(false);
    expect(eventEnabled(FLAGS.journal, disabled)).toBe(true);
  });

  it('locks the camera switch per aiDisablePOVType until that type is enabled again', async () => {
    const natives = new Map<string, NativeFunction>();
    const controls: Controls = { ...ALL_ON, povLocks: [] };
    const runtime = { state: {}, world: {}, controls } as unknown as ScriptRuntime;
    registerGame((name, fn) => natives.set(name, fn), runtime);
    const run = (name: string, args: Value[]) =>
      natives.get(name)?.({
        vm: undefined as never,
        self: null,
        args,
        name,
        latent: (promise) => promise,
        where: () => '',
      });
    const only = (camSwitch: boolean, type: number): Value[] => [
      false,
      false,
      camSwitch,
      false,
      false,
      false,
      false,
      false,
      type,
    ];
    await run('game.disableplayercontrols', only(true, 0));
    await run('game.disableplayercontrols', only(true, 3));
    expect(povSwitchAllowed(controls)).toBe(false);
    await run('game.enableplayercontrols', only(true, 0));
    expect(controls.povLocks).toEqual([3]);
    expect(povSwitchAllowed(controls)).toBe(false);
    // A call that does not name the camera leaves its locks.
    await run('game.enableplayercontrols', only(false, 3));
    expect(povSwitchAllowed(controls)).toBe(false);
    await run('game.enableplayercontrols', only(true, 3));
    expect(povSwitchAllowed(controls)).toBe(true);
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
    for (const flags of [FLAGS.forward, FLAGS.jump, FLAGS.sneak, FLAGS.attack, FLAGS.tween]) {
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
