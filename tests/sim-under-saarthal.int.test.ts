// Integration test: MG02 "Under Saarthal" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left). Skipped
// without game data.

import { describe, expect, it } from 'vitest';
import {
  alias,
  approachAndTalk,
  follow,
  goThrough,
  keepUp,
  objective,
  walkFighting,
} from './helpers/quest-play.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MG01 = 0x1f251;
const MG02 = 0x1f252;
/** MG02's aliases: Tolfdir, the amulet's place on the wall, Arniel, Saarthal's door, the wall
 * that opens to the spell, and the three enchanted rings it places. */
const TOLFDIR = 0;
const AMULET_TRIGGER = 1;
const ARNIEL = 7;
const SAARTHAL_DOOR = 10;
const WALL = 11;
const RINGS = [23, 24, 25];
/** The amulet (MG02Amulet) and the player's Flames. */
const AMULET_BASE = 0x233d0;
const FLAMES = 0x12fcd;
/** SaarthalMapMarker; MG02ItemsFound. */
const SAARTHAL_MARKER = 0x162a5;
const ITEMS_FOUND = 0x25883;
/** Where Nerien's vision waits for the player (MG02VisionPlayerTriggerMarker). */
const VISION_MARKER = 0x40124;

/** The game with the player sent to Arniel (MG02 30). */
let helpingArniel: Uint8Array | undefined;
/** The game with the wall open and Tolfdir leading on (MG02 40). */
let wallOpen: Uint8Array | undefined;

/** The value of a global as scripts read it. */
function global(sim: Sim, form: number): number {
  return sim.runtime.state.globals.get(form) ?? 0;
}

describe.skipIf(!hasGamedata())('MG02 Under Saarthal', () => {
  // MG02's own start for a game that skips ahead: its stage 0 plays MG01 to 200 (played in
  // sim-first-lessons) and sets 10. To Saarthal, where Tolfdir waits by the door with the
  // Apprentices: "I'm ready. Let's go." (20); the player goes in first, the door bringing the
  // class after them (MG02SaarthalExteriorDoorScript); Tolfdir's lecture as the player keeps up,
  // "Now what?", and he sends the player to Arniel Gane (25), who has them gather enchanted items
  // (30).
  it('has Tolfdir lead the class into Saarthal and send the player to Arniel (MG02 30)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MG02, 0);
      expect(await sim.until(() => sim.stageDone(MG02, 10), 120)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MG01, 200)).toBe(true);
      expect(objective(sim, MG02, 10).displayed).toBe(true);
      expect(sim.runtime.mapMarkerVisible(SAARTHAL_MARKER)).toBe(true);
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      await sim.fastTravel(SAARTHAL_MARKER);
      await sim.step(2);
      const tolfdir = alias(sim, MG02, TOLFDIR);
      const door = alias(sim, MG02, SAARTHAL_DOOR);
      const doorAt = await sim.position(door);
      expect(doorAt && (await walkFighting(sim, doorAt, 120, 600))).toBe(true);
      expect(await approachAndTalk(sim, tolfdir)).toContain("I'm ready. Let's go.");
      await sim.choose(/ready. Let's go/);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(MG02, 20), 10)).toBe(true);
      expect(await goThrough(sim, door)).toBe(true);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(
        (await sim.runtime.placement(tolfdir))?.cell,
      );
      const lectured = () => lines.includes('MG02TolfdirLectureScene: ends');
      expect(await follow(sim, tolfdir, lectured, 300)).toBe(true);
      expect(await approachAndTalk(sim, tolfdir)).toContain('Now what?');
      await sim.choose(/Now what/);
      await sim.choose(/any more questions/);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(MG02, 25), 10)).toBe(true);
      const arniel = alias(sim, MG02, ARNIEL);
      const arnielAt = await sim.position(arniel);
      expect(arnielAt && (await walkFighting(sim, arnielAt, 240, 200))).toBe(true);
      expect(await approachAndTalk(sim, arniel)).toContain('Tolfdir sent me to help you.');
      await sim.choose(/Tolfdir sent me/);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(MG02, 30), 10)).toBe(true);
      helpingArniel = await sim.save('MG02 30');
    } finally {
      await sim.close();
    }
  }, 1_200_000);

  // Through the dig for the enchanted items: the three rings, each taken (MG02ItemNScript: the
  // count goes up), and the amulet on the wall (an activation box), whose taking drops a wall
  // behind the player (40). Tolfdir comes to see; the amulet put on (MG02AmuletScript: his hint,
  // "Try casting a spell at the wall"), a spell cast at the wall it hung on (MG02WallAliasScript)
  // opens it, and Tolfdir leads on down the tunnel.
  it('has the amulet trap the player and open the way on (MG02 40)', async () => {
    if (!helpingArniel) return;
    const sim = await loadSim(helpingArniel);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      for (const [index, ring] of RINGS.entries()) {
        const reference = alias(sim, MG02, ring);
        const at = await sim.position(reference);
        expect(at && (await walkFighting(sim, at, 240, 100))).toBe(true);
        expect(sim.activate(reference)).toBe(true);
        await sim.step(1);
        expect(global(sim, ITEMS_FOUND)).toBe(index + 1);
      }
      expect(objective(sim, MG02, 30)).toEqual({ displayed: true, completed: false });
      const trigger = alias(sim, MG02, AMULET_TRIGGER);
      const at = await sim.position(trigger);
      expect(at).toBeDefined();
      if (!at) return;
      // It hangs on the wall above the floor: the player walks up under it.
      await walkFighting(sim, [at[0], at[1], at[2] - 135], 60, 60);
      expect(await sim.distance(PLAYER_REF, trigger)).toBeLessThan(160);
      expect(sim.activate(trigger)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MG02, 40)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, AMULET_BASE)).toBe(1);
      expect(await sim.equip(AMULET_BASE)).toBe(true);
      expect(await sim.until(() => lines.includes('MG02TolfdirAmuletScene: ends'), 60)).toBe(true);
      expect(await sim.equip(FLAMES)).toBe(true);
      sim.look(at);
      await sim.step(0.5);
      await sim.attack(2);
      await sim.step(2);
      const wall = alias(sim, MG02, WALL);
      const heard = sim.scriptEvents({ event: 'OnMagicEffectApply', target: wall });
      expect(heard.length).toBeGreaterThan(0);
      expect(objective(sim, MG02, 40).displayed).toBe(true);
      expect(lines).toContain('MG02TolfdirTunnelScene: starts (1 actors)');
      wallOpen = await sim.save('MG02 40');
    } finally {
      await sim.close();
    }
  }, 1_200_000);

  // After Tolfdir down the tunnel, the player leading the way on ("best if you lead the way") to
  // the vision: Nerien of the Psijic Order stops time and warns the player (50). "Did you see
  // that?" — told of the ghost, the danger and the Psijic Order, Tolfdir leads on (60).
  // TODO(M13): on from here, down into Saarthal02 to the burial chamber (Jyrik Gauldurson, the
  // Eye: 65, 70) and back to the Arch-Mage (200): the walk from Saarthal02's door stops in the pit
  // room past its first stair (1061, -2727) short of the first pillar puzzle; MG03's sim starts
  // after it (its stage 0 sets MG02's 200).
  it('has Nerien warn the player and Tolfdir hear of it (MG02 60)', async () => {
    if (!wallOpen) return;
    const sim = await loadSim(wallOpen);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const tolfdir = alias(sim, MG02, TOLFDIR);
      await sim.until(() => lines.includes('MG02TolfdirTunnelScene: ends'), 120);
      const vision = await sim.position(VISION_MARKER);
      expect(vision && (await walkFighting(sim, vision, 300, 100))).toBe(true);
      const answers = [
        /Did you see that/,
        /ghost or apparition/,
        /danger ahead, and the Psijic Order/,
        /What's the Psijic Order/,
      ];
      const told = await keepUp(sim, tolfdir, answers, () => sim.stageDone(MG02, 60), 300);
      expect(lines).toContain('MG02VisionScene: ends');
      expect(sim.stageDone(MG02, 50)).toBe(true);
      expect(sim.stageDone(MG02, 60)).toBe(true);
      expect(told).toEqual([
        'Some sort of ghost or apparition appeared. It spoke to me.',
        'It said something about danger ahead, and the Psijic Order.',
        "What's the Psijic Order?",
      ]);
      expect(objective(sim, MG02, 60).displayed).toBe(true);
    } finally {
      await sim.close();
    }
  }, 1_200_000);
});
