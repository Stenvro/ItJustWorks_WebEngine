// Speech checks at Riften's north gate (DialogueRiftenGateGuards): the guard asks for the
// visitor's tax, and the player may pay it ("<BribeCost> gold": GetBribeSuccess, the gold a bribe
// of the guard takes), persuade him (his line's conditions are all OR: it always works) or
// intimidate him (GetIntimidateSuccess). A success runs the game's FavorDialogueScript (the skill
// use, the Persuasions, Bribes or Intimidations count, the guard's mark). The vanilla persuasion
// check (Speechcraft against a speech global) on MS02's Borkul the Beast. Observed in the
// original: none of them is a story manager event (docs/scripting.md, "Story events"). Skipped
// without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorValueIndex } from '../src/world/actor-values.ts';
import type { InfoRecord } from '../src/world/dialogue-records.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

/** DialogueRiftenGateNorthBranchTopic: the guard's forcegreet, "Hold there.". */
const OPENING = 0xe66b9;
/** The infos said: persuaded or not, paid or not, intimidated or not. */
const PERSUADED = 0xe66d2;
const NOT_PERSUADED = 0x51a45;
const PAID = 0xe66cb;
const NOT_PAID = 0x51a42;
const INTIMIDATED = 0x51a69;
const NOT_INTIMIDATED = 0x51b10;
const GOLD = 0xf;
const SPEECH = actorValueIndex('Speechcraft') ?? 17;
const CONFIDENCE = actorValueIndex('Confidence') ?? 1;
/** Borkul the Beast (NPC_), and the global his persuasion compares Speechcraft with. */
const BORKUL = 0x1338a;
const SPEECH_CHECK = 0xd16a5;

describe.skipIf(!hasGamedata())('speech checks: Riften’s north gate, Borkul the Beast', () => {
  let sim: Sim;
  let gateQuest: number;
  let guard: number;
  const said: number[] = [];
  beforeAll(async () => {
    sim = await openSim({ hour: 10 });
    await sim.runtime.dialogue.index.build();
    gateQuest = await sim.formId('QUST', 'DialogueRiftenGateGuards');
    const alias = sim.runtime.state.quests.get(gateQuest)?.aliases.get(0);
    if (alias === undefined) throw new Error('no north gate guard');
    guard = alias;
    sim.runtime.events.on('topicInfo', (event) => {
      if (event.type === 'begin') said.push(event.topicInfo);
    });
  }, 180_000);
  afterAll(async () => {
    await sim.close();
  });

  const player = (level: number, speech: number): void => {
    sim.runtime.state.actor(PLAYER_REF).level = level;
    sim.runtime.actors.setBase(PLAYER_REF, SPEECH, speech);
  };
  const gold = (): Promise<number> => sim.runtime.itemCount(PLAYER_REF, GOLD);
  /** The gate quest's stages as the guard first asks for the tax (a success sets stage 30). */
  let toll: { stage: number; done: number[] } | undefined;
  /**
   * The guard asks for the tax (again, as it stood first), the player asks what it is for, then
   * chooses; the topics listed last.
   */
  const ask = (choose: readonly RegExp[]): Promise<string[]> => {
    const quest = sim.runtime.state.quest(gateQuest);
    toll ??= { stage: quest.stage, done: [...quest.stagesDone] };
    quest.stage = toll.stage;
    quest.stagesDone.clear();
    for (const stage of toll.done) quest.stagesDone.add(stage);
    return sim.converse(guard, [/tax for/, ...choose], OPENING);
  };
  /** The player chooses a topic as the guard asks for the tax; the infos said. */
  const talk = async (choice: RegExp): Promise<number[]> => {
    const from = said.length;
    await ask([choice]);
    return said.slice(from);
  };

  it('ask for a tax of the gold a bribe of the guard takes (<BribeCost>)', async () => {
    player(1, 15);
    const cost = await sim.runtime.crime.bribeAmount(guard);
    expect(cost).toBeGreaterThan(0);
    expect(await ask([])).toContain(
      `This is obviously a shakedown, but I'll pay. (${String(cost)} gold)`,
    );
  }, 120_000);

  it('take the bribe if the player has the gold', async () => {
    await sim.runtime.removeItem(
      PLAYER_REF,
      sim.runtime.formHandle(GOLD),
      await gold(),
      true,
      undefined,
    );
    expect(await talk(/I'll pay/)).toContain(NOT_PAID);
    const cost = await sim.runtime.crime.bribeAmount(guard);
    await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(GOLD), cost + 10, true);
    expect(await talk(/I'll pay/)).toContain(PAID);
    // FavorDialogueScript.Bribe: the gold to the guard, the mark, the count.
    expect(await gold()).toBe(10);
    expect(sim.runtime.crime.persuaded(guard, 'bribed')).toBe(true);
    expect(sim.runtime.stats.get('bribes')).toBe(1);
  }, 120_000);

  it('are intimidated by level and Speechcraft, unless foolhardy', async () => {
    // The guard is Foolhardy (Confidence 4): fIntimidateConfidenceMultFoolhardy 100 times his
    // level, out of reach.
    expect((await sim.runtime.actors.value(guard, CONFIDENCE)).base).toBe(4);
    player(60, 100);
    expect(await talk(/Intimidate/)).toContain(NOT_INTIMIDATED);
    // As an average one (Confidence 2): his level against the player's level × (1 + (100 −
    // his Speech) / 100) ^ 1.5.
    sim.runtime.actors.setBase(guard, CONFIDENCE, 2);
    player(1, 15);
    expect(await talk(/Intimidate/)).toContain(NOT_INTIMIDATED);
    expect(sim.runtime.stats.get('intimidations') ?? 0).toBe(0);
    player(60, 100);
    expect(await talk(/Intimidate/)).toContain(INTIMIDATED);
    // An intimidation takes the bribe's place.
    expect(sim.runtime.crime.persuaded(guard, 'intimidated')).toBe(true);
    expect(sim.runtime.crime.persuaded(guard, 'bribed')).toBe(false);
    expect(sim.runtime.stats.get('intimidations')).toBe(1);
  }, 120_000);

  it('are persuaded at any Speechcraft at the north gate (its line’s conditions are all OR)', async () => {
    player(1, 15);
    const lines = await talk(/Persuade/);
    expect(lines).toContain(PERSUADED);
    expect(lines).not.toContain(NOT_PERSUADED);
    expect(sim.runtime.stats.get('persuasions')).toBe(1);
  }, 120_000);

  it('persuades by Speechcraft against a speech global (MS02: Borkul the Beast)', async () => {
    // "Madanach is expecting me. (Persuade)": GetIsID Borkul AND (the player's Speechcraft >=
    // a speech global OR the Amulet of Articulation), the vanilla persuasion check.
    const ms02 = await sim.formId('QUST', 'MS02');
    let info: InfoRecord | undefined;
    for (const topic of sim.runtime.dialogue.index.topicsOfQuest(ms02)) {
      info ??= (await sim.runtime.dialogue.index.infos(topic)).find((i) => i.formId === 0xdf1d2);
    }
    let borkul: number | undefined;
    await sim.db.scan(
      ['ACHR'],
      () => true,
      (record) => {
        if (record.formIdField('NAME') === BORKUL) borkul = record.formId;
      },
    );
    if (!info || borkul === undefined) throw new Error('no Borkul or no line');
    const { conditions } = info;
    const subject = sim.runtime.referenceHandle(borkul);
    const holds = (): Promise<boolean> =>
      sim.runtime.conditionsHold(conditions, subject, undefined, {
        target: sim.runtime.referenceHandle(PLAYER_REF),
        quest: ms02,
      });
    const name = (await sim.db.get(SPEECH_CHECK))?.editorId ?? '';
    const needed = (await sim.runtime.globalNamed(name)) ?? 0;
    expect(needed).toBeGreaterThan(15);
    player(1, 15);
    expect(await holds()).toBe(false);
    player(1, needed);
    expect(await holds()).toBe(true);
  }, 120_000);

  it('raises no story manager event (the original’s rule)', () => {
    for (const type of ['FLAT', 'BRIB', 'INTM', 'PRFV']) expect(sim.storyEvents(type)).toEqual([]);
  });
});
