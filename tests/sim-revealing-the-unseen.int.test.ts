// Integration test: MG06 "Revealing the Unseen" (mg06) on the headless simulation, played through
// as the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import {
  alias,
  approachAndTalk,
  converse,
  goThrough,
  objective,
  travelTo,
  walkFighting,
} from './helpers/quest-play.ts';
import { hasGamedata, loadSim, openSim } from './helpers/sim.ts';

const MG04 = 0x1f254;
const MG06 = 0x1f256;
/** mg06's aliases: Mirabelle and Gavros. */
const MIRABELLE = 0;
const GAVROS = 5;
/** WinterholdMapMarker, the bridge's foot, the courtyard's door to the Hall of the Elements;
 * Mzulft's map marker and its door from Tamriel into Mzulft01. */
const WINTERHOLD_MARKER = 0x177ef;
const BRIDGE_FOOT = 0x379ef;
const HALL_OF_THE_ELEMENTS_DOOR = 0x177f9;
const MZULFT_MARKER = 0x1628c;
const MZULFT_DOOR = 0x15e53;
/** The Synod's journal Gavros carries (MG06SynodJournal1) and his key to the ruin (MzulftKeyStart). */
const SYNOD_JOURNAL = 0x34cbc;
const MZULFT_KEY = 0x5dcb9;

/** The game with Mirabelle's word on the Synod (mg06 20). */
let toMzulft: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('MG06 Revealing the Unseen', () => {
  // mg06's own start for a game that skips ahead: its stage 0 plays MG01 to MG04 to 200 (played
  // in their sims) and sends the player to Mirabelle (10). "Do you know anything about the Staff
  // of Magnus?": the Synod came asking, and went to Mzulft (20).
  it('has Mirabelle send the player to Mzulft (mg06 20)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MG06, 0);
      expect(await sim.until(() => sim.stageDone(MG06, 10), 120)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MG04, 200)).toBe(true);
      expect(objective(sim, MG06, 10).displayed).toBe(true);
      await sim.fastTravel(WINTERHOLD_MARKER);
      await sim.step(2);
      const foot = await sim.position(BRIDGE_FOOT);
      expect(foot && (await sim.walkPath(foot, 120, 200))).toBe(true);
      expect(await goThrough(sim, HALL_OF_THE_ELEMENTS_DOOR, 200)).toBe(true);
      const mirabelle = alias(sim, MG06, MIRABELLE);
      const answers = [
        /anything about the Staff of Magnus/,
        /Arch-Mage Aren said/,
        /Sorry. So, the Staff of Magnus/,
        /Who are the Synod/,
        /no one knows the Staff's location/,
      ];
      expect(await travelTo(sim, mirabelle, 300)).toBe(true);
      expect(await approachAndTalk(sim, mirabelle)).toContain(
        'Do you know anything about the Staff of Magnus?',
      );
      expect(await converse(sim, answers)).toEqual([
        'Do you know anything about the Staff of Magnus?',
        "Arch-Mage Aren said you'd mentioned it recently.",
        'Who are the Synod?',
        "So no one knows the Staff's location?",
      ]);
      expect(await sim.until(() => sim.stageDone(MG06, 20), 10)).toBe(true);
      toMzulft = await sim.save('mg06 20');
    } finally {
      await sim.close();
    }
  }, 1_200_000);

  // To Mzulft (the way there is not under test: stage 20's AddToMap names no marker, its
  // property left unset in the plugin, so the player finds the ruin by its quest target). In its
  // first hall Gavros Plinius of the Synod dies of the Falmer's poison, his last words said
  // (MG06GavrosScene); from his body the Synod's journal (30) and the ruin's
  // key. TODO(M13): on from here, through Mzulft02 to the Oculory (Paratus, the crystal, the
  // focusing: 32 to 60) and back to Savos Aren (200): the walk through Mzulft02 stops at its first
  // cage door (NorBridgeCageExSm01 at 4480, 4320), which does not open to the player's walk.
  it('has Gavros die at Mzulft and leave the Synod’s journal (mg06 30)', async () => {
    if (!toMzulft) return;
    const sim = await loadSim(toMzulft);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      await sim.fastTravel(MZULFT_MARKER);
      await sim.step(2);
      const entrance = await sim.position(MZULFT_DOOR);
      expect(entrance && (await walkFighting(sim, entrance, 300, 150))).toBe(true);
      expect(sim.activate(MZULFT_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      const gavros = alias(sim, MG06, GAVROS);
      const at = await sim.position(gavros);
      expect(at && (await walkFighting(sim, at, 300, 150))).toBe(true);
      expect(await sim.until(() => lines.includes('MG06GavrosScene: #3 said'), 60)).toBe(true);
      await sim.step(3);
      expect(await sim.runtime.actors.isDead(gavros)).toBe(true);
      expect(await sim.take(gavros, SYNOD_JOURNAL)).toBe(true);
      expect(await sim.take(gavros, MZULFT_KEY)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MG06, 30), 5)).toBe(true);
      expect(objective(sim, MG06, 30).displayed).toBe(true);
    } finally {
      await sim.close();
    }
  }, 1_800_000);
});
