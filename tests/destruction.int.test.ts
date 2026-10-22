// Integration test: destructible objects on the local game data. Every DEST block and DEBR
// record reads; the stockade barricade's BSDamageStage nodes draw and collide by the model
// damage stage; the running game takes real references through their stages (an ore vein a
// script depletes, a spider web two blows break, a barricade's damage stages and broken model,
// an oil pool that burns down by its self damage and disables itself), with the world told of
// each look, debris and explosion and the scripts of each stage. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildCollision } from '../src/physics/collision-data.ts';
import { buildModel } from '../src/render/model-data.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import type { Value } from '../src/scripting/values.ts';
import {
  DESTRUCTIBLE_TYPES,
  parseDebris,
  parseDestruction,
  type DestructionStage,
} from '../src/world/destruction-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

/** Skyrim.esm references (tools/destruction-info.ts --refs). */
const ORE_VEIN = 0x9804b; // MineOreIron01 in LeftHandMine
const WEB = 0x682e1; // FXspiderWebKitDestructible in SnaplegCave01
const BARRICADE = 0x1a289; // StockadeBarricade01Activator
const OIL_POOL = 0x92b57; // TrapOilPool01 in Ansilvund01

describe.skipIf(!hasGamedata())('destruction on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const changes: { reference: number; reached: DestructionStage | undefined }[] = [];
  const explosions: { explosion: number; source: number | undefined }[] = [];
  const events: { reference: number; event: string; args: readonly Value[] }[] = [];
  const settle = async (): Promise<void> => {
    await runtime.vm.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library, {
      world: {
        destructionChanged: (reference, reached) => {
          changes.push({ reference, reached });
        },
        explosion: (explosion, _at, source) => {
          explosions.push({ explosion, source });
        },
      },
    });
    const send = runtime.sendEvent.bind(runtime);
    runtime.sendEvent = (reference, event, args) => {
      if (event === 'OnDestructionStageChanged')
        events.push({ reference, event, args: args ?? [] });
      return send(reference, event, args);
    };
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('reads every DEST block and DEBR record; stages link explosions and debris', async () => {
    let objects = 0;
    let stages = 0;
    for (const type of DESTRUCTIBLE_TYPES) {
      for (const formId of db.formIdsOfType(type)) {
        const record = await db.get(formId);
        const data = record && parseDestruction(record);
        if (!data) continue;
        objects++;
        for (const [index, stage] of data.stages.entries()) {
          stages++;
          expect(stage.index).toBe(index);
          if (stage.explosion !== undefined)
            expect((await db.get(stage.explosion))?.type).toBe('EXPL');
          if (stage.debris !== undefined) expect((await db.get(stage.debris))?.type).toBe('DEBR');
        }
      }
    }
    expect(objects).toBeGreaterThan(600);
    expect(stages).toBeGreaterThan(800);
    for (const formId of db.formIdsOfType('DEBR')) {
      const record = await db.get(formId);
      if (record) expect(parseDebris(record).models.length).toBeGreaterThan(0);
    }
  });

  it("draws and collides a model's BSDamageStage nodes by the damage stage", async () => {
    const nif = parseNif(
      await vfs.read('meshes\\clutter\\stockade\\stockadebarricade\\stockadebarricade01.nif'),
    );
    const names = (stage: number): Set<string> =>
      new Set(buildModel(nif, { damageStage: stage }).parts.map((part) => part.name));
    const intact = names(0);
    const damaged = names(1);
    expect(intact.size).toBeGreaterThan(0);
    expect(damaged.size).toBeGreaterThan(0);
    expect([...intact].some((name) => !damaged.has(name))).toBe(true);
    const bodies = (stage: number): string[] =>
      buildCollision(nif, stage).bodies.map((body) => body.node);
    expect(bodies(0)).not.toEqual(bodies(3));
  });

  it("depletes an ore vein by a script's damage; external blows do nothing more", async () => {
    await runtime.damageObject(ORE_VEIN, 50);
    await settle();
    expect(runtime.destruction.stage(ORE_VEIN)).toBe(1);
    expect(await runtime.destruction.health(ORE_VEIN)).toBe(50);
    const look = await runtime.destruction.look(ORE_VEIN);
    expect(look?.model).toMatch(/mineoredepleted01\.nif$/i);
    expect(events).toContainEqual({
      reference: ORE_VEIN,
      event: 'OnDestructionStageChanged',
      args: [0, 1],
    });
    await runtime.destruction.damage(ORE_VEIN, 100, { external: true });
    expect(runtime.destruction.stage(ORE_VEIN)).toBe(1);
    // ClearDestruction (MineOreScript's OnReset): undamaged, its own model.
    runtime.destruction.clear(ORE_VEIN);
    expect(runtime.destruction.stage(ORE_VEIN)).toBe(0);
    expect(await runtime.destruction.look(ORE_VEIN)).toBeUndefined();
    expect(changes.filter((change) => change.reference === ORE_VEIN).length).toBe(2);
  });

  it('breaks a spider web in two blows, each setting its explosion off', async () => {
    explosions.length = 0;
    await runtime.destruction.damage(WEB, 40, { external: true, source: 0x14 });
    expect(runtime.destruction.stage(WEB)).toBe(1);
    await runtime.destruction.damage(WEB, 40, { external: true, source: 0x14 });
    await settle();
    expect(runtime.destruction.stage(WEB)).toBe(2);
    expect(explosions.length).toBe(2);
    expect(explosions[0]?.source).toBe(0x14);
    expect((await runtime.destruction.look(WEB))?.model).toMatch(/\.nif$/i);
  });

  it("shows a barricade's damage stages, then its broken model", async () => {
    await runtime.destruction.damage(BARRICADE, 40, { external: true });
    expect(runtime.destruction.stage(BARRICADE)).toBe(1);
    const damaged = await runtime.destruction.look(BARRICADE);
    expect(damaged?.damageStage).toBe(1);
    expect(damaged?.model).toMatch(/stockadebarricade01\.nif$/i);
    await runtime.destruction.blowUp(BARRICADE);
    await settle();
    expect(runtime.destruction.stage(BARRICADE)).toBe(4);
    expect((await runtime.destruction.look(BARRICADE))?.model).toMatch(
      /stockadebarricade01stage04\.nif$/i,
    );
  });

  it('burns an oil pool down by its self damage until it disables itself', async () => {
    expect(await runtime.isEnabled(OIL_POOL)).toBe(true);
    await runtime.destruction.damage(OIL_POOL, 5, { external: true });
    expect(runtime.destruction.stage(OIL_POOL)).toBe(1);
    expect(runtime.destruction.isDestroyed(OIL_POOL)).toBe(true);
    for (let second = 0; second < 30 && runtime.destruction.stage(OIL_POOL) < 4; second++) {
      runtime.destruction.update(1);
      await settle();
    }
    expect(runtime.destruction.stage(OIL_POOL)).toBe(4);
    expect(await runtime.isEnabled(OIL_POOL)).toBe(false);
    expect(explosions.some((entry) => entry.source === OIL_POOL)).toBe(true);
  });
});
