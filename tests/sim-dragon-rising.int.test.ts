// Integration test: MQ104 "Dragon Rising" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { FlyingState } from '../src/ai/flight.ts';
import { ObjectHandle } from '../src/scripting/values.ts';
import { ActorValue } from '../src/world/actor-values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ103 = 0xd0800;
const MQ104 = 0x2610c;
/** MQ105 "The Way of the Voice" (the Greybeards' call starts it). */
const MQ105 = 0x242ba;
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
/** The guards' lines after the absorption: "You... must be Dragonborn!", "But the old tales
 * tell of the Dragonborn..." (MQ104DragonDeathScene). */
const MUST_BE_DRAGONBORN = 0xbcf16;
const OLD_TALES = 0xa3f80;

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
/** The game with the dragon circling the watchtower (stage 60, the scene's last phase). */
let afterDragon: Uint8Array | undefined;
/** The game with the dragon's soul absorbed (stage 90). */
let afterAbsorb: Uint8Array | undefined;
/** The game after the guards' talk and the player's first Shout (108). */
let afterGuards: Uint8Array | undefined;
/** The game with the Jarl's outro talk done (150). */
let afterJarlOutro: Uint8Array | undefined;

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
          ?.opening;
      await sim.until(() => greeting() !== undefined, 20);
      expect(greeting()).toBeDefined();
      await sim.converse(balgruuf, [], greeting());
      await sim.step(1);
      expect(sim.stageDone(MQ104, 40)).toBe(true);
      await sim.until(() => sim.runtime.scenes.isPlaying(COURTYARD_SCENE), 90);
      expect(sim.runtime.scenes.isPlaying(COURTYARD_SCENE)).toBe(true);
      afterJarl = await sim.save('MQ104 40');
    } finally {
      await sim.close();
    }
  }, 600_000);

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
  }, 600_000);

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
      // The scene comes to its last phases (the dragon's line, then the wait for the fight, 65),
      // unless the fight began already.
      expect(
        await sim.until(() => phase(sim, FORT_ATTACK_SCENE) >= 7 || sim.stageDone(MQ104, 65), 30),
      ).toBe(true);
      afterDragon = await sim.save('MQ104 60');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Found 2026-10-28: the dragon circled the fort 7,500 units off and never fought (stage 65,
  // MQ104DragonScript's OnCombatStateChanged, never came). It was beyond the high process's
  // 4,096 units, so no one tested it nor it anyone, though its scene keeps it in the high
  // process (src/ai/process-levels.ts) and detection reaches a flier 2500 × 2.1 × 3 = 15,750
  // units outside (Skyrim.esm's fSneak* settings); and in the air, with no controller, it
  // counted as standing still. Now the guards see it, it sees them, and the fight is the
  // combat tree's Flight subtree: orbits, dive bombs, hovers and ground attacks.
  it('fights the dragon down, the player comes to its body and absorbs its soul (65-90)', async () => {
    if (!afterDragon) return;
    const sim = await loadSim(afterDragon);
    try {
      const quest = sim.runtime.state.quest(MQ104);
      const dragon = quest.aliases.get(DRAGON) ?? 0;
      const flight = sim.world.stage.flight;
      // Saved in the air, it flies on (it is not set down on the ground as the save loads).
      await sim.step(1);
      expect(flight.isFlying(dragon)).toBe(true);
      // It sees the guards round the tower (or they it) and the fight begins (65).
      expect(await sim.until(() => sim.stageDone(MQ104, 65), 30)).toBe(true);
      const health = async (): Promise<number> =>
        (await sim.runtime.actors.value(dragon, ActorValue.health)).current;
      const full = await health();
      // It lands for a ground attack and fights there; the guards' arrows and Irileth wound it.
      const landed = (): boolean =>
        sim.world.stage.combat.engaged(dragon) && flight.state(dragon) === FlyingState.none;
      expect(await sim.until(landed, 120)).toBe(true);
      let wounded = false;
      for (let second = 0; second < 60 && !wounded; second++) {
        await sim.step(1);
        wounded = (await health()) < full;
      }
      expect(wounded).toBe(true);
      // The player finishes it on the ground (TODO(M13): the player's own blows; the sim has no
      // aimed attacks yet): its death sets 80, the guards gather round it (DragonDeathScene).
      await sim.until(landed, 120);
      await sim.kill(dragon, PLAYER_REF);
      expect(await sim.until(() => sim.stageDone(MQ104, 80), 20)).toBe(true);
      // The player walks up to it: within its deathFXrange (1,024) MQ104DragonScript sets 85.
      const at = await sim.position(dragon);
      if (at) await sim.moveTo([at[0] + 500, at[1], at[2] + 50]);
      expect(await sim.until(() => sim.stageDone(MQ104, 85), 30)).toBe(true);
      // Found 2026-10-28: the absorption never came (90). The dragon's DragonActorScript comes
      // from its base's template (MQ104Dragon's), and a persistent actor whose scripts are not
      // its base's own never ran OnInit, so the script stayed in its empty state, which has no
      // OnDeath. Now its scripts start as its cell attaches, OnDeath goes to deadAndWaiting,
      // and with the player in deathFXrange MQKillDragonScript.DeathSequence plays: the skin
      // burns away, the soul goes to the player (DragonSouls, DragonsAbsorbed), 90.
      const actorScript = new ObjectHandle(dragon, 'dragonactorscript');
      expect(await sim.until(() => sim.stageDone(MQ104, 90), 40)).toBe(true);
      expect(await sim.runtime.vm.stateOf(actorScript)).toBe('deaddisintegrated');
      expect(await sim.runtime.actors.isGhost(dragon)).toBe(true);
      expect(sim.events('dragonSoulGained')).toEqual([{ souls: 1 }]);
      expect(await sim.runtime.globalNamed('DragonsAbsorbed')).toBe(1);
      // Stage 90 spends that soul on Fus (TeachWord, UnlockWord) and lets the player shout.
      const fus = await sim.formId('WOOP', 'WordFus');
      expect(fus).not.toBe(0);
      expect(await sim.until(() => sim.runtime.wordsLearned.get(fus) === true, 5)).toBe(true);
      expect((await sim.runtime.actors.value(PLAYER_REF, ActorValue.dragonSouls)).current).toBe(0);
      afterAbsorb = await sim.save('MQ104 90');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The guards' talk after the absorption (MQ104DragonDeathScene) plays by itself: the old
  // tales of the Dragonborn, "Dovahkiin", until its first line asks whether the player tried
  // to Shout (95); the player equips Unrelenting Force (92) and shouts (100), and the scene
  // ends (105, 108).
  it('has the guards call the player Dragonborn, and the player shout (90-108)', async () => {
    if (!afterAbsorb) return;
    const sim = await loadSim(afterAbsorb);
    try {
      expect(await sim.until(() => sim.stageDone(MQ104, 95), 300)).toBe(true);
      // The first guard: "You... must be Dragonborn!"; then the old tales of the Dragonborn
      // ("Dovahkiin") among them.
      const said = (info: number): boolean =>
        sim.events('topicInfo').some((line) => line.topicInfo === info && line.type === 'begin');
      expect(said(MUST_BE_DRAGONBORN)).toBe(true);
      expect(said(OLD_TALES)).toBe(true);
      // Stage 92's help: "Use [Shout] to Shout." (MQ104Shout).
      const help = (): string[] =>
        sim
          .records()
          .flatMap((record) =>
            record.kind === 'hud' && record.type === 'helpMessage' ? [record.text] : [],
          );
      expect(await sim.equip(await sim.formId('SHOU', 'UnrelentingForceShout'))).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ104, 92)).toBe(true);
      expect(help().some((text) => text.includes('Shout'))).toBe(true);
      sim.press('Shout', true);
      await sim.step(0.3);
      sim.press('Shout', false);
      expect(await sim.until(() => sim.stageDone(MQ104, 100), 5)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ104, 108), 120)).toBe(true);
      afterGuards = await sim.save('MQ104 108');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back in Whiterun (MQ104PlayerScript's OnLocationChange into its HQLocation, Whiterun) the
  // Greybeards' call is heard 6 s on (110: MQ105 starts at 5). In Dragonsreach the Jarl's
  // outro scene plays and he comes to the player (his ForceGreet): told of the Dragonborn and
  // the Greybeards, he sends them to High Hrothgar (150: MQ105 at 10).
  it('has the Greybeards call and the Jarl send the player to High Hrothgar (110-150)', async () => {
    if (!afterGuards) return;
    const sim = await loadSim(afterGuards);
    try {
      await sim.world.openExterior(WHITERUN_WORLD, { arrival: COURTYARD });
      expect(await sim.until(() => sim.stageDone(MQ104, 110), 15)).toBe(true);
      expect(await sim.until(() => sim.stage(MQ105) >= 5, 5)).toBe(true);
      await sim.openInterior(DRAGONSREACH);
      const quest = sim.runtime.state.quest(MQ104);
      const balgruuf = quest.aliases.get(BALGRUUF) ?? 0;
      const at = await sim.position(balgruuf);
      if (at) await sim.moveTo([at[0] + 120, at[1], at[2] + 10]);
      const greeting = (): number | undefined =>
        sim.menus().find((menu) => menu.menu === 'Dialogue Menu' && menu.reference === balgruuf)
          ?.opening;
      expect(await sim.until(() => greeting() !== undefined, 120)).toBe(true);
      await sim.converse(
        balgruuf,
        [/called "Dragonborn/, /absorbed|called me/, /^The Greybeards/, /want with me/],
        greeting(),
      );
      expect(await sim.until(() => sim.stageDone(MQ104, 150), 10)).toBe(true);
      expect(sim.stage(MQ105)).toBeGreaterThanOrEqual(10);
      afterJarlOutro = await sim.save('MQ104 150');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The scene goes on (Hrongar, Proventus) and the Jarl comes up again to reward the player:
  // his line makes them Thane-to-be (160: the quest completes) and the quest stops (200).
  it('has the Jarl reward the player and the quest complete (160-200)', async () => {
    if (!afterJarlOutro) return;
    const sim = await loadSim(afterJarlOutro);
    try {
      const quest = sim.runtime.state.quest(MQ104);
      const balgruuf = quest.aliases.get(BALGRUUF) ?? 0;
      const reward = (): number | undefined =>
        sim.menus().find((menu) => menu.menu === 'Dialogue Menu' && menu.reference === balgruuf)
          ?.opening;
      expect(await sim.until(() => reward() !== undefined, 240)).toBe(true);
      await sim.converse(balgruuf, [], reward());
      expect(await sim.until(() => sim.stageDone(MQ104, 160), 10)).toBe(true);
      expect(quest.completed).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ104, 200), 30)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
