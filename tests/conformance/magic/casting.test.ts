// Conformance: casting (engine map: Magic, effects, perks > Casting): what a source casts, a
// hand's charge, dual casting, powers and lesser powers, staffs, NPCs' magicka while they cast,
// and how fast a script's Cast loop casts.
//
// Sources:
// - The spells of the load order: `node tools/magic-census.ts` (Skyrim.esm, the DLCs and the
//   Creation Club files of the maintainer's game folder, 2026-10-24).
// - The settings: the engine's defaults (the engine's defaults) and the load order's GMSTs
//   (`node tools/gmst-info.ts --prefix fMagic`): fMagicDualCastingTimeMult 1 (Skyrim.esm; the
//   engine's 1.5), fMagicLesserPowerCooldownTimer 3, bRegenNPCMagickaDuringCast 1, [Controls]
//   fDualCastChordTime 0.05 (the INI default).
// - The engine's rules, observed in the original: a lesser power waits fMagicLesserPowerCooldownTimer; the
//   player's magicka does not regenerate while they cast, an NPC's does with
//   bRegenNPCMagickaDuringCast; natives' registration marks (latent, callable from the script's
//   thread: src/scripting/native-timing.ts).
// - UESP "Skyrim:Staffs" (Staff of Fireball: 2000 charge, 133 a cast), "Skyrim:Powers" (once a
//   day).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePex } from '../../../src/formats/pex/pex.ts';
import {
  beginCast,
  advanceCast,
  CASTING_DEFAULTS,
  castStartEvent,
  chargeSeconds,
  lesserPowerReady,
  powerReady,
  regeneratesWhileCasting,
  releaseCast,
  staffCastsLeft,
  staffChargeCost,
} from '../../../src/gameplay/magic/casting.ts';
import { comesAt, wardHeld } from '../../../src/gameplay/magic/projectile-flight.ts';
import { AT_ONCE_NATIVES, nativeWaitsForFrame } from '../../../src/scripting/native-timing.ts';
import {
  PapyrusVm,
  type AttachedScriptInfo,
  type NativeFunction,
  type VmHost,
} from '../../../src/scripting/papyrus-vm.ts';
import { PapyrusScheduler } from '../../../src/scripting/scheduler.ts';
import { ScriptLibrary } from '../../../src/scripting/script-library.ts';
import { ObjectHandle } from '../../../src/scripting/values.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { CastingSource } from '../../../src/scripting/runtime/casting-engine.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { INI_DEFAULTS } from '../../../src/world/ini-settings.ts';
import { parseMagicItem } from '../../../src/world/magic-records.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { CastType } from '../../../src/world/spell-records.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { magicCensus, type MagicCensus } from '../../../tools/magic-census.ts';
import { buildPex, id, int, type BuildScript } from '../../helpers/pex-builder.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

describe.skipIf(!hasGamedata())('the spells across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let census: MagicCensus;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    census = await magicCensus(db);
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the 1,451 spells by SPIT type', () => {
    expect(Object.fromEntries(census.spellKinds)).toEqual({
      spell: 696,
      ability: 452,
      voice: 175,
      power: 49,
      disease: 42,
      lesserPower: 21,
      spellPoison: 16,
    });
  });

  it('counts the cast types and deliveries the spells use', () => {
    // 0 constant effect, 1 fire and forget, 2 concentration.
    expect(Object.fromEntries(census.spellCastTypes)).toEqual({ 0: 500, 1: 775, 2: 176 });
    // 0 self, 1 touch, 2 aimed, 3 target actor, 4 target location.
    expect(Object.fromEntries(census.spellDeliveries)).toEqual({
      0: 733,
      1: 155,
      2: 451,
      3: 39,
      4: 73,
    });
  });

  it('starts a hand’s cast in the graph for every cast type and delivery a spell uses', () => {
    for (const castType of census.spellCastTypes.keys()) {
      if (castType === CastType.constantEffect) continue;
      for (const delivery of census.spellDeliveries.keys())
        expect(castStartEvent('right', { castType, delivery })).toMatch(/^MRh_Spell/);
    }
  });
});

describe('a hand’s cast', () => {
  it('fires a fire and forget spell released once ready, lets it go before', () => {
    const early = beginCast(CastType.fireAndForget, 0.5);
    advanceCast(early, 0.3);
    expect(releaseCast(early)).toBe('cancel');
    const ready = beginCast(CastType.fireAndForget, 0.5);
    expect(advanceCast(ready, 0.6).began).toBe(true);
    expect(releaseCast(ready)).toBe('fire');
  });

  it('casts a concentration spell from its charge time on, spending the time held', () => {
    const cast = beginCast(CastType.concentration, 0.25);
    expect(advanceCast(cast, 1).casting).toBeCloseTo(0.75, 9);
    expect(releaseCast(cast)).toBe('stop');
  });

  it('charges a dual cast × fMagicDualCastingTimeMult (1 in Skyrim.esm)', () => {
    expect(CASTING_DEFAULTS.dualTimeMult).toBe(1);
    expect(chargeSeconds(0.5, true)).toBe(0.5);
  });

  it('dual casts on both attack buttons within [Controls] fDualCastChordTime (0.05 s)', () => {
    expect(INI_DEFAULTS.Controls.fDualCastChordTime).toBe(0.05);
  });
});

describe('powers, lesser powers and staffs', () => {
  it('uses a power once a game day', () => {
    expect(powerReady(undefined, 3)).toBe(true);
    expect(powerReady(3, 3.99)).toBe(false);
    expect(powerReady(3, 4)).toBe(true);
  });

  it('casts a lesser power again fMagicLesserPowerCooldownTimer (3 s) after its last use', () => {
    expect(CASTING_DEFAULTS.lesserPowerCooldown).toBe(3);
    expect(lesserPowerReady(10, 12.9)).toBe(false);
    expect(lesserPowerReady(10, 13)).toBe(true);
  });

  it('casts the Staff of Fireball 15 times on a full charge (2000, 133 a cast)', () => {
    expect(staffCastsLeft(2000, 133)).toBe(15);
  });
});

describe('magicka while casting', () => {
  it('stops the player’s regeneration while they cast; an NPC’s goes on (bRegenNPCMagickaDuringCast 1)', () => {
    expect(regeneratesWhileCasting(true)).toBe(false);
    expect(regeneratesWhileCasting(false)).toBe(true);
    expect(regeneratesWhileCasting(false, { regenNpcMagickaDuringCast: 0 })).toBe(false);
  });
});

// --- A script's Cast loop -----------------------------------------------------------------------

/** A script that loops `times`: an object native, two that run at once, a wait one, the cast. */
const STORM: BuildScript[] = [
  { name: 'Form' },
  {
    name: 'ObjectReference',
    parent: 'Form',
    functions: [{ name: 'GetPositionX', native: true, returnType: 'Float' }],
  },
  {
    name: 'Math',
    functions: [{ name: 'abs', native: true, returnType: 'Float', params: [['af', 'Float']] }],
  },
  {
    name: 'Utility',
    functions: [
      {
        name: 'RandomFloat',
        native: true,
        returnType: 'Float',
        params: [
          ['afMin', 'Float'],
          ['afMax', 'Float'],
        ],
      },
    ],
  },
  {
    name: 'Debug',
    functions: [{ name: 'Trace', native: true, params: [['asText', 'String']] }],
  },
  {
    name: 'Storm',
    parent: 'ObjectReference',
    functions: [
      { name: 'Fire', native: true },
      {
        name: 'OnStorm',
        locals: [
          ['i', 'Int'],
          ['go', 'Bool'],
          ['x', 'Float'],
          ['::NoneVar', 'None'],
        ],
        code: [
          ['callmethod', id('GetPositionX'), id('self'), id('x')],
          ['callstatic', id('Math'), id('abs'), id('x'), id('x')],
          ['callstatic', id('Utility'), id('RandomFloat'), id('x'), id('x'), id('x')],
          ['callstatic', id('Debug'), id('Trace'), id('::NoneVar'), { kind: 'string', value: '' }],
          ['callmethod', id('Fire'), id('self'), id('::NoneVar')],
          ['iadd', id('i'), id('i'), int(1)],
          ['cmp_lt', id('go'), id('i'), int(10)],
          ['jmpt', id('go'), int(-7)],
        ],
      },
    ],
  },
];

describe('a script’s Cast loop', () => {
  it('runs at once only the natives the engine marks callable from the script’s thread', () => {
    // Observed in the original: 68 of the 669 natives it registers.
    expect(AT_ONCE_NATIVES.size).toBe(68);
    expect(nativeWaitsForFrame('Math', 'sqrt')).toBe(false);
    expect(nativeWaitsForFrame('GlobalVariable', 'GetValue')).toBe(false);
    expect(nativeWaitsForFrame('ObjectReference', 'GetPositionX')).toBe(true);
    expect(nativeWaitsForFrame('Utility', 'RandomFloat')).toBe(true);
    expect(nativeWaitsForFrame('Form', 'RegisterForSingleUpdate')).toBe(true);
    // Latent, though callable there: it returns once the cast is made.
    expect(nativeWaitsForFrame('Spell', 'RemoteCast')).toBe(true);
  });

  it('casts once every three frames when each loop calls three natives of the main thread', async () => {
    const byName = new Map(STORM.map((s) => [s.name.toLowerCase(), parsePex(buildPex(s))]));
    const library = new ScriptLibrary((name) => Promise.resolve(byName.get(name)));
    let frame = 0;
    const fired: number[] = [];
    const host: VmHost = {
      formType: () => Promise.resolve('form'),
      attachedScripts: (): Promise<readonly AttachedScriptInfo[]> =>
        Promise.resolve([{ name: 'Storm', properties: new Map() }]),
      native: (_script: string, fn: string): NativeFunction | undefined => {
        if (fn === 'fire')
          return () => {
            fired.push(frame);
            return null;
          };
        if (fn === 'getpositionx' || fn === 'abs' || fn === 'randomfloat') return () => 1;
        if (fn === 'trace') return () => null;

        return undefined;
      },
      warn: () => undefined,
    };
    const scheduler = new PapyrusScheduler();
    scheduler.framed = true;
    const vm = new PapyrusVm(library, host, scheduler);
    const done = vm.sendEvent(new ObjectHandle(0x100, 'Storm'), 'OnStorm');
    const progress = { finished: false };
    void done.then(() => {
      progress.finished = true;
    });
    while (!progress.finished && frame < 100) {
      for (let i = 0; i < 50; i++) await Promise.resolve();
      frame++;
      scheduler.advance(1 / 60, 0);
    }
    for (let i = 0; i < 50; i++) await Promise.resolve();
    // GetPositionX, RandomFloat and Fire each wait a frame; Math.abs and Debug.Trace do not.
    expect(fired).toHaveLength(10);
    const gaps = fired.slice(1).map((at, i) => at - (fired[i] ?? 0));
    expect(new Set(gaps)).toEqual(new Set([3]));
  });
});

describe('an NPC’s ward', () => {
  it('is held fCombatMagicWardMinCastTime (1.5 s), then while something flies at it', () => {
    expect(wardHeld(1, 1.5, false)).toBe(true);
    expect(wardHeld(2, 1.5, false)).toBe(false);
    expect(wardHeld(2, 1.5, true)).toBe(true);
    // A fireball 1000 units off flying at the actor, one flying away.
    expect(comesAt([0, 1000, 64], [0, -1500, 0], [0, 0, 64], 2048)).toBe(true);
    expect(comesAt([0, 1000, 64], [0, 1500, 0], [0, 0, 64], 2048)).toBe(false);
  });
});

describe.skipIf(!hasGamedata())('casts in the sim', () => {
  let sim: Sim;
  const RIGHT = CastingSource.right;
  /** The Destruction skill's actor value. */
  const DESTRUCTION = 20;

  beforeAll(async () => {
    sim = await openSim({ interior: 0x1605e, hour: 10 });
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  const settle = (): Promise<void> => sim.world.settle();
  const magicka = async (actor: number): Promise<number> =>
    (await sim.runtime.actors.value(actor, ActorValue.magicka)).current;
  const hold = async (seconds: number): Promise<void> => {
    for (let t = 0; t < seconds; t += 0.05) {
      sim.runtime.casting.update(0.05);
      await settle();
    }
  };

  it('casts MQ101’s storm meteors at the game’s rate: its OnUpdate’s natives a frame each, then fRecast', async () => {
    // Alduin's Storm Call (dunCGDragonVoiceStormCall, its self effect's
    // magicProjectileStormScript: fRecast 0.1 s, MQ101's meteors, bMissOnPurpose) on an actor of
    // the inn, at 60 frames a second. Each OnUpdate calls some fifteen natives that wait for the
    // main thread (GetParentCell, RandomFloat, SetPosition, GetPosition*, GetDistance, the
    // latent RemoteCast; docs/scripting.md), so a meteor comes about every 0.1 s + 15 frames;
    // with every native at once it was every 0.12 s.
    const { magic } = sim.runtime;
    const storm = await sim.db.get(await sim.formId('SPEL', 'dunCGDragonVoiceStormCall'));
    const item = storm && parseMagicItem(storm);
    expect(item).toBeDefined();
    if (!item) return;
    const meteor = 729990;
    const actor = sim.actors()[1]?.reference ?? 0;
    const casts: number[] = [];
    let clock = 0;
    const cast = magic.cast.bind(magic);
    magic.cast = (spell, ...rest) => {
      if (spell === meteor) casts.push(clock);
      return cast(spell, ...rest);
    };
    try {
      expect(await magic.apply(item, actor, { caster: actor, effects: [0] })).toBe(1);
      for (let frame = 0; frame < 6 * 60; frame++) {
        clock += 1 / 60;
        await sim.step(1 / 60, 1 / 60);
      }
    } finally {
      magic.cast = cast;
      for (const [key, entry] of magic.effectsOn(actor))
        if (entry.item === item.formId) await magic.end(key);
    }
    expect(casts.length).toBeGreaterThan(5);
    const gaps = casts.slice(1).map((at, i) => at - (casts[i] ?? 0));
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    expect(mean).toBeGreaterThan(0.1 + 10 / 60);
    expect(mean).toBeLessThan(0.1 + 25 / 60);
  }, 180_000);

  it('begins a concentration spell on any magicka, a fire and forget one on its cost', async () => {
    const { casting, equipment, actors } = sim.runtime;
    const flames = await sim.formId('SPEL', 'Flames');
    const firebolt = await sim.formId('SPEL', 'Firebolt');
    const base = (await actors.value(PLAYER_REF, ActorValue.magicka)).base;
    try {
      actors.setBase(PLAYER_REF, ActorValue.magicka, 1);
      expect(await magicka(PLAYER_REF)).toBeCloseTo(1, 6);
      await equipment.equipSpell(PLAYER_REF, firebolt, RIGHT);
      expect(await casting.begin(PLAYER_REF, RIGHT)).not.toBe('started');
      await equipment.equipSpell(PLAYER_REF, flames, RIGHT);
      expect(await casting.begin(PLAYER_REF, RIGHT)).toBe('started');
      casting.interrupt(PLAYER_REF, RIGHT);
      actors.setBase(PLAYER_REF, ActorValue.magicka, 0);
      expect(await casting.begin(PLAYER_REF, RIGHT)).not.toBe('started');
      // Held on what it has, it stops as the magicka is out.
      actors.setBase(PLAYER_REF, ActorValue.magicka, 4);
      expect(await casting.begin(PLAYER_REF, RIGHT)).toBe('started');
      await hold(3);
      expect(casting.casting(PLAYER_REF, RIGHT)).toBeUndefined();
      expect(await magicka(PLAYER_REF)).toBeLessThanOrEqual(0);
    } finally {
      casting.interrupt(PLAYER_REF);
      actors.setBase(PLAYER_REF, ActorValue.magicka, base);
    }
  }, 60_000);

  it('makes an NPC of Destruction 50 pay Firebolt by the NPC formula: 41.39 × 0.25', async () => {
    const { casting, equipment, actors } = sim.runtime;
    const npc = sim.actors()[0]?.reference;
    expect(npc).toBeDefined();
    if (npc === undefined) return;
    const firebolt = await sim.formId('SPEL', 'Firebolt');
    actors.setBase(npc, DESTRUCTION, 50);
    actors.setBase(npc, ActorValue.magicka, 500);
    await equipment.equipSpell(npc, firebolt, RIGHT);
    expect(await casting.begin(npc, RIGHT)).toBe('started');
    await hold(1);
    const before = await magicka(npc);
    expect(await casting.release(npc, RIGHT)).toBeDefined();
    // (1 − (0.005 × 50) ^ 0.5) × 0.5: the settings' fMagicCaster and fMagicSkillCost values.
    expect(before - (await magicka(npc))).toBeCloseTo(41.39 * 0.25, 1);
  }, 60_000);

  it('reaches a Touch spell as far as its caster’s race unarmed, an object’s by fCombatDistance', async () => {
    const { casting, actors } = sim.runtime;
    const race = await actors.race((await actors.raceOf(PLAYER_REF)) ?? 0);
    expect(race?.unarmedReach).toBeGreaterThan(0);
    expect(await casting.touchReach(PLAYER_REF)).toBeCloseTo(race?.unarmedReach ?? 0, 3);
    // Not fMagicDefaultTouchDistance, which nothing reads.
    const distance = await sim.runtime.gameSetting('fCombatDistance');
    const notAnActor = 0x7f000003;
    expect(await casting.touchReach(notAnActor)).toBe(distance);
  }, 60_000);

  it('interrupts a cast by a stagger and by a knock-down', async () => {
    const { casting, equipment } = sim.runtime;
    const stage = sim.world.stage;
    const flames = await sim.formId('SPEL', 'Flames');
    await sim.step(0.5);
    const everyone = sim.actors().map((actor) => actor.reference);
    for (const actor of everyone) {
      sim.runtime.actors.setBase(actor, ActorValue.magicka, 5000);
      await equipment.equipSpell(actor, flames, RIGHT);
      expect(await casting.begin(actor, RIGHT)).toBe('started');
    }
    // Each is staggered. One whose idle tree takes no stagger now (at furniture) stays as it was
    // and casts on; each it took stops, every hand of it.
    for (const actor of everyone) stage.combat.stagger(actor, 1, undefined);
    await sim.step(0.2);
    const still = everyone.filter((actor) => casting.casting(actor, RIGHT) !== undefined);
    expect(still.length).toBeLessThan(everyone.length);
    expect(still.length).toBeGreaterThan(0);
    // One still casting is knocked down.
    const fallen = still[0] ?? 0;
    await stage.combat.knockDown(fallen, undefined, 100);
    await sim.step(0.2);
    expect(casting.casting(fallen, RIGHT)).toBeUndefined();
    for (const actor of everyone) casting.interrupt(actor);
  }, 60_000);

  it('lets a Staff of Flames use its charge a second, and an NPC’s use none', async () => {
    const { casting, crafting } = sim.runtime;
    const staff = await sim.formId('WEAP', 'StaffFlames');
    const record = await sim.db.get(staff);
    const enchantment = record?.formIdField('EITM');
    const item = enchantment === undefined ? undefined : await sim.runtime.magic.item(enchantment);
    expect(item?.kind).toBe('staffEnchantment');
    if (!item) return;
    const castable = { item, via: 'staff', object: staff } as const;
    const npc = sim.actors()[2]?.reference ?? 0;
    await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(staff), 1, true);
    await sim.runtime.addItem(npc, sim.runtime.formHandle(staff), 1, true);
    await sim.runtime.equipment.equip(PLAYER_REF, staff, { hand: 'right' });
    await sim.runtime.equipment.equip(npc, staff, { hand: 'right' });
    const before = await casting.charge(PLAYER_REF, castable);
    const { charge } = await casting.cost(PLAYER_REF, castable);
    expect(charge).toBeGreaterThan(0);
    expect(await casting.begin(PLAYER_REF, RIGHT)).toBe('started');
    expect(await casting.begin(npc, RIGHT)).toBe('started');
    await hold(2);
    casting.interrupt(PLAYER_REF, RIGHT);
    casting.interrupt(npc, RIGHT);
    await settle();
    const used = before - (await casting.charge(PLAYER_REF, castable));
    expect(used).toBeGreaterThan(charge * 1.5);
    expect(used).toBeLessThan(charge * 2.5);
    expect(crafting.keptCharge(npc, staff)).toBeUndefined();
  }, 60_000);
});

describe('what a staff uses', () => {
  it('uses less with its school’s skill: about 1.7 times the uses at 100 (UESP "Skyrim:Staves")', () => {
    expect(staffChargeCost(133, 0)).toBe(133);
    expect(133 / staffChargeCost(133, 100)).toBeCloseTo(1.68, 2);
    expect(staffCastsLeft(2000, staffChargeCost(133, 100))).toBe(25);
  });
});

describe('an NPC’s ward past fCombatMagicWardMinCastTime (inferred: the ward caster’s limit)', () => {
  it('lets it go once its magicka share is below fCombatMagicWardMagickaCastLimit (0.25)', () => {
    // Before the minimum it holds whatever its magicka; past it, while something comes at it and
    // it has the share it needs to begin one (chooseCaster's cast limit).
    expect(wardHeld(1, 1.5, false, 0.1)).toBe(true);
    expect(wardHeld(2, 1.5, true, 0.5)).toBe(true);
    expect(wardHeld(2, 1.5, true, 0.25)).toBe(true);
    expect(wardHeld(2, 1.5, true, 0.2)).toBe(false);
    expect(wardHeld(2, 1.5, true, 0.2, 0.1)).toBe(true);
  });
});
