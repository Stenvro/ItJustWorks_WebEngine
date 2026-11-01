// Conformance: the beast forms (engine map: Magic, effects, perks > Archetypes; docs/gameplay.md
// "Beast forms"): the werewolf's change run in the headless simulation, into the form and back
// at its timer.
//
// Sources:
// - The vanilla scripts: WerewolfChangeEffectScript (the effect's: the Companions' first-change
//   flag, then PlayerWerewolfQuest), PlayerWerewolfChangeScript (PrepShift: SetBeastForm;
//   InitialShift: SetRace WerewolfBeastRace; OnUpdate: stage 100 once GameDaysPassed reaches
//   PlayerWerewolfShiftBackTime; ActuallyShiftBackIfNecessary: SetRace back, SetBeastForm false).
// - The Werewolf archetype's own part: the beast form on as it takes hold (src/gameplay/
//   beast-forms.ts; WerewolfChangeEffectScript's first-change branch turns it off again).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const WEREWOLF_CHANGE = 0x92c48;
const WEREWOLF_BEAST_RACE = 0xcdd84;
const PLAYER_WEREWOLF_QUEST = 0x2ba16;

describe.skipIf(!hasGamedata())('the werewolf change (simulation)', () => {
  let sim: Sim;

  beforeAll(async () => {
    sim = await openSim({ interior: 0x1605e, hour: 22 });
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('changes the player into the werewolf and back at its timer', async () => {
    const runtime = sim.runtime;
    const human = await runtime.actors.raceOf(PLAYER_REF);
    expect(human).not.toBe(WEREWOLF_BEAST_RACE);

    // The cast changes the player: the beast form at once (the archetype's), the change's quest
    // started by the effect's script, the race once the change has played.
    await sim.cast(WEREWOLF_CHANGE, PLAYER_REF);
    await sim.step(0.5);
    expect(runtime.beastForm).toBe(true);
    expect(sim.isRunning(PLAYER_WEREWOLF_QUEST)).toBe(true);
    const changed = await sim.until(
      () => runtime.state.actor(PLAYER_REF).race === WEREWOLF_BEAST_RACE,
      30,
    );
    expect(changed).toBe(true);
    expect(await runtime.actors.raceOf(PLAYER_REF)).toBe(WEREWOLF_BEAST_RACE);
    // The tracking starts once the new body stands (OnRaceSwitchComplete: stage 10), setting the
    // day the form ends: 150 real seconds on (StandardDurationSeconds) in game days.
    expect(await sim.until(() => sim.stage(PLAYER_WEREWOLF_QUEST) >= 10, 30)).toBe(true);
    const shiftBack = await sim.formId('GLOB', 'PlayerWerewolfShiftBackTime');
    const ends = runtime.state.globals.get(shiftBack) ?? 0;
    expect(ends).toBeGreaterThan(runtime.state.gameDaysPassed);

    // Its timer runs out and the player changes back into their own race, out of the beast form
    // (the time brought forward: the timer's check is the script's, every 5 s).
    sim.setGlobal(shiftBack, runtime.state.gameDaysPassed);
    const back = await sim.until(() => !runtime.beastForm, 60);
    expect(back).toBe(true);
    expect(await runtime.actors.raceOf(PLAYER_REF)).toBe(human);
  }, 300_000);
});
