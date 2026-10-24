// Conformance: crime (engine map: AI > Crime). Every crime type the original has, what each costs
// and who must witness it, the crime faction it goes to, and what the world does about it.
//
// Sources:
// - The crime types: CommonLibSSE PackageNS::CRIME_TYPE (steal 0, pickpocket 1, trespass 2,
//   attack 3, murder 4, escape 5, werewolf 6); horse theft and lockpicking are a theft and a
//   trespass (UESP "Skyrim:Crime": stealing a horse, picking an owned lock).
// - The bounties: the crime faction's CRVA, or with "Crime Gold: Use Defaults" the settings
//   iCrimeGoldMurder 1000, iCrimeGoldAttack 40, iCrimeGoldTrespass 5, iCrimeGoldPickpocket 25,
//   iCrimeGoldEscape 100, fCrimeGoldSteal 0.5 (the engine's defaults). Observed in the original:
//   Use Defaults replaces exactly those six; the werewolf value stays the faction's own.
//   iCrimeGoldStealHorse: the engine's 25, Skyrim.esm's 100; iCrimeGoldWerewolf: 100, Skyrim.esm
//   1000 (it counts only for a faction without crime data).
// - Who witnesses: UESP "Skyrim:Crime" (a crime is reported only if seen; the victim of an
//   assault knows who struck it; killing every witness before the report takes the bounty back,
//   sWitnessKilled; friends overlook minor crimes, nobody a murder).
// - The crime faction of an actor crime: CommonLibSSE Actor::GetCrimeFactionImpl (a commanded
//   actor has none; else the faction scripts set, else the base's CRIF), then the victim's owner
//   (XOWN): the data (below) has no animal base with a CRIF, and owned farm animals.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CrimeFlag,
  CrimeLedger,
  crimeBounty,
  CrimeType,
  crimeValues,
  isViolent,
  jailDays,
  readCrimeSettings,
  TrespassWarnings,
} from '../../../src/gameplay/crime.ts';
import { overlooksCrime, RelationshipRank } from '../../../src/gameplay/factions.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { parseNpcStats } from '../../../src/world/actor-stats-records.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';
import { ENGINE, LOAD_ORDER } from '../combat/settings.ts';

/** The settings as the game runs: Skyrim.esm's GMSTs over the engine's defaults. */
const settings = readCrimeSettings({
  number: (name) =>
    (LOAD_ORDER as Record<string, number>)[name] ?? (ENGINE as Record<string, number>)[name],
});
/** A crime faction with Use Defaults and its own CRVA (a hold's: werewolf 1000). */
const record = {
  arrest: true,
  attackOnSight: true,
  murder: 7,
  assault: 7,
  trespass: 7,
  pickpocket: 7,
  stealMult: 7,
  escape: 7,
  werewolf: 1000,
};
const defaults = crimeValues(CrimeFlag.trackCrime | CrimeFlag.useDefaults, record, settings);

describe('every crime type and its bounty (Use Defaults: the settings)', () => {
  it('murder: iCrimeGoldMurder (1000), violent', () => {
    expect(crimeBounty(CrimeType.murder, defaults)).toBe(ENGINE.iCrimeGoldMurder);
    expect(isViolent(CrimeType.murder)).toBe(true);
  });

  it('assault: iCrimeGoldAttack (40), violent', () => {
    expect(crimeBounty(CrimeType.attack, defaults)).toBe(ENGINE.iCrimeGoldAttack);
    expect(isViolent(CrimeType.attack)).toBe(true);
  });

  it('theft: fCrimeGoldSteal (0.5) × the items’ value, not violent', () => {
    expect(crimeBounty(CrimeType.steal, defaults, { value: 120 })).toBe(120 * 0.5);
    expect(isViolent(CrimeType.steal)).toBe(false);
  });

  it('trespass: iCrimeGoldTrespass (5)', () => {
    expect(crimeBounty(CrimeType.trespass, defaults)).toBe(ENGINE.iCrimeGoldTrespass);
  });

  it('pickpocket: iCrimeGoldPickpocket (25)', () => {
    expect(crimeBounty(CrimeType.pickpocket, defaults)).toBe(ENGINE.iCrimeGoldPickpocket);
  });

  it('lockpicking an owned lock: a trespass, iCrimeGoldTrespass (5)', () => {
    expect(crimeBounty(CrimeType.trespass, defaults)).toBe(5);
  });

  it('escape from jail: iCrimeGoldEscape (100)', () => {
    expect(crimeBounty(CrimeType.escape, defaults)).toBe(ENGINE.iCrimeGoldEscape);
  });

  it('werewolf transformation: the faction’s own value, even with Use Defaults (original)', () => {
    expect(crimeBounty(CrimeType.werewolf, defaults)).toBe(1000);
    // A faction without crime data: iCrimeGoldWerewolf (Skyrim.esm 1000).
    const none = crimeValues(0, undefined, settings);
    expect(crimeBounty(CrimeType.werewolf, none)).toBe(LOAD_ORDER.iCrimeGoldWerewolf);
  });

  it('horse theft: iCrimeGoldStealHorse (Skyrim.esm 100)', () => {
    expect(crimeBounty(CrimeType.steal, defaults, { horse: true, settings })).toBe(
      LOAD_ORDER.iCrimeGoldStealHorse,
    );
  });

  it('a faction’s own CRVA without Use Defaults', () => {
    const own = crimeValues(CrimeFlag.trackCrime, record, settings);
    expect(crimeBounty(CrimeType.murder, own)).toBe(7);
    expect(crimeBounty(CrimeType.steal, own, { value: 10 })).toBe(70);
  });

  it('a faction’s Ignore flags take no notice of their type', () => {
    const ignoring = crimeValues(
      CrimeFlag.trackCrime | CrimeFlag.useDefaults | CrimeFlag.ignoreMurder,
      record,
      settings,
    );
    expect(crimeBounty(CrimeType.murder, ignoring)).toBe(0);
    expect(crimeBounty(CrimeType.attack, ignoring)).toBe(40);
  });

  it('jail: a day per iCrimeDaysInPrisonMod (100) gold, at least one (UESP Jail)', () => {
    expect(jailDays(1040, settings)).toBe(10);
    expect(jailDays(5, settings)).toBe(1);
  });

  it.todo('iCrimeGoldMinValue (10): the least theft bounty?  [settings]');
  it.todo('fCrimeGoldSkillPenaltyMult (0.1) and iCrimeMaxNumberofDaysinJail  [settings]');
  it.todo('the werewolf counted as violent crime gold  [original]');
});

describe('who must witness it', () => {
  it('unseen, a crime is not recorded (no bounty)', () => {
    const ledger = new CrimeLedger();
    const crime = ledger.commit({
      type: CrimeType.steal,
      criminal: PLAYER_REF,
      victim: 0x100,
      faction: 0x200,
      gold: 5,
      violent: false,
      witnesses: [],
      at: 0,
    });
    expect(crime).toBeUndefined();
  });

  it('killing the last witness before the report forgives it (sWitnessKilled)', () => {
    const ledger = new CrimeLedger();
    ledger.commit({
      type: CrimeType.attack,
      criminal: PLAYER_REF,
      victim: 0x100,
      faction: 0x200,
      gold: 40,
      violent: true,
      witnesses: [0x100, 0x101],
      at: 0,
    });
    expect(ledger.witnessDied(0x100)).toEqual([]);
    expect(ledger.witnessDied(0x101)).toHaveLength(1);
  });

  it('a guard who saw it reports it at once', () => {
    const ledger = new CrimeLedger();
    ledger.commit({
      type: CrimeType.murder,
      criminal: PLAYER_REF,
      victim: 0x100,
      faction: 0x200,
      gold: 1000,
      violent: true,
      witnesses: [0x300],
      at: 0,
    });
    expect(ledger.expire(0, (actor) => actor === 0x300)).toHaveLength(1);
  });

  it('friends overlook theft, trespass and pickpocketing; allies an assault; nobody murder', () => {
    expect(overlooksCrime(RelationshipRank.friend, false, false)).toBe(true);
    expect(overlooksCrime(RelationshipRank.friend, true, false)).toBe(false);
    expect(overlooksCrime(RelationshipRank.ally, true, false)).toBe(true);
    expect(overlooksCrime(RelationshipRank.lover, true, true)).toBe(false);
  });

  it('a trespasser is warned iGuardWarnings (2) times, fAITrespassWarningTimer apart, then reported', () => {
    const warnings = new TrespassWarnings();
    expect(warnings.seen(0, settings)).toBe('warn');
    expect(warnings.seen(1, settings)).toBe('none');
    expect(warnings.seen(LOAD_ORDER.fAITrespassWarningTimer, settings)).toBe('warn');
    expect(warnings.seen(2 * LOAD_ORDER.fAITrespassWarningTimer, settings)).toBe('crime');
  });

  it.todo('the engine’s report rule (ours: a guard saw it, or a game day passed)  [original]');
  it.todo('an alarm reaches those within iCrimeAlarmRecDistance (4000), low 2000  [settings]');
  it.todo('at most iNumberGuardsCrimeResponse (4) guards answer a crime  [settings]');
  it.todo('fCrimeAlarmRespMult, fCrimeSoundBase / Mult: who hears a crime  [settings]');
  it.todo('NPC crimes: an NPC’s theft, assault and murder seen by others  [engine map]');
  it.todo(
    'iCrimeEnemyCoolDownTimer: how long a crime faction stays the player’s enemy  [settings]',
  );
  it.todo(
    'the fCrimeDisp* and fCrimeRegard* / fCrimeFavor* settings: disposition after a crime  [settings]',
  );
});

describe.skipIf(!hasGamedata())('the crime faction of an actor crime (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('no wolf, chicken, cow or dog base has a crime faction (CRIF); the farm animals are owned', async () => {
    const bases = {
      EncWolf: 0x23abe,
      EncChicken: 0xa91a0,
      EncCow: 0x23a90,
      EncDog: 0x23a92,
    } as const;
    for (const base of Object.values(bases)) {
      const npc = await db.get(base);
      expect(npc && parseNpcStats(npc).crimeFaction).toBeUndefined();
    }
    const placed = new Map<number, { owned: number; all: number }>();
    for (const reference of db.formIdsOfType('ACHR')) {
      const ref = await db.get(reference);
      const base = ref?.formIdField('NAME');
      if (!ref || base === undefined || !Object.values(bases).includes(base as never)) continue;
      const count = placed.get(base) ?? { owned: 0, all: 0 };
      count.all++;
      if (ref.formIdField('XOWN') !== undefined) count.owned++;
      placed.set(base, count);
    }
    // The maintainer's load order (Skyrim.esm, the DLCs, the Creation Club files), 2026-10-24.
    expect(placed.get(bases.EncWolf)).toEqual({ owned: 0, all: 69 });
    expect(placed.get(bases.EncChicken)).toEqual({ owned: 56, all: 102 });
    expect(placed.get(bases.EncCow)).toEqual({ owned: 9, all: 16 });
  }, 300_000);
});

// A wolf placed in the Bannered Mare fights the patrons; the player kills it with Firebolt. A
// creature no crime faction cares for: no murder, no bounty, the Kill Actor story event's crime
// status 0 (OnStoryKillActor: 0 no crime).

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('killing a wild creature (headless simulation)', () => {
  let sim: Sim;
  let wolf = 0;
  let murders = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    murders = sim.runtime.stats.get('murders') ?? 0;
    wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
    await sim.cast(await sim.formId('SPEL', 'Firebolt'), wolf);
    await sim.until(() => sim.deaths().some((death) => death.actor === wolf), 20);
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('dies', () => {
    expect(sim.deaths().some((death) => death.actor === wolf)).toBe(true);
  });

  it('is no murder: the Murders stat stays', () => {
    expect(sim.runtime.stats.get('murders') ?? 0).toBe(murders);
  });

  it('costs no bounty with any faction', () => {
    const gold = [...sim.runtime.state.factions.values()].reduce(
      (sum, entry) => sum + entry.crimeGold + entry.crimeGoldViolent,
      0,
    );
    expect(gold).toBe(0);
  });

  it('tells the story manager’s Kill Actor with crime status 0', () => {
    const kill = sim.storyEvents('KILL').find((event) => event.forms.R1 === wolf);
    expect(kill?.values.V1).toBe(0);
  });

  it.todo(
    'an owned chicken killed in sight: an assault, then murder, to its owner’s crime faction  [UESP Crime]',
  );
  it.todo(
    'a guard who sees the player murder a citizen reports it: 1000 on the hold  [UESP Crime]',
  );
  it.todo(
    'a crime by the player while sneaking unseen: no bounty, the items still stolen  [UESP Crime]',
  );
});
