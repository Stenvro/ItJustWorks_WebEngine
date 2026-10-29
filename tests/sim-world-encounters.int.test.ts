// World encounters (docs/scripting.md, "World encounters"): a WE trigger by Riverwood's river
// (WETriggerOnLoad: WETriggerScript with TriggerOnLoad and EventNum 100) starts its encounter as
// its cell loads (OnCellLoad: Keyword.SendStoryEvent with WEStart, the hold's location, itself,
// the hold's faction marker and the event number). The story manager's WEQuestNode (WEEnabled)
// passes it to WESpecificWE100 (V1 100), which starts WE100: its aliases fill, its treasure hunter
// is made at the scene's marker and dies as he loads (WEAliasScript's KillOnLoad, which also
// counts him in); once the player is gone, he unloads (counted out), WEScript stops the quest
// at its next hourly poll, and the shut-down stage re-arms the trigger and deletes him.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim } from './helpers/sim.ts';

const TAMRIEL = 0x3c;
/** The WE trigger by Riverwood's river. */
const RIVER_TRIGGER = 0x99c93;
/** WEStart: the keyword of the story manager's script events for world encounters. */
const WE_START = 0x4a600;
/** WEEnabled: the global the story manager's WEQuestNode asks for. */
const WE_ENABLED = 0xb8ec1;
/** WE100, "Dead Treasure Hunter with instructions", and its aliases. */
const WE100 = 0xa17ae;
const ALIAS_SCENE_MARKER = 11;
const ALIAS_TREASURE_HUNTER = 18;
const ALIAS_LETTER = 30;

describe.skipIf(!hasGamedata())('world encounters', () => {
  it('starts WE100 by Riverwood’s river as its cell loads, and ends it once the player is gone', async () => {
    const sim = await openSim({ exterior: { world: TAMRIEL, cell: [1, -12] }, hour: 10 });
    try {
      await sim.step(5);
      // The trigger's script event, and the quest the story manager started for it.
      const event = sim
        .storyEvents('SCPT')
        .find((record) => record.forms.K1 === WE_START && record.forms.R1 === RIVER_TRIGGER);
      expect(event?.values.V1).toBe(100);
      expect(event?.started).toEqual([WE100]);
      expect(sim.isRunning(WE100)).toBe(true);
      const aliases = sim.runtime.state.quests.get(WE100)?.aliases;
      const hunter = aliases?.get(ALIAS_TREASURE_HUNTER);
      const marker = aliases?.get(ALIAS_SCENE_MARKER);
      if (hunter === undefined || marker === undefined) throw new Error('aliases not filled');
      expect(sim.runtime.state.created.has(hunter)).toBe(true);
      expect(aliases?.has(ALIAS_LETTER)).toBe(true);
      expect(await sim.distance(hunter, marker)).toBeLessThan(100);
      // On the stage, he loaded, and his alias's KillOnLoad killed him.
      expect(sim.actor(hunter)).toBeDefined();
      const heard = sim.scriptEvents({ target: hunter }).map((record) => record.event);
      expect(heard).toEqual(expect.arrayContaining(['OnCellAttach', 'OnLoad', 'OnDeath']));
      expect(await sim.runtime.actors.isDead(hunter)).toBe(true);

      // The player goes far away: he unloads, and the next game hour stops the quest.
      const left = sim.time;
      await sim.openExterior(TAMRIEL, [20, -12]);
      await sim.step(1);
      const unloaded = sim.scriptEvents({ target: hunter, since: left }).map((r) => r.event);
      expect(unloaded).toEqual(expect.arrayContaining(['OnUnload', 'OnCellDetach']));
      expect(sim.isRunning(WE100)).toBe(true);
      sim.setHour(sim.hour + 1.5);
      await sim.until(() => !sim.isRunning(WE100), 5);
      expect(sim.isRunning(WE100)).toBe(false);
      expect(sim.stageDone(WE100, 255)).toBe(true);
      // The shut-down stage's DeleteWhenAble: he is out of the loaded area, held by no alias.
      expect(sim.runtime.deleted(hunter)).toBe(true);
      expect(sim.problems().filter((problem) => problem.tag === 'papyrus')).toEqual([]);
    } finally {
      await sim.close();
    }
  }, 240_000);

  it('starts none while WEEnabled is 0', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      sim.setGlobal(WE_ENABLED, 0);
      await sim.openExterior(TAMRIEL, [1, -12]);
      await sim.step(5);
      const event = sim
        .storyEvents('SCPT')
        .find((record) => record.forms.K1 === WE_START && record.forms.R1 === RIVER_TRIGGER);
      expect(event?.started).toEqual([]);
      expect(sim.isRunning(WE100)).toBe(false);
    } finally {
      await sim.close();
    }
  }, 240_000);
});
