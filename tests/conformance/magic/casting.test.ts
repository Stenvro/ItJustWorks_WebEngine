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
import { INI_DEFAULTS } from '../../../src/world/ini-settings.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { CastType } from '../../../src/world/spell-records.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { magicCensus, type MagicCensus } from '../../../tools/magic-census.ts';
import { buildPex, id, int, type BuildScript } from '../../helpers/pex-builder.ts';
import { hasGamedata } from '../../helpers/sim.ts';

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

  it.todo(
    'MQ101: dunCGDragonVoiceStormCall’s magicProjectileStormScript casts a meteor at the ' +
      'game’s rate, its OnUpdate’s natives a frame each plus fRecast (the opening in the sim; ' +
      'docs/scripting.md)',
  );
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

describe('what the original casts that we do not yet', () => {
  it.todo(
    'a concentration spell is refused only once the magicka is out (what the engine asks of ' +
      'the magicka before a concentration cast, original)',
  );
  it.todo('an NPC’s ward past fCombatMagicWardMinCastTime as the combat AI’s ward behaviour says');
  it.todo(
    'a Touch spell reaches as far as the engine says (fMagicDefaultTouchDistance is never read)',
  );
  it.todo('the casting hand’s cast is interrupted by a stagger and a knock-down (original)');
});
