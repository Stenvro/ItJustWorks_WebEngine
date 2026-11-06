// Integration test: MQ204 "The Throat of the World" on the headless simulation, played through as
// the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ203 = 0x36192;
const MQ204 = 0x2d515;
/** MQ204's Arngeir, Borri, Wulfgar and Einarth aliases. */
const ARNGEIR = 0;
const MASTERS = [1, 2, 3];
/** HighHrothgarMapMarker, a front door of the monastery and its hall. */
const HIGH_HROTHGAR_MARKER = 0x16352;
const FRONT_DOOR = 0x877d3;
const HIGH_HROTHGAR = 0x87764;
const TAMRIEL = 0x3c;
/** The hall's door to the courtyard (inside). */
const COURTYARD_DOOR = 0x877cd;
/** In the courtyard, by Arngeir's way to the gate. */
const WITH_ARNGEIR: [number, number, number] = [56100, -37100, 23710];
/** MQ204GreybeardsIntroScene and MQ204ClearSkiesScene. */
const INTRO_SCENE = 0xb3a40;
const CLEAR_SKIES_SCENE = 0x3c1ad;
/** The words' triggers (MQ204SetStage80, 81 and 82). */
const WORD_1 = 0xb39ab;
const WORD_2 = 0xb3a0e;
const WORD_3 = 0xb39c6;
/** The wind across the gate (MQ204HrothgarPushbackTRIG), its collision (the objective's target)
 * and a bank of the fog behind it (MQ204ClearSkyFog). */
const GATE_WIND = 0x9dd0f;
const GATE_COLLISION = 0x34e03;
const FIRST_FOG = 0x94ccf;
/** The two blizzards on the way up (MQTotWHazardTrig), the trigger at the top (MQ204SetStage95),
 * MQ204PaarthurnaxScene and the Paarthurnax alias. */
const BLIZZARDS = [0x105965, 0x10f764];
const SUMMIT_TRIGGER = 0x1010ab;
const PAARTHURNAX_SCENE = 0x3f8b6;
const PAARTHURNAX = 4;

/** The game with the player in High Hrothgar (stage 10). */
let atHighHrothgar: Uint8Array | undefined;
/** The game with Arngeir's refusal overruled (stage 40). */
let afterRefusal: Uint8Array | undefined;
/** The game with Arngeir's "Come" (stage 60). */
let afterSent: Uint8Array | undefined;
/** The game with the first word shown (stage 70). */
let afterFirstShown: Uint8Array | undefined;
/** The game with Clear Skies learned (stage 86). */
let afterWords: Uint8Array | undefined;
/** The game with the path open and the fog before the player (stage 90). */
let afterGate: Uint8Array | undefined;
/** The game at the summit, Paarthurnax coming (stage 95). */
let afterClimb: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/** An objective of MQ204 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(MQ204).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

/** The player taps the voice key (one word). */
async function shout(sim: Sim): Promise<void> {
  sim.press('Shout', true);
  await sim.step(0.1);
  sim.press('Shout', false);
}

describe.skipIf(!hasGamedata())('MQ204 The Throat of the World', () => {
  // MQ204's own start for a game that skips ahead: its stage 0 sets 1, which plays MQ203 to 300
  // (played in sim-alduins-wall) and moves Delphine and Esbern to the temple; MQ203's 300 is
  // MQ204's 10, "Talk to Arngeir". By the map to the monastery, and in at its front door.
  it('sends the player back to Arngeir (0-10)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ204, 0);
      expect(await sim.until(() => sim.stageDone(MQ204, 10), 120)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ203, 300)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      expect(sim.runtime.mapMarkerVisible(HIGH_HROTHGAR_MARKER)).toBe(true);
      await sim.fastTravel(HIGH_HROTHGAR_MARKER);
      await sim.step(2);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      const door = await sim.position(FRONT_DOOR);
      expect(door && (await sim.walkPath(door, 180, 200))).toBe(true);
      expect(sim.activate(FRONT_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(HIGH_HROTHGAR);
      expect((await sim.runtime.placement(alias(sim, MQ204, ARNGEIR)))?.cell).toBe(HIGH_HROTHGAR);
      atHighHrothgar = await sim.save('MQ204 10');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Arngeir's first answer: "I need to learn the Shout used to defeat Alduin" is 20
  // (MQ204GreybeardsIntroScene: the masters gather round him); telling who helped is 30; his
  // refusal, "So you won't help me?", 35, and the conversation's end. The scene's phase 3 has
  // Einarth speak (the ground shakes): its end is 40.
  it('has Arngeir refuse, and the masters overrule him (20-40)', async () => {
    if (!atHighHrothgar) return;
    const sim = await loadSim(atHighHrothgar);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const arngeir = alias(sim, MQ204, ARNGEIR);
      const at = await sim.position(arngeir);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(await sim.talk(arngeir)).toContain('I need to learn the Shout used to defeat Alduin.');
      await sim.choose(/Shout used to defeat Alduin/);
      expect(sim.stageDone(MQ204, 20)).toBe(true);
      expect(objective(sim, 10).completed).toBe(false);
      expect(sim.runtime.scenes.isPlaying(INTRO_SCENE)).toBe(true);
      await sim.choose(/Alduin's Wall/);
      expect(sim.stageDone(MQ204, 30)).toBe(true);
      await sim.choose(/aren't keeping secrets/);
      expect(sim.stageDone(MQ204, 35)).toBe(false);
      expect(await sim.choose(/So you won't help me/)).toEqual([]);
      expect(sim.stageDone(MQ204, 35)).toBe(true);
      expect(sim.stageDone(MQ204, 40)).toBe(false);
      expect(await sim.until(() => sim.stageDone(MQ204, 40), 120)).toBe(true);
      expect(lines).toContain('MQ204GreybeardsIntroScene: #4 said');
      for (const id of MASTERS) {
        expect(await sim.distance(alias(sim, MQ204, id), arngeir)).toBeLessThan(500);
      }
      afterRefusal = await sim.save('MQ204 40');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // "Dragonborn... wait." (phase 5), and he comes to the player (MQ204ArngeirIntroForceGreet): his
  // apology is 50 (MQ204ClearSkiesScene takes over); what he says of Paarthurnax 55; "How do I get
  // to the top of the mountain to see him?" 60, a Goodbye: "Come", and the scene goes on.
  it('has Arngeir come back to the player and tell of Paarthurnax (50-60)', async () => {
    if (!afterRefusal) return;
    const sim = await loadSim(afterRefusal);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const arngeir = alias(sim, MQ204, ARNGEIR);
      expect(sim.stageDone(MQ204, 50)).toBe(false);
      expect(await sim.listen(arngeir, 60)).toEqual(['So, can you teach me this Shout?']);
      expect(lines).toContain('MQ204GreybeardsIntroScene: #5 said');
      expect(sim.stageDone(MQ204, 50)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(INTRO_SCENE)).toBe(false);
      expect(sim.runtime.scenes.isPlaying(CLEAR_SKIES_SCENE)).toBe(true);
      await sim.choose(/teach me this Shout/);
      await sim.choose(/how can I defeat Alduin/);
      expect(sim.topics).not.toContain('How do I get to the top of the mountain to see him?');
      await sim.choose(/Why haven't I met/);
      expect(sim.stageDone(MQ204, 55)).toBe(true);
      expect(sim.stageDone(MQ204, 60)).toBe(false);
      expect(await sim.choose(/top of the mountain/)).toEqual([]);
      expect(sim.stageDone(MQ204, 60)).toBe(true);
      // On his way, and the masters too: phase 0 waited for 60.
      expect(
        await sim.until(
          () => lines.includes('MQ204ClearSkiesScene: #5 package starts for 000886b3'),
          5,
        ),
      ).toBe(true);
      afterSent = await sim.save('MQ204 60');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // He leads the masters out of the hall to the gate at the courtyard's end. The player after
  // them: "The path to Paarthurnax lies through this gate" (phase 3); by his marker he says "Lok"
  // (phase 6: its end is 65, his Teach effect at the word), and the word shows on the ground (70).
  it('has the masters lead the player out to the gate (65-70)', async () => {
    if (!afterSent) return;
    const sim = await loadSim(afterSent);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const arngeir = alias(sim, MQ204, ARNGEIR);
      const outside = async (actor: number): Promise<boolean> =>
        (await sim.runtime.placement(actor))?.world === TAMRIEL;
      for (let second = 0; second < 90 && !(await outside(arngeir)); second++) await sim.step(1);
      expect(await outside(arngeir)).toBe(true);
      const door = await sim.position(COURTYARD_DOOR);
      expect(door && (await sim.walkPath(door, 120, 120))).toBe(true);
      expect(sim.activate(COURTYARD_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect(await outside(PLAYER_REF)).toBe(true);
      expect(await sim.walkPath(WITH_ARNGEIR, 60, 100)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ204, 70), 120)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ204, 65)).toBe(true);
      for (const said of ['#15', '#24']) {
        expect(lines).toContain(`MQ204ClearSkiesScene: ${said} said`);
      }
      expect(await sim.distance(arngeir, WORD_1)).toBeLessThan(400);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      for (const id of MASTERS) expect(await outside(alias(sim, MQ204, id))).toBe(true);
      afterFirstShown = await sim.save('MQ204 70');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Each word shows as Arngeir says it (70, 71, 72); the player stands on it to learn it (80, 81,
  // 82, the last is 83: objective 25). Once they are near, he gives them his understanding (the
  // absorb: 85, its end 86, which unlocks all three words), and tells of the path.
  it('has the player learn the three words of Clear Skies (80-86)', async () => {
    if (!afterFirstShown) return;
    const sim = await loadSim(afterFirstShown);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const words = await Promise.all(
        ['WordLok', 'WordVah', 'WordKoor'].map((word) => sim.formId('WOOP', word)),
      );
      for (const [word, shown, learned] of [
        [WORD_1, 70, 80],
        [WORD_2, 71, 81],
        [WORD_3, 72, 82],
      ] as const) {
        expect(await sim.until(() => sim.stageDone(MQ204, shown), 60)).toBe(true);
        expect(sim.stageDone(MQ204, learned)).toBe(false);
        const at = await sim.position(word);
        expect(at && (await sim.walkPath(at, 30, 30))).toBe(true);
        expect(await sim.until(() => sim.stageDone(MQ204, learned), 30)).toBe(true);
      }
      expect(await sim.until(() => sim.stageDone(MQ204, 83), 10)).toBe(true);
      await sim.step(1);
      for (const word of words) expect(sim.runtime.wordsLearned.get(word)).toBe(false);
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 25)).toEqual({ displayed: true, completed: false });
      expect(await sim.until(() => sim.stageDone(MQ204, 86), 90)).toBe(true);
      await sim.step(1);
      for (const word of words) expect(sim.runtime.wordsLearned.get(word)).toBe(true);
      expect(lines).toContain('MQ204ClearSkiesScene: #32 said');
      afterWords = await sim.save('MQ204 86');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The wind holds the way past the gate; the shout blows it away, wherever the player looks into
  // its wide volume (MQ204HrothgarPushbackSCRIPT's OnHit by the cone cast by the shout's
  // magicCastAnotherSpellScript: the collision and the wind go). Found 2026-11-06: a script's cast
  // left the player level whatever they looked at, and a cone reached a body only at its middle,
  // so the wind, its middle 300 units above their eyes, never heard of the shout. The fog behind
  // is MQ204ShoutTrigger: the first bank the shout reaches is 90.
  it('has the player open the path with Clear Skies (90)', async () => {
    if (!afterWords) return;
    const sim = await loadSim(afterWords);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const seen = (line: string) => (): boolean => lines.includes(`MQ204ClearSkiesScene: ${line}`);
      expect(await sim.equip(await sim.formId('SHOU', 'ClearSkiesShout'))).toBe(true);
      const beyond = await sim.position(FIRST_FOG);
      expect(beyond).toBeDefined();
      if (!beyond) return;
      expect(await sim.walkPath(beyond, 30, 300)).toBe(false);
      expect(await sim.enabled(GATE_COLLISION)).toBe(true);
      const held = sim.world.player.feet;
      expect(await sim.distance(PLAYER_REF, GATE_WIND)).toBeLessThan(600);
      expect(await sim.until(seen('#20 said'), 60)).toBe(true);
      expect(sim.stageDone(MQ204, 90)).toBe(false);
      const wind = await sim.position(GATE_WIND);
      expect(wind).toBeDefined();
      if (!wind) return;
      sim.look([wind[0], wind[1], held[2] + 110]);
      await sim.step(1);
      await shout(sim);
      await sim.step(4);
      expect(await sim.enabled(GATE_COLLISION)).toBe(false);
      expect(await sim.enabled(GATE_WIND)).toBe(false);
      expect(sim.stageDone(MQ204, 90)).toBe(false);
      // Through the gap, up to the first of the fog.
      expect(await sim.walkPath(beyond, 30, 300)).toBe(true);
      sim.look(beyond);
      await shout(sim);
      expect(await sim.until(() => sim.stageDone(MQ204, 90), 3)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 25)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      expect(sim.runtime.scenes.isPlaying(CLEAR_SKIES_SCENE)).toBe(false);
      afterGate = await sim.save('MQ204 90');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The path winds up the mountain through the fog (each bank slows those in it) to two blizzards
  // across the way (MQTotWHazardTrig, a collision box with each: the player cannot pass while it
  // blows). Held there, they turn to it and shout: MQTotWHazardSCRIPT's OnHit stops it and takes
  // box and wind away. Found 2026-11-06: the box beside a blizzard's volume hid the volume from
  // the cone (L_CONEPROJECTILE meets a collision box, L_SPELL does not; a cone's sight of an
  // actor went by L_SPELL already). The trigger at the top is 95: Paarthurnax comes.
  it('has the player climb to the summit, shouting the blizzards away (95)', async () => {
    if (!afterGate) return;
    const sim = await loadSim(afterGate);
    try {
      const paarthurnax = alias(sim, MQ204, PAARTHURNAX);
      expect(await sim.enabled(paarthurnax)).toBe(false);
      expect(sim.runtime.state.quest(MQ204).objectives.get(30)?.displayed).toBe(true);
      const summit = await sim.position(SUMMIT_TRIGGER);
      expect(summit).toBeDefined();
      if (!summit) return;
      let shouted = 0;
      let last = [...sim.world.player.feet];
      for (let leg = 0; leg < 25 && !sim.stageDone(MQ204, 95); leg++) {
        await sim.walkPath(summit, 15, 200);
        const feet = sim.world.player.feet;
        const moved = Math.hypot(feet[0] - (last[0] ?? 0), feet[1] - (last[1] ?? 0));
        last = [...feet];
        if (moved >= 200 || sim.stageDone(MQ204, 95)) continue;
        // Held: the blizzard nearest them, still blowing.
        const blowing: [number, number][] = [];
        for (const blizzard of BLIZZARDS) {
          if (!(await sim.enabled(blizzard))) continue;
          blowing.push([(await sim.distance(PLAYER_REF, blizzard)) ?? Infinity, blizzard]);
        }
        const nearest = blowing.sort(([a], [b]) => a - b)[0]?.[1];
        const at = nearest === undefined ? undefined : await sim.position(nearest);
        expect(at).toBeDefined();
        if (!at) return;
        sim.look(at);
        await sim.step(0.2);
        await shout(sim);
        shouted += 1;
        await sim.step(3);
        expect(nearest !== undefined && (await sim.enabled(nearest))).toBe(false);
      }
      expect(sim.stageDone(MQ204, 95)).toBe(true);
      await sim.step(1);
      expect(shouted).toBe(BLIZZARDS.length);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      expect(await sim.enabled(paarthurnax)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(PAARTHURNAX_SCENE)).toBe(true);
      afterClimb = await sim.save('MQ204 95');
    } finally {
      await sim.close();
    }
  }, 600_000);
});
