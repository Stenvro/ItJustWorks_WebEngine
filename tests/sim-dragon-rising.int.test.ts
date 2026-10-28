// Integration test: MQ104 "Dragon Rising" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ObjectHandle } from '../src/scripting/values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ103 = 0xd0800;
const MQ104 = 0x2610c;
/** WhiterunDragonsreach, and BleakFallsSanctum01 (where the Dragonstone lies). */
const DRAGONSREACH = 0x165a3;
const BLEAK_FALLS_SANCTUM = 0x371dd;
/** MQ103's dragonStone alias and the chest it is created in (BleakFallsBoss). */
const DRAGONSTONE = 18;
const STONE_CHEST = 52;
/** MQ103OutroTrigger's spot in Farengar's study. */
const FARENGAR_STUDY: [number, number, number] = [700, 1930, -70];
/** MQ104IntroScene and MQ104IrilethCourtyardScene. */
const INTRO_SCENE = 0x58f93;
const COURTYARD_SCENE = 0x5a6bc;
/** MQ104FortAttackScene (the survivor's warning; the dragon comes). */
const FORT_ATTACK_SCENE = 0x5c9de;
/** MQ104's Balgruuf, Irileth, dragon and FortCenterMarker aliases. */
const BALGRUUF = 5;
const IRILETH = 34;
const DRAGON = 24;
const FORT_CENTER = 38;

/** A scene's phase now (-1: not playing). */
function phase(sim: Sim, scene: number): number {
  return sim.runtime.scenes.snapshot().find((playing) => playing.scene === scene)?.phase ?? -1;
}

/** The player keeps within `range` of an actor (walking up beside it when it gets farther). */
async function keepNear(sim: Sim, actor: number, range: number): Promise<void> {
  const near = await sim.distance(actor, PLAYER_REF);
  const at = await sim.position(actor);
  const me = await sim.position(PLAYER_REF);
  if (near !== undefined && near > range && at && me) {
    const k = 150 / near;
    await sim.moveTo([at[0] + (me[0] - at[0]) * k, at[1] + (me[1] - at[1]) * k, at[2] + 10]);
  }
}

/** WhiterunWorld and Tamriel. */
const WHITERUN_WORLD = 0x1a26f;
const TAMRIEL = 0x3c;
/** Where the player stands by the guards' marks (MQ104BSoldierWaitMarker1-6) in Whiterun. */
const COURTYARD = { position: [20400, -7100, -3600], heading: 0 } as const;
/** On the road east of the Western Watchtower, and inside its ruined walls. */
const WATCHTOWER_ROAD = { position: [5600, -13500, -4990], heading: 0 } as const;
const WATCHTOWER: [number, number, number] = [700, -14400, -4990];

/** The game after the Jarl sent the player to the watchtower (stage 40), for the next segment. */
let afterJarl: Uint8Array | undefined;
/** The game as Irileth sets out for the watchtower (stage 46). */
let afterCourtyard: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('MQ104 Dragon Rising', () => {
  // The way in is the game's: MQ103's stages as the player made them, the Dragonstone taken from
  // its chest in Bleak Falls Sanctum (stage 180 there moves Delphine to Farengar's study),
  // then handed to Farengar in Dragonsreach (190 starts MQ104 at 10).
  it('has Irileth bring the news to the Jarl and the Jarl send the player out (stages 10-40)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      await sim.openInterior(DRAGONSREACH);
      await sim.step(1);
      for (const stage of [1, 10, 20, 50, 80, 90, 100]) {
        void sim.runtime.quests.setStage(MQ103, stage);
        await sim.step(0.5);
      }
      await sim.openInterior(BLEAK_FALLS_SANCTUM);
      await sim.step(1);
      const mq103 = sim.runtime.state.quest(MQ103);
      const stone = mq103.aliases.get(DRAGONSTONE) ?? 0;
      void sim.runtime.removeItem(
        mq103.aliases.get(STONE_CHEST) ?? 0,
        new ObjectHandle(stone, 'form'),
        1,
        false,
        PLAYER_REF,
      );
      await sim.step(1);
      // TODO(M13): taking the stone should set 180 by itself (as the game's pickup does).
      if (!sim.stageDone(MQ103, 180)) void sim.runtime.quests.setStage(MQ103, 180);
      await sim.step(2);
      await sim.openInterior(DRAGONSREACH);
      await sim.moveTo(FARENGAR_STUDY);
      await sim.step(1);
      // Farengar takes the stone (his forcegreet's line sets 190).
      void sim.runtime.quests.setStage(MQ103, 190);
      const quest = sim.runtime.state.quest(MQ104);
      const irileth = (): number => quest.aliases.get(IRILETH) ?? 0;
      // Irileth runs in and leads Farengar and the messenger to the Jarl; the player follows.
      for (let second = 0; second < 300 && phase(sim, INTRO_SCENE) < 22; second++) {
        await sim.step(1);
        await keepNear(sim, irileth(), 400);
      }
      expect(phase(sim, INTRO_SCENE)).toBe(22);
      expect([10, 12, 13, 15].every((stage) => sim.stageDone(MQ104, stage))).toBe(true);
      // The Jarl comes up and talks to the player (his ForceGreet): his line sends them to the
      // watchtower (30, 40).
      const balgruuf = quest.aliases.get(BALGRUUF) ?? 0;
      const greeting = (): number | undefined =>
        sim.menus().find((menu) => menu.menu === 'Dialogue Menu' && menu.reference === balgruuf)
          ?.topic;
      await sim.until(() => greeting() !== undefined, 20);
      expect(greeting()).toBeDefined();
      await sim.talk(balgruuf, [], greeting());
      await sim.step(1);
      expect(sim.stageDone(MQ104, 40)).toBe(true);
      await sim.until(() => sim.runtime.scenes.isPlaying(COURTYARD_SCENE), 90);
      expect(sim.runtime.scenes.isPlaying(COURTYARD_SCENE)).toBe(true);
      afterJarl = await sim.save('MQ104 40');
    } finally {
      await sim.close();
    }
  }, 300_000);

  // Found 2026-10-28: the courtyard scene, started by stage 40 and saved before the scene
  // system's next update, was gone from the loaded game (a save kept only begun scenes).
  it('has Irileth rally the guards in the courtyard and set out for the watchtower (45, 46)', async () => {
    if (!afterJarl) return;
    const sim = await loadSim(afterJarl);
    try {
      expect(sim.runtime.scenes.isPlaying(COURTYARD_SCENE)).toBe(true);
      await sim.step(5);
      // The player follows her out of Dragonsreach to the courtyard below.
      await sim.world.openExterior(WHITERUN_WORLD, { arrival: COURTYARD });
      await sim.until(() => sim.stageDone(MQ104, 46), 240);
      expect(sim.stageDone(MQ104, 45)).toBe(true);
      expect(sim.stageDone(MQ104, 46)).toBe(true);
      afterCourtyard = await sim.save('MQ104 46');
    } finally {
      await sim.close();
    }
  }, 300_000);

  // Found 2026-10-28: stage 60 enabled the dragon (MQ104BDragonRef) 23,000 units south of the
  // watchtower, outside the loaded area, and it never came: the low process sent it along the
  // navmesh roads at walking speed from its place in the sky. A flier away flies straight to
  // its package's place at its flying speed (src/shell/actors-away.ts).
  it('has the player reach the watchtower, the survivor warn them and the dragon fly in (50-60)', async () => {
    if (!afterCourtyard) return;
    const sim = await loadSim(afterCourtyard);
    try {
      const quest = sim.runtime.state.quest(MQ104);
      // The player makes their own way to the watchtower: its trigger sets 50 (Irileth and the
      // guards are moved there if unloaded), and Irileth's speech by the tower ends in 52.
      await sim.world.openExterior(TAMRIEL, { arrival: WATCHTOWER_ROAD });
      expect(await sim.until(() => sim.stageDone(MQ104, 52), 90)).toBe(true);
      // Into the ruined fort (55): the survivor's warning, then the dragon (60).
      await sim.moveTo(WATCHTOWER);
      expect(await sim.until(() => sim.stageDone(MQ104, 60), 60)).toBe(true);
      const dragon = quest.aliases.get(DRAGON) ?? 0;
      const center = quest.aliases.get(FORT_CENTER) ?? 0;
      // It flies in and circles the fort (MQ104DragonOrbitFort: 3,000 to 8,000 units round it).
      expect(await sim.until(() => sim.package(dragon)?.procedure === 'Orbit', 90)).toBe(true);
      expect(await sim.distance(dragon, center)).toBeLessThan(9000);
      // The scene waits for the fight (65) in its last phase.
      expect(await sim.until(() => phase(sim, FORT_ATTACK_SCENE) === 8, 30)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 300_000);

  // Stalls 2026-10-28 at stage 65 (MQ104DragonScript's OnCombatStateChanged: the dragon enters
  // combat). The dragon orbits the fort at a radius drawn between 3,000 and 8,000 units, 4,000
  // up (MQ104DragonOrbitFort, as the engine's Orbit reads it), and detection reaches
  // fSneakMaxDistance × fSneakExteriorDistanceMult × fSneakFlyingDistanceMult (1500 × 2 × 2 =
  // 6,000 with either one flying, observed in the original): it drew a radius of about
  // 6,500 and stays out of reach of the player and the guards; a guard saw it once for a
  // moment and its combat ended as it lost it. Next: what brings the original's orbiting dragon
  // into the fight (its search for targets while orbiting, or the guards' bows), then the
  // flight fight (landing at its forced landing marker, breath, the guards' arrows), its death
  // (80), the absorption (85, 90: DragonSouls, "Dragon soul absorbed"), the guard's
  // "Dovahkiin" (OutroScene), the Jarl (100-160) and the Greybeards' call (110: MQ105 at 5).
  it.todo('fights the dragon down, absorbs its soul and reports to the Jarl (65-200)');
});
