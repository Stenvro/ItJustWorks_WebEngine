// Conformance: perks (engine map: Magic, effects, perks > Perks): every perk entry point the load
// order's perks use is known and asked by the systems it belongs to.
//
// Sources:
// - The perks of the load order (PERK entries: `node tools/perk-info.ts --audit`).
// - The entry points' names and condition tabs: xEdit, UESP "Skyrim Mod:Mod File Format/PERK".

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTRY_POINTS, EntryPoint } from '../../../src/gameplay/perk-entry-points.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { parsePerk } from '../../../src/world/perk-records.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata } from '../../helpers/sim.ts';
import { USAGE_MONITOR_EFFECT } from '../../../src/gameplay/magic/addiction.ts';
import type { MagicItemRecord } from '../../../src/world/magic-records.ts';
import {
  isMine,
  MAX_PLAYER_RUNES,
  mineBursts,
  runesGivingWay,
} from '../../../src/gameplay/magic/projectile-flight.ts';
import { Layer } from '../../../src/physics/collision-layers.ts';
import type { PhysicsWorld } from '../../../src/physics/physics-world.ts';
import type { Vec3 } from '../../../src/render/math.ts';
import type { RenderPort } from '../../../src/render/render-port.ts';
import { PLAYER_REF } from '../../../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../../../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../../../src/scripting/script-library.ts';
import type { GameSession } from '../../../src/shell/game-session.ts';
import { MagicProjectiles } from '../../../src/shell/magic-projectiles.ts';
import type { Terminal } from '../../../src/shell/terminal.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { EffectArchetype } from '../../../src/world/magic-effects.ts';
import {
  ProjectileFlag,
  ProjectileType,
  type ProjectileRecord,
} from '../../../src/world/projectile-data.ts';

/** Every engine source file's text (src/, not the entry point table itself, not tests). */
function engineSources(dir: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) engineSources(at, into);
    else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      entry.name !== 'perk-entry-points.ts'
    )
      into.push(fs.readFileSync(at, 'utf8'));
  }
  return into;
}

describe.skipIf(!hasGamedata())('the perks across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const used = new Map<number, number>();
  let perks = 0;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const formId of db.formIdsOfType('PERK')) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      perks++;
      for (const entry of parsePerk(record).entries)
        if (entry.kind === 'entryPoint')
          used.set(entry.entryPoint, (used.get(entry.entryPoint) ?? 0) + 1);
    }
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the 483 perks and the 68 entry points they use', () => {
    expect(perks).toBe(483);
    expect(used.size).toBe(68);
    for (const id of used.keys()) expect(ENTRY_POINTS[id], String(id)).toBeDefined();
  });

  it('asks every entry point the perks use from the system it belongs to', () => {
    const sources = engineSources(path.resolve(import.meta.dirname, '../../../src')).join('\n');
    const names = new Map<number, string>(
      Object.entries(EntryPoint).map(([name, id]) => [id, name]),
    );
    const unasked = [...used.keys()].filter((id) => {
      const name = names.get(id);
      return name === undefined || !sources.includes(`EntryPoint.${name}`);
    });
    expect(unasked.map((id) => ENTRY_POINTS[id]?.name ?? String(id))).toEqual([]);
  });
});

describe('the entry points no vanilla perk uses that the engine asks (mods)', () => {
  // Observed in the original: the engine asks Get Should Attack, Mod Max Placeable Mines (of the
  // player, for iMaxPlayerRunes), Mod Secondary Value Weight (as a Dual Value Modifier is
  // adjusted for its caster's perks), Calculate Mine Explode Chance, Adjust Limb Damage and Mod
  // Addiction Chance; where it asks the first and the last three is inferred here.
  it('asks them from the systems they belong to', () => {
    const sources = engineSources(path.resolve(import.meta.dirname, '../../../src')).join('\n');
    for (const name of [
      'getShouldAttack',
      'modMaxPlaceableMines',
      'modSecondaryValueWeight',
      'calculateMineExplodeChance',
      'adjustLimbDamage',
      'modAddictionChance',
    ])
      expect(sources.includes(`EntryPoint.${name}`), name).toBe(true);
  });

  it('keeps the newest of the player’s runes beyond iMaxPlayerRunes (1), as perks leave it', () => {
    const at = (restedAt: number, caster = PLAYER_REF) => ({ caster, restedAt });
    const runes = [at(3), at(1), at(2), at(0, 0x1234)];
    expect(runesGivingWay(runes, PLAYER_REF, MAX_PLAYER_RUNES)).toEqual([at(1), at(2)]);
    expect(runesGivingWay(runes, PLAYER_REF, 3)).toEqual([]);
  });

  /** The player's runes falling onto the ground: projectiles with a runtime and physics stubbed. */
  async function placed(
    maxRunes: number,
    mine?: {
      readonly chance: number;
      readonly xs?: readonly number[];
      readonly walker?: number;
      readonly frames?: number;
    },
  ): Promise<number[]> {
    const SPELL = 0x2001;
    const RUNE = {
      formId: 0x3001,
      editorId: 'RuneProjectile',
      flags: ProjectileFlag.altTrigger,
      type: ProjectileType.lobber,
      gravity: 0,
      speed: 10,
      range: 2000,
      light: undefined,
      muzzleFlashLight: undefined,
      tracerChance: 0,
      proximity: 60,
      timer: 0,
      explosion: undefined,
      sound: undefined,
      muzzleFlashDuration: 0,
      fadeDuration: 0,
      impactForce: 0,
      countdownSound: undefined,
      disableSound: undefined,
      defaultWeaponSource: undefined,
      coneSpread: 0,
      collisionRadius: 1,
      lifetime: 0,
      relaunchInterval: 0,
      decal: undefined,
      collisionLayer: undefined,
      model: undefined,
      muzzleFlashModel: undefined,
      soundLevel: 1,
    } satisfies ProjectileRecord;
    const item = { formId: SPELL, effects: [], delivery: 4 };
    const runtime = {
      magic: { item: () => Promise.resolve(item) },
      casting: {
        projectile: () => Promise.resolve(RUNE),
        cost: () => Promise.resolve(0),
        mainEffect: () => Promise.resolve(undefined),
      },
      gameSetting: (name: string) => Promise.resolve(name === 'iMaxPlayerRunes' ? 1 : undefined),
      perks: {
        apply: (entryPoint: number, _owner: number, value: number) =>
          Promise.resolve(
            entryPoint === EntryPoint.modMaxPlaceableMines
              ? maxRunes
              : entryPoint === EntryPoint.calculateMineExplodeChance
                ? (mine?.chance ?? value)
                : value,
          ),
      },
    };
    const session = {
      scriptsReady: runtime,
      settings: () => new Promise(() => undefined),
      model: () => Promise.resolve(undefined),
    };
    // The ground at z 0.
    const physics = {
      matrix: { indexOf: () => Layer.spell },
      raycast: (origin: Vec3, direction: Vec3, length: number) => {
        if (direction[2] >= 0) return undefined;
        const distance = origin[2] / -direction[2];
        if (distance > length) return undefined;
        return {
          distance,
          point: [origin[0] + direction[0] * distance, origin[1] + direction[1] * distance, 0],
          normal: [0, 0, 1],
          layer: Layer.static,
          owner: { kind: 'landscape' },
          material: 0,
          collider: { parent: () => null },
        };
      },
      knock: () => false,
      movingPose: () => undefined,
    };
    // An actor walking up to the first rune once they rest: within its proximity, not on it.
    let walker:
      | {
          reference: number;
          heading: number;
          shape: { feet: Vec3; height: number; radius: number };
        }
      | undefined;
    const magic = new MagicProjectiles({
      session: session as unknown as GameSession,
      renderer: {} as RenderPort,
      terminal: { log: () => undefined } as unknown as Terminal,
      targets: () => (walker ? [walker] : []),
    });
    magic.attach(physics as unknown as PhysicsWorld);
    for (const x of mine?.xs ?? [100, 200, 300]) {
      await magic.restore([
        {
          projectile: RUNE.formId,
          item: SPELL,
          via: 'spell',
          // A mine of the tests is another's (its caster sets it off never).
          caster: mine ? 0x5555 : PLAYER_REF,
          dual: false,
          position: [x, 0, 2],
          velocity: [0, 0, -10],
          traveled: 0,
          age: 0,
        },
      ]);
      magic.frame(0.5);
      for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (mine) {
      walker = {
        reference: mine.walker ?? PLAYER_REF,
        heading: 0,
        shape: { feet: [140, 0, 0], height: 128, radius: 30 },
      };
      for (let frame = 0; frame < (mine.frames ?? 3); frame++) {
        magic.frame(0.1);
        for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return magic
      .save()
      .filter((saved) => saved.resting === true)
      .map((saved) => saved.position[0]);
  }

  it('takes the player’s oldest rune away as the next comes to rest', async () => {
    expect(await placed(1)).toEqual([300]);
    // A mod's perk raising Mod Max Placeable Mines keeps more.
    expect(await placed(2)).toEqual([200, 300]);
  });

  it('bursts a mine for one who comes near as their Calculate Mine Explode Chance says', async () => {
    expect(isMine({ flags: ProjectileFlag.altTrigger, proximity: 10 })).toBe(true);
    expect(isMine({ flags: ProjectileFlag.altTrigger, proximity: 0 })).toBe(false);
    expect(mineBursts(100, 0.99)).toBe(true);
    expect(mineBursts(30, 0.5)).toBe(false);
    // Without perks the chance is 100: the rune is gone fMinesDelayMin (0.1 s) after;
    // a perk setting it to 0 lets the player pass it for good.
    expect(await placed(1, { chance: 100, xs: [100] })).toEqual([]);
    expect(await placed(1, { chance: 0, xs: [100], frames: 6 })).toEqual([100]);
    // Another actor sets it off without a roll.
    expect(await placed(1, { chance: 0, xs: [100], walker: 0x1234 })).toEqual([]);
  });
});

describe('Mod Secondary Value Weight (observed in the original: the caster’s perks)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;

  beforeAll(async () => {
    if (!hasGamedata()) return;
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const at = `scripts\\${name}.pex`;
      return vfs.has(at) ? vfs.read(at) : undefined;
    });
    runtime = new ScriptRuntime(db, library);
    await runtime.magic.prepare(PLAYER_REF);
  }, 300_000);
  afterAll(async () => {
    if (!hasGamedata()) return;
    await db.close();
    await vfs.close();
  });

  it.skipIf(!hasGamedata())(
    'weighs a Dual Value Modifier’s second value as the caster’s perks say',
    async () => {
      const { magic, actors, perks } = runtime;
      let oakflesh = 0;
      for (const formId of db.formIdsOfType('SPEL'))
        if ((await db.get(formId))?.editorId === 'Oakflesh') oakflesh = formId;
      const oak = await magic.item(oakflesh);
      const first = oak?.effects[0];
      const base = first && (await magic.effect(first.effect));
      if (!oak || !first || !base) throw new Error('Oakflesh not read');
      // Oakflesh's effect as a Dual Value Modifier: Damage Resist and, at 0.5, Stamina.
      const dual = 0x7f000401;
      const reader = magic.effect.bind(magic);
      magic.effect = (formId) =>
        formId === dual
          ? Promise.resolve({
              ...base,
              formId,
              archetype: EffectArchetype.dualValueModifier,
              secondActorValue: ActorValue.stamina,
              secondValueWeight: 0.5,
            })
          : reader(formId);
      const item = {
        ...oak,
        formId: 0x7f000402,
        effects: [{ ...first, effect: dual, magnitude: 40 }],
      };
      const applier = perks.apply.bind(perks);
      let doubled = false;
      perks.apply = (entryPoint, owner, value, targets, context) =>
        doubled && entryPoint === EntryPoint.modSecondaryValueWeight
          ? Promise.resolve(value * 2)
          : applier(entryPoint, owner, value, targets, context);
      const stamina = async (): Promise<number> =>
        (await actors.value(PLAYER_REF, ActorValue.stamina)).max;
      try {
        const before = await stamina();
        await magic.apply(item, PLAYER_REF, { caster: PLAYER_REF });
        expect((await stamina()) - before).toBeCloseTo(20, 6);
        for (const [key, entry] of magic.effectsOn(PLAYER_REF))
          if (entry.item === item.formId) await magic.end(key);
        expect(await stamina()).toBeCloseTo(before, 6);
        doubled = true;
        await magic.apply(item, PLAYER_REF, { caster: PLAYER_REF });
        expect((await stamina()) - before).toBeCloseTo(40, 6);
        for (const [key, entry] of magic.effectsOn(PLAYER_REF))
          if (entry.item === item.formId) await magic.end(key);
      } finally {
        magic.effect = reader;
        perks.apply = applier;
      }
    },
    60_000,
  );
});

describe('Mod Addiction Chance (the engine asks it; no vanilla potion has an addiction)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;

  beforeAll(async () => {
    if (!hasGamedata()) return;
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const at = `scripts\\${name}.pex`;
      return vfs.has(at) ? vfs.read(at) : undefined;
    });
    runtime = new ScriptRuntime(db, library);
    await runtime.magic.prepare(PLAYER_REF);
  }, 300_000);
  afterAll(async () => {
    if (!hasGamedata()) return;
    await db.close();
    await vfs.close();
  });

  it.skipIf(!hasGamedata())(
    'gives a potion’s addiction by its chance as the drinker’s perks change it',
    async () => {
      const { magic, actors, perks } = runtime;
      let potion = 0;
      let addiction = 0;
      // A potion of the load order, and an ability as the addiction it gives.
      for (const formId of db.formIdsOfType('ALCH')) {
        const item = await magic.item(formId);
        if (item?.potion && item.kind !== 'poison' && item.kind !== 'food') {
          potion = formId;
          break;
        }
      }
      for (const formId of db.formIdsOfType('SPEL'))
        if ((await magic.item(formId))?.kind === 'ability') {
          addiction = formId;
          break;
        }
      const base = await magic.item(potion);
      if (!base?.potion || addiction === 0) throw new Error('potion or spell not read');
      // Observed in the original: a chance of 0 gives no addiction and asks no perk.
      const never = {
        ...base,
        formId: 0x7f000500,
        potion: { ...base.potion, addiction, addictionChance: 0 },
      };
      const addictive = {
        ...base,
        formId: 0x7f000501,
        potion: { ...base.potion, addiction, addictionChance: 0.5 },
      };
      // Potions carrying the engine's Usage Monitor Effect (600 s; a drink of the same potion
      // replaces the monitor its last drink left, as any recast of the same item).
      const potionData = base.potion;
      const monitoredBy = (formId: number, magnitude: number) => ({
        ...base,
        formId,
        effects: [
          ...base.effects,
          { effect: USAGE_MONITOR_EFFECT, magnitude, area: 0, duration: 600, conditions: [] },
        ],
        potion: { ...potionData, addiction, addictionChance: 0.5 },
      });
      const light = monitoredBy(0x7f000502, 60);
      const monitored = monitoredBy(0x7f000503, 75);
      const made = new Map<number, MagicItemRecord>(
        [never, addictive, light, monitored].map((item): [number, MagicItemRecord] => [
          item.formId,
          item,
        ]),
      );
      const reader = magic.item.bind(magic);
      magic.item = (formId) => {
        const item = made.get(formId);
        return item ? Promise.resolve(item) : reader(formId);
      };
      const applier = perks.apply.bind(perks);
      let chance = 0;
      const asked: number[] = [];
      perks.apply = (entryPoint, owner, value, targets, context) => {
        if (entryPoint !== EntryPoint.modAddictionChance)
          return applier(entryPoint, owner, value, targets, context);
        asked.push(value);
        return Promise.resolve(chance);
      };
      try {
        chance = 1;
        await magic.consumed(PLAYER_REF, never.formId);
        expect(asked).toEqual([]);
        expect(await actors.hasSpell(PLAYER_REF, addiction)).toBe(false);
        // The potion's chance through the perks, rolled.
        chance = 0;
        await magic.consumed(PLAYER_REF, addictive.formId);
        expect(asked).toEqual([0.5]);
        expect(await actors.hasSpell(PLAYER_REF, addiction)).toBe(false);
        // Monitored: 60 running stays within fAddictionUsageMonitorThreshold (Skyrim.esm 70) and asks
        // nothing, drink after drink; 75 asks the excess, 5 %, whatever the potion's own chance.
        asked.length = 0;
        chance = 1;
        await magic.consumed(PLAYER_REF, light.formId);
        await magic.consumed(PLAYER_REF, light.formId);
        expect(asked).toEqual([]);
        expect(await actors.hasSpell(PLAYER_REF, addiction)).toBe(false);
        await magic.consumed(PLAYER_REF, monitored.formId);
        expect(asked).toHaveLength(1);
        expect(asked[0]).toBeCloseTo(0.05);
        expect(await actors.hasSpell(PLAYER_REF, addiction)).toBe(true);
        // Taken: the potion's monitors on the drinker end.
        const running = [...runtime.state.activeEffects.values()].filter(
          (entry) => entry.item === monitored.formId && entry.effect === USAGE_MONITOR_EFFECT,
        );
        expect(running).toEqual([]);
      } finally {
        magic.item = reader;
        perks.apply = applier;
      }
    },
    60_000,
  );
});
