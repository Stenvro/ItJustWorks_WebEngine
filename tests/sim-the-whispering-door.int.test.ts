// Integration test: DA08 "The Whispering Door" (Mephala's quest) on the headless simulation,
// played through as the player plays it: a rumor at the Bannered Mare once the player is of the
// level it waits for, the Jarl's word about his son, Nelkir's secret, the door that whispers, its
// key, and the Ebony Blade behind it. Segment by segment (each one loads the save the one before
// it left). Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ActorValue, actorValueIndex } from '../src/world/actor-values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const DA08 = 0x4a37b;
const DA08_RUMOR = 0xdc9e0;
const MQ104 = 0x2610c;
/** Dragonsreach (WhiterunDragonsreach) and the Bannered Mare's innkeeper. */
const DRAGONSREACH = 0x165a3;
const HULDA = 0x1a66e;
/** NelkirREF, BalgruufTheGreaterREF, FarengarSecretFireREF. */
const NELKIR = 0x1a67b;
const BALGRUUF = 0x1a677;
const FARENGAR = 0x1a67e;
/** DA08WhisperingDoorREF, the talking activator at it (DA08WhisperingDoorTARef), the blade. */
const WHISPERING_DOOR = 0x4a38c;
const DOOR_VOICE = 0x4a38a;
const EBONY_BLADE = 0x4a39d;
/** DA08MephalaGivesInstructions, the scene the blade's pickup starts. */
const INSTRUCTIONS = 0x62cf0;

/** The game with the rumor heard (DA08RumorPointer 10). */
let rumorHeard: Uint8Array | undefined;
/** The game with the door heard (stage 25). */
let doorHeard: Uint8Array | undefined;
/** The game with the Ebony Blade taken (stage 50, the instructions playing). */
let bladeTaken: Uint8Array | undefined;

/** The player walks up to a reference (within reach of activating it). */
async function goTo(sim: Sim, reference: number, reach = 120): Promise<void> {
  const at = await sim.position(reference);
  expect(at && (await sim.walkPath(at, 120, reach))).toBe(true);
}

describe.skipIf(!hasGamedata())('DA08 The Whispering Door', () => {
  // The rumor waits for Dragon Rising (MQ104 160: the Jarl's own word waits for it) and the
  // level DA08MinLevel: the level-up's Increase Level event starts DA08RumorPointer, and the
  // innkeeper's rumors tell of the Jarl's children (its stage 10, PlayerGotRumor).
  it('has the rumor told at the Bannered Mare (rumor 10)', async () => {
    const sim = await openSim({ hour: 18 });
    try {
      // A game that skips ahead: Dragon Rising is done.
      const dragonRising = sim.runtime.state.quest(MQ104);
      dragonRising.stagesDone.add(160);
      dragonRising.completed = true;
      const minLevel = (await sim.runtime.globalNamed('DA08MinLevel')) ?? 1;
      sim.runtime.state.actor(PLAYER_REF).level = Math.max(1, minLevel - 1);
      await sim.runtime.progression.advanceLevel();
      expect(await sim.runtime.progression.levelUp(ActorValue.health)).toBe(true);
      await sim.runtime.storyManager.idle();
      await sim.step(1);
      expect(sim.isRunning(DA08_RUMOR)).toBe(true);
      await sim.openInterior(await sim.formId('CELL', 'WhiterunBanneredMare'));
      await sim.step(2);
      await goTo(sim, HULDA, 150);
      expect(await sim.talk(HULDA)).toContain('Give me the latest gossip.');
      // The innkeeper tells one of the rumors that hold at random: the player asks again until
      // it is the Jarl's children's.
      for (let ask = 0; ask < 40 && !sim.stageDone(DA08_RUMOR, 10); ask++) {
        await sim.choose(/latest gossip/);
        await sim.step(0.5);
      }
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(DA08_RUMOR, 10)).toBe(true);
      rumorHeard = await sim.save('DA08 rumor');
    } finally {
      await sim.close();
    }
  }, 900_000);

  it('has the Jarl, Nelkir and the door speak (10-25)', async () => {
    expect(rumorHeard).toBeDefined();
    if (!rumorHeard) return;
    const sim = await loadSim(rumorHeard);
    try {
      await sim.openInterior(DRAGONSREACH);
      await goTo(sim, BALGRUUF, 150);
      expect(await sim.talk(BALGRUUF)).toContain("I've heard there's trouble with your children.");
      await sim.choose(/trouble with your children/);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(DA08, 10)).toBe(true);

      await goTo(sim, NELKIR, 150);
      expect(await sim.talk(NELKIR)).toContain('Your father said to speak to you.');
      await sim.choose(/Your father said/);
      await sim.choose(/What sorts of things/);
      await sim.choose(/How do you know these things/);
      await sim.choose(/Who's the Whispering Lady/);
      await sim.choose(/Where is this door/);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(DA08, 20)).toBe(true);

      // The door is a talking activator: activated, it talks, in Mephala's voice (25).
      await goTo(sim, DOOR_VOICE, 150);
      expect(await sim.talk(DOOR_VOICE)).toEqual(['(Listen at the door)']);
      expect(await sim.choose(/Listen at the door/)).toContain('Is there someone behind the door?');
      expect(await sim.choose(/someone behind the door/)).toContain('What do you want me to do?');
      expect(await sim.choose(/What do you want me to do/)).toEqual(['How do I open the door?']);
      expect(sim.stageDone(DA08, 25)).toBe(false);
      expect(await sim.choose(/How do I open the door/)).toEqual([]);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(DA08, 25)).toBe(true);
      doorHeard = await sim.save('DA08 25');
    } finally {
      await sim.close();
    }
  }, 900_000);

  it('has the key lifted, the door opened and the Ebony Blade taken, the instructions heard (30-60)', async () => {
    expect(doorHeard).toBeDefined();
    if (!doorHeard) return;
    const sim = await loadSim(doorHeard);
    try {
      // Nelkir knows who carries the door's key (30: the Jarl and Farengar are given one).
      await goTo(sim, NELKIR, 150);
      expect(await sim.talk(NELKIR)).toContain('Do you know how to open the Whispering Door?');
      await sim.choose(/how to open the Whispering Door/);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(DA08, 30)).toBe(true);
      const { key } = await sim.runtime.lock(WHISPERING_DOOR);
      expect(key).toBeDefined();
      if (key === undefined) return;
      expect(await sim.runtime.itemCount(FARENGAR, key)).toBe(1);

      // The player lifts it from Farengar's pocket, sneaking, a practised thief.
      sim.runtime.actors.setBase(PLAYER_REF, actorValueIndex('Pickpocket') ?? 13, 100);
      await goTo(sim, FARENGAR, 100);
      sim.press('Sneak', true);
      sim.press('Sneak', false);
      await sim.step(1);
      let lifted = false;
      for (let attempt = 0; attempt < 5 && !lifted; attempt++) {
        lifted = await sim.pickpocket(FARENGAR, key);
      }
      expect(await sim.runtime.itemCount(PLAYER_REF, key)).toBe(1);
      // The key's own script hears it reach the player (OnContainerChanged): 40, the door's
      // lock opens and its activation is no longer passed to the voice.
      await sim.step(1);
      expect(sim.stageDone(DA08, 40)).toBe(true);
      expect((await sim.runtime.lock(WHISPERING_DOOR)).locked).toBe(false);

      // Through the door (50), and the blade taken: its script starts Mephala's instructions
      // (DA08MephalaGivesInstructions, said by the voice in the player's head).
      await goTo(sim, WHISPERING_DOOR, 120);
      expect(sim.activate(WHISPERING_DOOR)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(DA08, 50)).toBe(true);
      await goTo(sim, EBONY_BLADE, 100);
      expect(await sim.pickUp(EBONY_BLADE)).toBe(true);
      await sim.step(2);
      const blade = await sim.runtime.baseOf(EBONY_BLADE);
      expect(blade !== undefined && (await sim.runtime.itemCount(PLAYER_REF, blade))).toBe(1);
      expect(sim.scriptEvents({ event: 'OnContainerChanged', target: EBONY_BLADE })).toHaveLength(
        1,
      );
      expect(sim.runtime.scenes.isPlaying(INSTRUCTIONS)).toBe(true);
      bladeTaken = await sim.save('DA08 blade');
      // Played on in the same game, the instructions end the quest (60).
      expect(await sim.until(() => sim.stageDone(DA08, 60), 90)).toBe(true);
      expect(sim.runtime.state.quests.get(DA08)?.completed).toBe(true);
    } finally {
      await sim.close();
    }
  }, 900_000);

  // The instructions' lines are the voice marker's (DA08VoiceInYourHeadMarker, the
  // MephalaInYourHead alias: no actor); the scene's end fragment sets 60, the quest done. The
  // segment before plays it to its end in the live game; here a save made while it plays goes
  // on to its end too.
  it("has Mephala's instructions, saved while they play, end the quest once loaded (60)", async () => {
    expect(bladeTaken).toBeDefined();
    if (!bladeTaken) return;
    const sim = await loadSim(bladeTaken);
    try {
      expect(await sim.until(() => sim.stageDone(DA08, 60), 90)).toBe(true);
      expect(sim.runtime.state.quests.get(DA08)?.completed).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
