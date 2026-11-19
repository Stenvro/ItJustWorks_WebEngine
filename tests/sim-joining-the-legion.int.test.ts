// Integration test: CW01A "Joining the Legion" on the headless simulation, played as the player
// plays it, segment by segment (each one loads the save the one before it left). CW00A
// "Imperial Introductions" leads into it: General Tullius sends the player to Legate Rikke, who
// sends them to clear Fort Hraggstad. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ActorValue } from '../src/world/actor-values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

const CW00A = 0xd3c5f;
const CW01A = 0xd517a;
const CASTLE_DOUR = 0x213a0;
/** CW00A's aliases: Rikke and Tullius. */
const CW00A_RIKKE = 0;
const CW00A_TULLIUS = 2;
const FORT_HRAGGSTAD = 0x19181;
/** SolitudeMapmarkerRef. */
const SOLITUDE_MARKER = 0x4d0f4;
/** CW01A's aliases: Rikke and Tullius. */
const CW01A_RIKKE = 26;
const CW01A_TULLIUS = 27;
const CW02A = 0x2d75c;
/** CW01AOutfitImperial: Beirand's outfit for the new soldier. */
const CW01A_OUTFIT = 0xc349b;

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/**
 * Those fighting the player fall to the player's blows (TODO(M13): the player's own blows, where
 * the fight is not what the segment tests).
 */
async function fendOff(sim: Sim): Promise<number> {
  let fallen = 0;
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead) continue;
    if (sim.world.stage.combat.targetOf(actor) === PLAYER_REF) {
      await sim.kill(actor, PLAYER_REF);
      fallen += 1;
    }
  }
  return fallen;
}

/** Hurt, with none fighting them, the player waits an hour (the wait menu): their health comes back. */
async function catchBreath(sim: Sim): Promise<void> {
  const health = await sim.runtime.actors.value(PLAYER_REF, ActorValue.health);
  if (health.current >= 60) return;
  const fighting = sim.actors().some((staged) => {
    return !staged.dead && sim.world.stage.combat.targetOf(staged.reference) === PLAYER_REF;
  });
  if (!fighting) await sim.rest(1, false);
}

/** The player makes their way to a point, what comes at them falling as they go (fendOff). */
async function walkFighting(
  sim: Sim,
  target: readonly [number, number, number],
  seconds: number,
  reach = 200,
): Promise<boolean> {
  const until = sim.time + seconds;
  while (until - sim.time >= SIM_STEP / 2) {
    const started = sim.time;
    const there = await sim.walkPath(
      [target[0], target[1], target[2]],
      Math.min(5, until - sim.time),
      reach,
    );
    await fendOff(sim);
    await catchBreath(sim);
    if (there) return true;
    if (sim.time - started < SIM_STEP / 2) await sim.step(0.5);
  }
  return false;
}

/** The game with Rikke's test taken (CW01A 1). */
let sentToFort: Uint8Array | undefined;
/** The game with Fort Hraggstad cleared (CW01A 100). */
let fortCleared: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('CW01A Joining the Legion', () => {
  // Castle Dour. Tullius's word ("Do you have some reason to be here, citizen?"): the player was at
  // Helgen, set free, and came to fight for the Empire (CW00A 10). Rikke tests them: Fort
  // Hraggstad (CW00A 20, which sets CW01A 1).
  it('has Tullius send the player to Rikke, who sends them to Fort Hraggstad (CW00A 10, 20; CW01A 1)', async () => {
    const sim = await openSim({ hour: 10, interior: CASTLE_DOUR });
    try {
      await sim.step(2);
      const tullius = alias(sim, CW00A, CW00A_TULLIUS);
      const rikke = alias(sim, CW00A, CW00A_RIKKE);
      const at = await sim.position(tullius);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(tullius)).toEqual(['Hello.']);
      expect(await sim.choose('Hello.')).toContain('I was at Helgen.');
      await sim.choose(/at Helgen/);
      expect(await sim.choose(/set free/)).toEqual([]);
      expect(sim.stageDone(CW00A, 10)).toBe(true);
      sim.goodbye();
      await sim.step(1);
      const there = await sim.position(rikke);
      expect(there && (await sim.walkPath(there, 60, 150))).toBe(true);
      expect(await sim.talk(rikke)).toContain('What kind of test?');
      await sim.choose(/What kind of test/);
      expect(await sim.choose(/Hraggstad/)).toContain('Consider that fort already yours.');
      expect(await sim.choose(/already yours/)).toEqual([]);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(CW00A, 20)).toBe(true);
      expect(sim.stageDone(CW01A, 1)).toBe(true);
      expect(sim.runtime.state.quest(CW01A).objectives.get(1)?.displayed).toBe(true);
      sentToFort = await sim.save('CW01A 1');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Fort Hraggstad (the way there is not under test): its bandits, CW01A's 25 Bandit aliases (as
  // many as the fort has), fall to the player. The last one down completes the objective (100).
  it('has the player clear Fort Hraggstad of its bandits (CW01A 100)', async () => {
    expect(sentToFort).toBeDefined();
    if (!sentToFort) return;
    const sim = await loadSim(sentToFort);
    try {
      const fort = await sim.runtime.location(FORT_HRAGGSTAD);
      expect(fort?.marker).toBeDefined();
      await sim.fastTravel(fort?.marker ?? 0);
      await sim.step(2);
      const bandits = [...sim.runtime.state.quest(CW01A).aliases]
        .filter(([id]) => id >= 1 && id <= 25)
        .map(([, ref]) => ref);
      expect(bandits.length).toBeGreaterThan(0);
      for (let round = 0; round < 3; round++) {
        for (const bandit of bandits) {
          if (await sim.runtime.actors.isDead(bandit)) continue;
          const at = await sim.position(bandit);
          if (at && (await walkFighting(sim, at, 60, 300))) await sim.kill(bandit, PLAYER_REF);
        }
      }
      expect(await sim.until(() => sim.stageDone(CW01A, 100), 10)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      const objectives = sim.runtime.state.quest(CW01A).objectives;
      expect(objectives.get(1)?.completed).toBe(true);
      expect(objectives.get(100)?.displayed).toBe(true);
      await sim.step(1);
      fortCleared = await sim.save('CW01A 100');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back in Castle Dour: Rikke sends the player to Tullius for the oath (150, 160), and Tullius
  // administers it ("I'm ready to take the oath."): the player is a soldier of the Legion (200),
  // and The Jagged Crown begins.
  it('has Rikke send the player to Tullius, who swears them in (CW01A 150, 160, 200)', async () => {
    expect(fortCleared).toBeDefined();
    if (!fortCleared) return;
    const sim = await loadSim(fortCleared);
    try {
      await sim.fastTravel(SOLITUDE_MARKER);
      await sim.step(1);
      await sim.openInterior(CASTLE_DOUR);
      await sim.step(2);
      const rikke = alias(sim, CW01A, CW01A_RIKKE);
      const tullius = alias(sim, CW01A, CW01A_TULLIUS);
      const at = await sim.position(rikke);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      // Her greeting ("Welcome back, soldier...") sends the player to Tullius: 150, then 160.
      expect(await sim.talk(rikke)).toEqual([]);
      expect(sim.stageDone(CW01A, 150)).toBe(true);
      expect(sim.stageDone(CW01A, 160)).toBe(true);
      sim.goodbye();
      await sim.step(1);
      const there = await sim.position(tullius);
      expect(there && (await sim.walkPath(there, 60, 150))).toBe(true);
      // Stage 160 gives him his force greet (CW01ATulliusForcegreet, GetStage CW01A == 160) with
      // CW01AJoinLegionBranchTopic: he comes to the player and opens with "In joining the Legion,
      // you'll be taking an oath..." and its two answers. Tried while the player still spoke
      // with Rikke, it is tried again after fAIForceGreetingTimer (3 s), so the player waits for
      // him; one who talks to him first gets that blocking topic as their own "I'm ready to take
      // the oath." instead.
      expect(await sim.listen(tullius, 10)).toContain("I'm ready to take the Oath.");
      await sim.choose(/ready to take the Oath/);
      await sim.choose(/Upon my honor/);
      await sim.choose(/unwavering obedience/);
      await sim.choose(/those above judge me/);
      // "Welcome to the Imperial Legion, soldier." Its fragment sets 200, whose own waits for
      // Tullius and Rikke's scene at the map table (CW01SolitudeMapTableScene) before the quest
      // stops: the conversation does not wait for it.
      expect(await sim.choose(/Long live the Emperor/)).toEqual([]);
      expect(sim.stageDone(CW01A, 200)).toBe(true);
      expect(sim.runtime.state.quest(CW01A).objectives.get(160)?.completed).toBe(true);
      expect(sim.stageDone(CW01A_OUTFIT, 1)).toBe(true);
      expect(sim.stageDone(CW02A, 10)).toBe(true);
      expect(sim.runtime.state.quest(CW02A).objectives.get(10)?.displayed).toBe(true);
      expect(sim.isRunning(CW00A)).toBe(false);
      await sim.step(2);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
