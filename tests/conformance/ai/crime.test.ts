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
  guardAnswers,
  isViolent,
  jailDays,
  jailSkillLosses,
  readCrimeSettings,
  TrespassWarnings,
} from '../../../src/gameplay/crime.ts';
import { alarmReaches, readDetectionSettings } from '../../../src/ai/detection.ts';
import { doesFavor, overlooksCrime, RelationshipRank } from '../../../src/gameplay/factions.ts';
import { ObjectHandle } from '../../../src/scripting/values.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { parseNpcStats } from '../../../src/world/actor-stats-records.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';
import { INERT } from '../../../tools/ai-combat-completeness.ts';
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

  it('jail: a day per iCrimeDaysInPrisonMod (100) gold, one to iCrimeMaxNumberofDaysinJail (7)', () => {
    expect(jailDays(500, settings)).toBe(5);
    expect(jailDays(1040, settings)).toBe(7);
    expect(jailDays(5, settings)).toBe(1);
  });

  it('iCrimeGoldMinValue is never read: a cheap theft costs no least bounty (original)', () => {
    expect(INERT.has('iCrimeGoldMinValue')).toBe(true);
    expect(crimeBounty(CrimeType.steal, defaults, { value: 2 })).toBe(1);
  });

  it('jail resets the bounty × fCrimeGoldSkillPenaltyMult (0.1) skills of least progress', () => {
    const progress = [
      [6, 5],
      [10, 1],
      [14, 3],
    ] as const;
    expect(settings.goldSkillPenaltyMult).toBeCloseTo(0.1, 6);
    expect(jailSkillLosses(20, progress, settings)).toEqual([10, 14]);
    expect(jailSkillLosses(5, progress, settings)).toEqual([]);
  });

  it('the werewolf is not violent crime gold: only assault and murder are (original)', () => {
    expect(isViolent(CrimeType.werewolf)).toBe(false);
  });
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

  it('a guard among the witnesses is no exception: forgiven within the timer (original)', () => {
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
    expect(ledger.expire(29, settings.killWitnessesTimer)).toHaveLength(0);
    expect(ledger.witnessDied(0x300)).toHaveLength(1);
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

  it('the report rule: after fKillWitnessesTimerSetting (30 s) a crime stands (original)', () => {
    const ledger = new CrimeLedger();
    ledger.commit({
      type: CrimeType.attack,
      criminal: PLAYER_REF,
      victim: 0x100,
      faction: 0x200,
      gold: 40,
      violent: true,
      witnesses: [0x100],
      at: 0,
    });
    expect(settings.killWitnessesTimer).toBe(30);
    expect(ledger.expire(30, settings.killWitnessesTimer)).toHaveLength(1);
    expect(ledger.witnessDied(0x100)).toEqual([]);
  });

  it('an alarm reaches iCrimeAlarmRecDistance (4000) at the criminal’s level, else 2000', () => {
    const detection = readDetectionSettings();
    expect(alarmReaches(detection, true, 4000)).toBe(true);
    expect(alarmReaches(detection, true, 4001)).toBe(false);
    expect(alarmReaches(detection, false, 2000)).toBe(true);
    expect(alarmReaches(detection, false, 2001)).toBe(false);
  });

  it('at most iNumberGuardsCrimeResponse (4) guards answer a criminal (original)', () => {
    expect(guardAnswers(3, 4)).toBe(true);
    expect(guardAnswers(4, 4)).toBe(false);
  });

  it('fCrimeAlarmRespMult, fCrimeSoundBase / Mult are never read (original)', () => {
    for (const name of ['fCrimeAlarmRespMult', 'fCrimeSoundBase', 'fCrimeSoundMult']) {
      expect(INERT.get(name)).toBe('never read');
    }
  });

  it('the fCrimeDisp* and fCrimeRegard* settings are never read: no disposition (original)', () => {
    for (const name of [
      'fCrimeDispAttack',
      'fCrimeDispMurder',
      'fCrimeDispSteal',
      'fCrimeDispPickpocket',
      'fCrimeDispTresspass',
      'fCrimeDispPersonal',
      'fCrimeRegardMult',
      'fCrimePersonalRegardMult',
      'fCrimeWitnessRegardMult',
      'iCrimeRegardBaseValue',
    ]) {
      expect(INERT.get(name)).toBe('never read');
    }
  });

  // The original reads these two only in its check of whether an actor does the player a favor
  // (the cost against the relationship rank), the favors' system, not crime's; the comparison's
  // form is inferred (factions.ts doesFavor), the follower's command its use (actor-favors.ts).
  it('fCrimeFavorMult, iCrimeFavorBaseValue in the favor check  [favors, not crime] (inferred)', () => {
    const favors = readCrimeSettings();
    expect(favors.favorBaseValue).toBe(0);
    expect(favors.favorMult).toBe(1);
    // A cost of 25 (MQ102RikkeWaitMarker's XFVC): a friend's 25 favor points cover it, an
    // acquaintance's none do not.
    expect(doesFavor(RelationshipRank.friend, 25, favors)).toBe(true);
    expect(doesFavor(RelationshipRank.acquaintance, 25, favors)).toBe(false);
    expect(doesFavor(RelationshipRank.friend, 26, favors)).toBe(false);
    expect(doesFavor(RelationshipRank.confidant, 26, favors)).toBe(true);
    // No cost: done whatever the relationship.
    expect(doesFavor(RelationshipRank.acquaintance, 0, favors)).toBe(true);
    // The settings weigh the price: a base value and a mult of the load order's.
    const dear = readCrimeSettings({
      number: (name) =>
        name === 'iCrimeFavorBaseValue' ? 10 : name === 'fCrimeFavorMult' ? 2 : undefined,
    });
    expect(doesFavor(RelationshipRank.ally, 45, dear)).toBe(true);
    expect(doesFavor(RelationshipRank.ally, 46, dear)).toBe(false);
  });
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
  let guard = 0;
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

  it('a crime by the player unseen: no bounty, the items still stolen  [UESP Crime]', async () => {
    const { crime } = sim.runtime;
    const world = crime.world;
    const apple = await sim.formId('MISC', 'Lockpick');
    const item = await sim.place(apple, PLAYER_REF);
    crime.world = { witnesses: () => [] };
    const committed = await crime.steal(PLAYER_REF, apple, 1, item);
    crime.world = world;
    expect(committed).toBeUndefined();
    expect(crime.stolenCount(PLAYER_REF, apple)).toBe(1);
    const owed = [...sim.runtime.state.factions.values()].reduce(
      (sum, entry) => sum + entry.crimeGold + entry.crimeGoldViolent,
      0,
    );
    expect(owed).toBe(0);
  });

  it('a guard who only hears an NPC’s alarm answers it', async () => {
    const { runtime } = sim;
    const whiterun = await sim.formId('FACT', 'CrimeFactionWhiterun');
    const placedGuard = await sim.place(await guardBase(sim, whiterun), PLAYER_REF);
    guard = placedGuard;
    expect(await sim.until(() => sim.actor(guard) !== undefined, 20)).toBe(true);
    expect(await runtime.crime.isGuard(placedGuard)).toBe(true);
    const citizens: number[] = [];
    for (const actor of sim.actors()) {
      if (actor.dead || actor.reference === guard) continue;
      if ((await runtime.actors.crimeFaction(actor.reference)) !== whiterun) continue;
      if (!(await runtime.crime.isGuard(actor.reference))) citizens.push(actor.reference);
    }
    const [victim, criminal] = citizens;
    expect(criminal).toBeDefined();
    if (victim === undefined || criminal === undefined) return;
    expect(await runtime.actors.crimeFaction(placedGuard)).toBe(whiterun);
    // The senses take it up a moment after it is staged.
    const senses = sim.world.stage.senses;
    await sim.until(() => senses.alarm(victim, criminal, 'steal').includes(placedGuard), 20);
    const started: [number, number][] = [];
    const start = runtime.world.startCombat?.bind(runtime.world);
    runtime.world.startCombat = (actor, target) => {
      started.push([actor, target]);
    };
    // Only the victim sees it: the guard beside them hears the alarm.
    await runtime.crime.commit(CrimeType.steal, criminal, {
      act: 'steal',
      victim,
      faction: whiterun,
      witnesses: [victim],
    });
    await sim.step(0.5);
    expect(started).toContainEqual([placedGuard, criminal]);
    runtime.world.startCombat = start;
  });

  it('SetPlayerEnemy lasts iCrimeEnemyCoolDownTimer (24) game hours (original)', async () => {
    const { runtime } = sim;
    const faction = await sim.formId('FACT', 'CrimeFactionRift');
    await sim.native(new ObjectHandle(faction, 'faction'), 'Faction', 'SetPlayerEnemy', [true]);
    expect(runtime.state.factions.get(faction)?.playerEnemy).toBe(true);
    await runtime.crime.update();
    expect(runtime.state.factions.get(faction)?.playerEnemy).toBe(true);
    runtime.state.gameDaysPassed += 1.01;
    await runtime.crime.update();
    expect(runtime.state.factions.get(faction)?.playerEnemy).toBe(false);
  });

  it('a guard who sees the player murder a citizen: 1000 on the hold  [UESP Crime]', async () => {
    const { runtime } = sim;
    const whiterun = await sim.formId('FACT', 'CrimeFactionWhiterun');
    const before = runtime.state.factions.get(whiterun)?.crimeGoldViolent ?? 0;
    let victim: number | undefined;
    for (const actor of sim.actors()) {
      if (actor.dead || (await runtime.actors.crimeFaction(actor.reference)) !== whiterun) continue;
      if (!(await runtime.crime.isGuard(actor.reference))) victim ??= actor.reference;
    }
    expect(victim).toBeDefined();
    if (victim === undefined) return;
    const world = runtime.crime.world;
    runtime.crime.world = { witnesses: () => [guard] };
    const seen = await runtime.crime.murder(PLAYER_REF, victim);
    runtime.crime.world = world;
    expect(seen?.gold).toBe(1000);
    expect(runtime.state.factions.get(whiterun)?.crimeGoldViolent).toBe(before + 1000);
  });

  it('an owned chicken killed in sight: an assault, then murder, to its owner’s faction  [UESP Crime]', async () => {
    const { runtime } = sim;
    const whiterun = await sim.formId('FACT', 'CrimeFactionWhiterun');
    const before = runtime.state.factions.get(whiterun)?.crimeGoldViolent ?? 0;
    const chicken = await sim.place(await sim.formId('NPC_', 'EncChicken'), PLAYER_REF);
    runtime.state.reference(chicken).ownerActor = await sim.formId('NPC_', 'Hulda');
    await sim.step(0.5);
    const world = runtime.crime.world;
    const witnesses = sim
      .actors()
      .map((actor) => actor.reference)
      .filter((actor) => actor !== chicken);
    runtime.crime.world = { witnesses: () => witnesses };
    const assault = await runtime.crime.assault(PLAYER_REF, chicken);
    const murder = await runtime.crime.murder(PLAYER_REF, chicken);
    runtime.crime.world = world;
    expect(assault?.faction).toBe(whiterun);
    expect(murder?.faction).toBe(whiterun);
    expect(runtime.state.factions.get(whiterun)?.crimeGoldViolent).toBe(before + 1040);
  });
});

/** A guard base of a crime faction (a named NPC_ whose base says so, placed to be asked). */
async function guardBase(sim: Sim, faction: number): Promise<number> {
  const { db } = sim.runtime.forms;
  for (const base of db.formIdsOfType('NPC_')) {
    const npc = await db.get(base);
    if (!npc || !/guard/i.test(npc.editorId ?? '') || !/whiterun/i.test(npc.editorId ?? ''))
      continue;
    if (parseNpcStats(npc).crimeFaction === faction) return base;
  }
  throw new Error('no guard base');
}

describe.skipIf(!hasGamedata())('jailed with a follower (headless simulation)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('the follower waits at the hold’s follower wait marker (FACT WAIT)  [UESP Followers]', async () => {
    const runtime = sim.runtime;
    const faction = await sim.formId('FACT', 'CrimeFactionWhiterun');
    const marker = (await runtime.crime.factionCrime(faction))?.followerWaitMarker;
    expect(marker).toBeDefined();
    const [follower] = sim.actors();
    expect(follower).toBeDefined();
    if (marker === undefined || !follower) return;
    runtime.state.actor(follower.reference).playerTeammate = true;
    await runtime.crime.jail(faction, false, true);
    const placed = runtime.state.references.get(follower.reference)?.position;
    const now = placed && ([placed[0], placed[1]] as const);
    const at = await runtime.placement(marker, false);
    // The player's jail cell loads (as the world does when they are taken there).
    await sim.openAtPlayer();
    expect(at && now).toBeTruthy();
    if (!at || !now) return;
    expect(Math.hypot(now[0] - at.position[0], now[1] - at.position[1])).toBeLessThan(1);
  }, 300_000);
});
