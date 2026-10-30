import { describe, expect, it } from 'vitest';
import { actorValueIndex } from '../world/actor-values.ts';
import { beastTree, WEREWOLF_TREE } from './beast-perk-trees.ts';
import { survivalHud, survivalHudKey, SURVIVAL_GLOBALS } from './survival-hud.ts';

describe('beast perk trees', () => {
  // The load order's default objects: WerewolfRace, VampireRace (Dawnguard's).
  const defaults = new Map([
    ['RIWR', 0xcdd84],
    ['RIVR', 0x200283a],
  ]);
  const dobj = (use: string): number | undefined => defaults.get(use);

  it("shows the werewolf's tree (AVHealRatePowerMod) to the werewolf race", () => {
    const tree = beastTree(true, 0xcdd84, dobj);
    expect(tree?.form).toBe('werewolf');
    expect(tree?.avif).toBe('AVHealRatePowerMod');
    // Its points are WerewolfAvailablePerks' global, its meter the scripts' WerewolfPerks.
    expect(tree?.pointsGlobal).toBe('AVWP');
    expect(tree?.progress).toBe(actorValueIndex('WerewolfPerks'));
  });

  it("shows the vampire lord's tree (AVMagickaRateMod) to the vampire lord race", () => {
    const tree = beastTree(true, 0x200283a, dobj);
    expect(tree?.form).toBe('vampireLord');
    expect(tree?.avif).toBe('AVMagickaRateMod');
    expect(tree?.pointsGlobal).toBe('AVVP');
    expect(tree?.progress).toBe(actorValueIndex('VampirePerks'));
  });

  it("gives the werewolf race the werewolf's tree, a werebear none", () => {
    expect(beastTree(true, 0xcdd84, dobj)).toBe(WEREWOLF_TREE);
    expect(beastTree(true, 0x4000001, dobj)).toBeUndefined();
  });

  it('shows the ring out of a beast form and to other races', () => {
    expect(beastTree(false, 0xcdd84, dobj)).toBeUndefined();
    expect(beastTree(true, 0x13746, dobj)).toBeUndefined();
    expect(beastTree(true, undefined, dobj)).toBeUndefined();
  });
});

describe('survival HUD', () => {
  const globals = new Map<string, number>([
    [SURVIVAL_GLOBALS.enabled, 1],
    [SURVIVAL_GLOBALS.temperature, 3],
    [SURVIVAL_GLOBALS.hunger, 25.4],
    [SURVIVAL_GLOBALS.cold, 140],
    [SURVIVAL_GLOBALS.exhaustion, -5],
  ]);

  it('shows the penalties and the temperature with the plugin and the mode on', () => {
    const hud = survivalHud(true, (name) => globals.get(name));
    expect(hud).toEqual({
      show: true,
      data: {
        aTemperatureLevel: 3,
        aColdPenaltyPercent: 100,
        aHungerPenaltyPercent: 25,
        aExhaustionPenaltyPercent: 0,
      },
    });
    expect(survivalHudKey(hud)).toBe('3:100:25:0');
  });

  it('hides without the plugin or with the mode off', () => {
    expect(survivalHud(false, (name) => globals.get(name))).toEqual({ show: false });
    expect(survivalHud(true, () => 0)).toEqual({ show: false });
  });
});
