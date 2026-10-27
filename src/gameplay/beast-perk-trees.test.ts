import { describe, expect, it } from 'vitest';
import { actorValueIndex } from '../world/actor-values.ts';
import { beastTree } from './beast-perk-trees.ts';
import { survivalHud, survivalHudKey, SURVIVAL_GLOBALS } from './survival-hud.ts';

describe('beast perk trees', () => {
  it("shows the werewolf's tree (AVHealRatePowerMod) to a werewolf", () => {
    const tree = beastTree(true, 'WerewolfBeastRace');
    expect(tree?.form).toBe('werewolf');
    expect(tree?.avif).toBe('AVHealRatePowerMod');
    expect(tree?.points).toBe(actorValueIndex('WerewolfPerks'));
  });

  it("shows the vampire lord's tree (AVMagickaRateMod) to a vampire lord", () => {
    const tree = beastTree(true, 'DLC1VampireBeastRace');
    expect(tree?.form).toBe('vampireLord');
    expect(tree?.avif).toBe('AVMagickaRateMod');
    expect(tree?.points).toBe(actorValueIndex('VampirePerks'));
  });

  it('shows the ring out of a beast form and to other races', () => {
    expect(beastTree(false, 'WerewolfBeastRace')).toBeUndefined();
    expect(beastTree(true, 'NordRace')).toBeUndefined();
    expect(beastTree(true, undefined)).toBeUndefined();
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
