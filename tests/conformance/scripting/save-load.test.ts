// A save made and loaded into a fresh simulation (docs/formats/save.md): what the player did
// before saving is there after loading.

import { afterEach, describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const GAME_HOUR = 0x38;
const ITEM_TYPES = new Set(['MISC', 'ALCH', 'INGR']);

describe.skipIf(!hasGamedata())('a save made and loaded (simulation)', () => {
  let sim: Sim | undefined;

  afterEach(async () => {
    await sim?.close();
    sim = undefined;
  });

  it('keeps the player’s place, an item taken, a door opened, a death, a stage and the clock', async () => {
    const before = await openSim({ interior: BANNERED_MARE, hour: 10 });
    sim = before;
    const runtime = before.runtime;
    const placed = before.world.placedObjects();

    // Move the player.
    const start = (await before.position(PLAYER_REF)) ?? [0, 0, 0];
    await before.moveTo([start[0] + 48, start[1], start[2]]);
    await before.step(0.5);

    // Take an item.
    const item = placed.find((entry) => ITEM_TYPES.has(entry.object.baseType));
    expect(item).toBeDefined();
    const itemRef = item?.object.reference ?? 0;
    const itemBase = item?.object.base ?? 0;
    const carried = runtime.state.inventories.get(PLAYER_REF)?.get(itemBase) ?? 0;
    // As the player's activation of it does (src/shell/play-mode.ts).
    await runtime.pickUp(itemRef, PLAYER_REF);
    await before.step(0.5);
    expect(runtime.state.references.get(itemRef)?.container?.holder).toBe(PLAYER_REF);

    // Open a door that leads nowhere else.
    const door = placed.find((entry) => entry.object.baseType === 'DOOR' && !entry.object.teleport);
    expect(door).toBeDefined();
    const doorRef = door?.object.reference ?? 0;
    before.activate(doorRef);
    await before.step(2);
    const doorState = before.openState(doorRef);
    expect(doorState).not.toBe(0);

    // Kill an actor (the first one that can die).
    let dead: number | undefined;
    for (const actor of before.actors()) {
      await before.kill(actor.reference);
      if (runtime.state.actors.get(actor.reference)?.dead) {
        dead = actor.reference;
        break;
      }
    }
    expect(dead).toBeDefined();

    // Set a stage.
    const quest = await before.formId('QUST', 'DialogueWhiterun');
    const stage = 10;
    expect(await before.setStage(quest, stage)).toBe(true);
    expect(before.stageDone(quest, stage)).toBe(true);

    // Advance time.
    runtime.setClockGlobal(GAME_HOUR, 15);
    await before.step(0.5);

    const saved = {
      position: (await before.position(PLAYER_REF)) ?? [0, 0, 0],
      days: runtime.state.gameDaysPassed,
      stage: before.stage(quest),
      carried: runtime.state.inventories.get(PLAYER_REF)?.get(itemBase) ?? 0,
    };
    expect(saved.carried).toBe(carried + 1);
    const bytes = await before.save();
    await before.close();
    sim = undefined;

    const after = await loadSim(bytes);
    sim = after;
    const state = after.runtime.state;
    const position = (await after.position(PLAYER_REF)) ?? [0, 0, 0];
    expect(
      Math.hypot(position[0] - saved.position[0], position[1] - saved.position[1]),
    ).toBeLessThan(16);
    expect(state.inventories.get(PLAYER_REF)?.get(itemBase)).toBe(saved.carried);
    expect(state.references.get(itemRef)?.container?.holder).toBe(PLAYER_REF);
    expect(await after.enabled(itemRef)).toBe(false);
    expect(after.openState(doorRef)).toBe(doorState);
    expect(state.actors.get(dead ?? 0)?.dead).toBe(true);
    expect(after.stage(quest)).toBe(saved.stage);
    expect(after.stageDone(quest, stage)).toBe(true);
    expect(state.gameDaysPassed).toBeCloseTo(saved.days, 3);
    expect(after.hour).toBeCloseTo(15, 0);
    const saveProblems = after.problems().filter((p) => p.tag === 'save');
    // Every script instance found its script and variables again (threads in flight are only
    // logged as not saved: TODO(M12) resumable frames).
    expect(saveProblems.filter((p) => !p.text.startsWith('not saved: '))).toEqual([]);
  }, 240_000);
});
