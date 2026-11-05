import { describe, expect, it } from 'vitest';
import {
  bribeCost,
  intimidated,
  intimidation,
  persuadedUntil,
  CrimeFlag,
  CrimeLedger,
  crimeBounty,
  CrimeType,
  crimeValues,
  guardResponse,
  isViolent,
  jailDays,
  jailSkillLosses,
  pickpocketChance,
  pickpocketUses,
  readCrimeSettings,
  TrespassWarnings,
  type GuardSituation,
} from './crime.ts';

const settings = readCrimeSettings();
/** Whiterun's CRVA (every hold's: arrest, attack on sight, 1000/40/5/25, ×0.5, 100, 1000). */
const hold = {
  arrest: true,
  attackOnSight: true,
  murder: 1000,
  assault: 40,
  trespass: 5,
  pickpocket: 25,
  stealMult: 0.5,
  escape: 100,
  werewolf: 1000,
};

describe('bounties', () => {
  it("are a hold's crime values; theft half the items' value", () => {
    const values = crimeValues(CrimeFlag.trackCrime, hold, settings);
    expect(crimeBounty(CrimeType.murder, values)).toBe(1000);
    expect(crimeBounty(CrimeType.attack, values)).toBe(40);
    expect(crimeBounty(CrimeType.trespass, values)).toBe(5);
    expect(crimeBounty(CrimeType.pickpocket, values)).toBe(25);
    expect(crimeBounty(CrimeType.escape, values)).toBe(100);
    expect(crimeBounty(CrimeType.werewolf, values)).toBe(1000);
    expect(crimeBounty(CrimeType.steal, values, { value: 25 })).toBe(12);
    // Anything of value costs at least 1; nothing of value nothing.
    expect(crimeBounty(CrimeType.steal, values, { value: 1 })).toBe(1);
    expect(crimeBounty(CrimeType.steal, values, { value: 0 })).toBe(0);
  });

  it('take the game settings with "Crime Gold: Use Defaults"', () => {
    const custom = { ...hold, murder: 7, assault: 3, stealMult: 2 };
    const values = crimeValues(CrimeFlag.useDefaults, custom, settings);
    expect(crimeBounty(CrimeType.murder, values)).toBe(settings.murder);
    expect(crimeBounty(CrimeType.attack, values)).toBe(settings.attack);
    expect(crimeBounty(CrimeType.steal, values, { value: 100 })).toBe(50);
    // The arrest and attack-on-sight flags stay the faction's.
    expect(crimeValues(CrimeFlag.useDefaults, { ...hold, arrest: false }, settings).arrest).toBe(
      false,
    );
  });

  it('charge a stolen horse iCrimeGoldStealHorse', () => {
    const values = crimeValues(0, hold, settings);
    expect(crimeBounty(CrimeType.steal, values, { horse: true, settings })).toBe(100);
  });

  it('are nothing for the crimes a faction ignores', () => {
    const values = crimeValues(CrimeFlag.ignoreStealing | CrimeFlag.ignoreMurder, hold, settings);
    expect(crimeBounty(CrimeType.steal, values, { value: 100 })).toBe(0);
    expect(crimeBounty(CrimeType.murder, values)).toBe(0);
    expect(crimeBounty(CrimeType.attack, values)).toBe(40);
  });

  it('go to the violent crime gold for assault and murder alone', () => {
    expect(isViolent(CrimeType.attack)).toBe(true);
    expect(isViolent(CrimeType.murder)).toBe(true);
    expect(isViolent(CrimeType.werewolf)).toBe(false);
    expect(isViolent(CrimeType.escape)).toBe(false);
    expect(isViolent(CrimeType.steal)).toBe(false);
    expect(isViolent(CrimeType.trespass)).toBe(false);
  });
});

describe('the pickpocket chance', () => {
  it("rises with the thief's skill and falls with the target's, the weight and the value", () => {
    // (20 + 15) − 0.25 × (20 + 15) − 4 × 0.1 − 0.1 × 10 = 24.85
    expect(pickpocketChance({ skill: 15, targetSkill: 15, weight: 0.1, value: 10 }, settings)).toBe(
      25,
    );
    const base = { targetSkill: 15, weight: 0.1, value: 10 };
    expect(pickpocketChance({ ...base, skill: 50 }, settings)).toBeGreaterThan(
      pickpocketChance({ ...base, skill: 15 }, settings),
    );
    expect(
      pickpocketChance({ skill: 50, targetSkill: 15, weight: 10, value: 10 }, settings),
    ).toBeLessThan(pickpocketChance({ ...base, skill: 50 }, settings));
  });

  it('stays within fPickPocketMinChance and fPickPocketMaxChance', () => {
    expect(pickpocketChance({ skill: 100, targetSkill: 0, weight: 0, value: 0 }, settings)).toBe(
      90,
    );
    expect(pickpocketChance({ skill: 15, targetSkill: 15, weight: 0, value: 2000 }, settings)).toBe(
      0,
    );
  });

  it('is scaled by the perks', () => {
    // (20 + 15) − 0.25 × (20 + 15) = 26.25; twice that 52.5.
    const attempt = { skill: 15, targetSkill: 15, weight: 0, value: 0 };
    expect(pickpocketChance(attempt, settings)).toBe(26);
    expect(pickpocketChance({ ...attempt, perkMult: 2 }, settings)).toBe(53);
  });

  it('gives Pickpocket uses by the value taken', () => {
    expect(pickpocketUses(0, settings)).toBe(1);
    expect(pickpocketUses(100, settings)).toBeCloseTo(100 ** 0.8);
  });
});

describe('jail', () => {
  it('is a day per 100 gold of bounty, at least one', () => {
    expect(jailDays(40, settings)).toBe(1);
    expect(jailDays(250, settings)).toBe(2);
    expect(jailDays(1040, settings)).toBe(7);
  });

  it('resets the skills with the least progress, a tenth of the bounty of them', () => {
    const progress = [
      [6, 5],
      [10, 1],
      [14, 3],
      [15, 0],
    ] as const;
    expect(jailSkillLosses(20, progress, settings)).toEqual([10, 14]);
    expect(jailSkillLosses(9, progress, settings)).toEqual([]);
    expect(jailSkillLosses(1000, progress, settings)).toEqual([10, 14, 6]);
  });
});

describe("guards' responses", () => {
  const situation = (change: Partial<GuardSituation>): GuardSituation => ({
    violent: 0,
    nonviolent: 0,
    alarmed: false,
    resisting: false,
    enemy: false,
    values: { arrest: true, attackOnSight: true },
    violentThreshold: 999,
    nonviolentThreshold: 1000,
    ...change,
  });

  it('leave a player without a bounty alone', () => {
    expect(guardResponse(situation({ alarmed: true }))).toBe('none');
  });

  it('arrest a fresh crime, or on sight at the thresholds', () => {
    expect(guardResponse(situation({ nonviolent: 5, alarmed: true }))).toBe('arrest');
    expect(guardResponse(situation({ nonviolent: 5 }))).toBe('none');
    expect(guardResponse(situation({ nonviolent: 1000 }))).toBe('arrest');
    expect(guardResponse(situation({ violent: 1000 }))).toBe('arrest');
  });

  it('attack one resisting arrest, an enemy, or where the faction does not arrest', () => {
    expect(guardResponse(situation({ nonviolent: 40, resisting: true }))).toBe('attack');
    expect(guardResponse(situation({ enemy: true }))).toBe('attack');
    expect(
      guardResponse(
        situation({ violent: 40, alarmed: true, values: { arrest: false, attackOnSight: true } }),
      ),
    ).toBe('attack');
    expect(
      guardResponse(
        situation({ violent: 40, alarmed: true, values: { arrest: false, attackOnSight: false } }),
      ),
    ).toBe('none');
  });
});

describe('trespass warnings', () => {
  it('warn iGuardWarnings times, a timer apart, then it is the crime once', () => {
    const warnings = new TrespassWarnings();
    expect(warnings.seen(0, settings)).toBe('warn');
    expect(warnings.level).toBe(1);
    expect(warnings.seen(2, settings)).toBe('none');
    expect(warnings.seen(5, settings)).toBe('warn');
    expect(warnings.level).toBe(2);
    expect(warnings.seen(10, settings)).toBe('crime');
    expect(warnings.seen(20, settings)).toBe('none');
    warnings.reset();
    expect(warnings.level).toBe(0);
    expect(warnings.seen(30, settings)).toBe('warn');
  });
});

describe('witnesses', () => {
  const crime = (witnesses: number[]) => ({
    type: CrimeType.steal,
    criminal: 0x14,
    victim: 0x100,
    faction: 0x267ea,
    gold: 12,
    violent: false,
    witnesses,
    at: 10,
  });

  it('make a crime: unseen, there is none', () => {
    const ledger = new CrimeLedger();
    expect(ledger.commit(crime([]))).toBeUndefined();
    expect(ledger.commit(crime([0x14]))).toBeUndefined();
    expect(ledger.known(CrimeType.steal, 0x14, 0x100)).toBe(false);
    const seen = ledger.commit(crime([0x200, 0x201]));
    expect(seen?.witnesses).toEqual(new Set([0x200, 0x201]));
    expect(ledger.known(CrimeType.steal, 0x14, 0x100)).toBe(true);
  });

  it('killed before they report take the crime back with the last of them', () => {
    const ledger = new CrimeLedger();
    const seen = ledger.commit(crime([0x200, 0x201]));
    expect(ledger.witnessDied(0x200)).toEqual([]);
    expect(ledger.witnessDied(0x201)).toEqual([seen]);
    expect(ledger.known(CrimeType.steal, 0x14, 0x100)).toBe(false);
    expect([...ledger.open()]).toEqual([]);
  });

  it('close after fKillWitnessesTimerSetting; closed, killing the witnesses is too late', () => {
    const ledger = new CrimeLedger();
    const first = ledger.commit(crime([0x200]));
    expect(ledger.expire(10 + 29, 30)).toEqual([]);
    expect(ledger.expire(10 + 30, 30)).toEqual([first]);
    expect(first?.reported).toBe(true);
    expect(ledger.witnessDied(0x200)).toEqual([]);
  });

  it("are settled with the faction's bounty", () => {
    const ledger = new CrimeLedger();
    ledger.commit(crime([0x200]));
    ledger.settle(0x267ea);
    expect([...ledger.open()]).toEqual([]);
    expect(ledger.witnessDied(0x200)).toEqual([]);
  });
});

describe('bribes and intimidation', () => {
  const target = { level: 10, speech: 15, morality: 0, confidence: 2 };
  // Skyrim.esm's bribe settings over the engine's.
  const skyrim = { ...settings, bribeCostCurve: 1.4, bribeScale: 0.5, bribeSpeechcraftMult: 0.1 };

  it('cost by both levels, Speech against Speech and morality (the original’s rule)', () => {
    // (10 × 0.1 + 1 + (100 − 0) × 0.1) ^ 1.4 × 0.5: some 16 gold for a new character.
    const sides = { player: { level: 1, speech: 15 }, target };
    expect(Math.floor(bribeCost(sides, skyrim))).toBe(16);
    expect(bribeCost({ ...sides, player: { level: 1, speech: 100 } }, skyrim)).toBeLessThan(
      bribeCost(sides, skyrim),
    );
    // Morality 3 (no crime) quadruples it.
    expect(bribeCost({ ...sides, target: { ...target, morality: 3 } }, skyrim)).toBeCloseTo(
      4 * bribeCost(sides, skyrim),
    );
  });

  it('intimidates by level, Speech against Speech, and confidence (the original’s rule)', () => {
    const sides = { player: { level: 10, speech: 15 }, target };
    // Same Speech: the player's level against its own (average confidence).
    expect(intimidation(sides, settings)).toBe(10);
    expect(intimidated(10, target, settings)).toBe(true);
    expect(intimidated(10, { ...target, level: 12 }, settings)).toBe(false);
    // Speech 100 against 15: (1.85) ^ 1.5 times as scary.
    expect(intimidation({ ...sides, player: { level: 10, speech: 100 } }, settings)).toBeCloseTo(
      10 * 1.85 ** 1.5,
    );
    // The cowardly always fold, the foolhardy as good as never, the brave at 1.5 levels.
    expect(intimidated(0, { ...target, confidence: 0 }, settings)).toBe(true);
    expect(intimidated(99, { ...target, level: 1, confidence: 4 }, settings)).toBe(false);
    expect(intimidated(14, { ...target, confidence: 3 }, settings)).toBe(false);
  });

  it('hold until the day after next', () => {
    // Given on day 3 at 23:00, it holds through day 4.
    expect(persuadedUntil(3.95, settings.daysToStayBribed)).toBe(4);
  });
});
