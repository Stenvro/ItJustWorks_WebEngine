// An original save (.ess) from the user's own install, read and imported into a fresh
// simulation (docs/formats/ess.md). Skips without game data or without a save in
// Documents\My Games\Skyrim Special Edition\Saves; no save is ever in the repo.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readChangeForm } from '../src/formats/ess/change-forms.ts';
import { globalData, readEss } from '../src/formats/ess/ess.ts';
import { refIdResolver } from '../src/formats/ess/global-data.ts';
import { readPapyrus } from '../src/formats/ess/papyrus.ts';
import { essWorld, importEss } from '../src/save/ess-import.ts';
import { writeSave } from '../src/save/save-codec.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF } from './helpers/sim.ts';

const SAVES = join(homedir(), 'Documents', 'My Games', 'Skyrim Special Edition', 'Saves');

function firstSave(): string | undefined {
  try {
    const name = readdirSync(SAVES).find((file) => file.toLowerCase().endsWith('.ess'));
    return name === undefined ? undefined : join(SAVES, name);
  } catch {
    return undefined;
  }
}

const path = firstSave();

/**
 * A save the maintainer made at a known point (New Game, on the cart into Helgen): its name
 * starts with Save1_; SKYRIM_ESS names another file to check the same way.
 */
function knownSave(): string | undefined {
  if (process.env.SKYRIM_ESS) return process.env.SKYRIM_ESS;
  try {
    const name = readdirSync(SAVES).find((file) => /^Save1_.*\.ess$/i.test(file));
    return name === undefined ? undefined : join(SAVES, name);
  } catch {
    return undefined;
  }
}

const known = knownSave();
const MQ101 = 0x3372b;
const TAMRIEL = 0x3c;

describe.skipIf(!hasGamedata() || known === undefined)('a known original save (local)', () => {
  it('reads every section to its end but the actors after their movement data', () => {
    const ess = readEss(new Uint8Array(readFileSync(known ?? '')));
    const papyrus = readPapyrus(globalData(ess, 1001) ?? new Uint8Array(), true);
    expect(papyrus.unread).toBe(0);
    const resolve = refIdResolver(ess.formIds);
    const stops = new Set<string>();
    let actorValues = 0;
    for (const entry of ess.changeForms) {
      const form = readChangeForm(entry, resolve);
      if (form.actor?.values) actorValues++;
      if (form.stoppedAt !== undefined) stops.add(`${String(entry.type)} ${form.stoppedAt}`);
    }
    // TODO(M13): the movement controller's data (and the combat controller's and the player's
    // own data after it) are the only parts not read yet.
    expect([...stops]).toEqual(['1 actor movement data']);
    expect(actorValues).toBe(ess.changeForms.filter((entry) => entry.type === 1).length);
  });

  it("restores the player's place, items, quest stages and actor values", async () => {
    const ess = readEss(new Uint8Array(readFileSync(known ?? '')));
    const resolve = refIdResolver(ess.formIds);
    const playerEntry = ess.changeForms.find((entry) => entry.formId === PLAYER_REF);
    const quest = ess.changeForms.find((entry) => entry.formId === MQ101);
    if (!playerEntry || !quest) throw new Error('the save has no player or MQ101 change form');
    const playerForm = readChangeForm(playerEntry, resolve);
    const questForm = readChangeForm(quest, resolve);
    const done = (questForm.quest?.stages ?? []).filter((stage) => stage.done);
    const lastDone = Math.max(...done.map((stage) => stage.stage));

    const probe = await openSim();
    const world = essWorld(probe.db);
    await probe.close();
    const imported = importEss(ess, world, { name: 'Imported', number: 1, now: 0 });
    // The place: the player's own change form (moved in Tamriel).
    expect(playerForm.initial?.kind).toBe('moved');
    const moved = playerForm.initial?.kind === 'moved' ? playerForm.initial : undefined;
    expect(imported.save.player.world).toBe(TAMRIEL);
    expect(imported.save.player.position).toEqual(moved?.position);

    const bytes = await writeSave({
      header: imported.header,
      thumbnail: new Uint8Array(),
      body: imported.save,
    });
    const sim = await loadSim(bytes);
    try {
      const at = await sim.position(PLAYER_REF);
      const [x, y] = moved?.position ?? [0, 0];
      expect(Math.hypot((at?.[0] ?? 0) - x, (at?.[1] ?? 0) - y)).toBeLessThan(256);
      // MQ101: every stage the save marks done, and the highest of them as the current stage.
      for (const stage of done) expect(sim.stageDone(MQ101, stage.stage)).toBe(true);
      expect(sim.stage(MQ101)).toBe(lastDone);
      // The items the player gained.
      for (const entry of playerForm.inventory ?? []) {
        if (entry.delta > 0) {
          expect(await sim.runtime.itemCount(PLAYER_REF, entry.item)).toBeGreaterThanOrEqual(
            entry.delta,
          );
        }
      }
      // The actor values the save keeps (the skills' base values).
      const values = sim.runtime.state.actors.get(PLAYER_REF)?.values;
      for (const { av, value } of playerForm.actor?.values?.base ?? []) {
        expect(values?.get(av)?.base).toBe(value);
      }
    } finally {
      await sim.close();
    }
  }, 300_000);
});

describe.skipIf(!hasGamedata() || path === undefined)('an original save (local)', () => {
  it('reads its header and change forms, and loads into a simulation', async () => {
    const ess = readEss(new Uint8Array(readFileSync(path ?? '')));
    expect(ess.header.version).toBe(12);
    expect(ess.changeForms.length).toBe(ess.locations.changeFormCount);

    const probe = await openSim();
    const world = essWorld(probe.db);
    await probe.close();
    const imported = importEss(ess, world, { name: 'Imported', number: 1, now: 0 });
    const bytes = await writeSave({
      header: imported.header,
      thumbnail: new Uint8Array(),
      body: imported.save,
    });
    const sim = await loadSim(bytes);
    try {
      expect(sim.runtime.state.actors.get(PLAYER_REF)?.level).toBe(ess.header.playerLevel);
      const at = await sim.position(PLAYER_REF);
      const expected = imported.save.player.position;
      expect(Math.hypot((at?.[0] ?? 0) - expected[0], (at?.[1] ?? 0) - expected[1])).toBeLessThan(
        256,
      );
    } finally {
      await sim.close();
    }
  }, 300_000);
});
