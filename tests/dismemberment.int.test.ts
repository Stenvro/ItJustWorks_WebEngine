// Integration test: dismemberment's data on the local game data (docs/animation.md,
// "Dismemberment"): the human body part data's head, the races' decapitation armors and blood,
// the decapitation armor's stump and cut partitions, the graphs that raise Decapitate (an
// execution's chop, the decapitating killmoves' 2_Decapitate before 2_KillActor), and no body
// part flagged to be cut or blown off by hits. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBehaviorGraph, type BehaviorGenerator } from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { faceKeepsPartition, pieceShowsPartition } from '../src/gameplay/combat/dismemberment.ts';
import { parseRace } from '../src/world/actor-records.ts';
import { ActorResolver, meshPath } from '../src/world/actors.ts';
import {
  BodyPartFlag,
  BodyPartType,
  headNode,
  parseBodyPartData,
} from '../src/world/body-part-data.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const NORD_RACE = 0x13746;
const DECAPITATED_HEAD = 0xdb5d0;
const BLOOD_SPRAY_DECAP = 'BloodSprayDecap01';

describe.skipIf(!hasGamedata())('dismemberment on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const parse = (record: GameRecord): ReturnType<typeof parseBodyPartData> =>
    parseBodyPartData({
      fields: record.fields,
      formIdAt: (data, offset) => record.formIdAt(data, offset),
    });

  /** The skin partitions (body part, bones) of a model's dismember skin instances. */
  const partitions = async (path: string): Promise<{ parts: number[]; bones: string[] }[]> => {
    const nif = parseNif(await vfs.read(path));
    const name = (ref: number): string => {
      const block = nif.blocks[ref] as { name?: string } | undefined;
      return block?.name ?? '';
    };
    return nif.blocks.flatMap((block) =>
      block.kind === 'skin-instance' && block.bodyParts
        ? [{ parts: block.bodyParts.map((part) => part.part), bones: block.bones.map(name) }]
        : [],
    );
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
  });
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it("reads the human body part data's head and its blood, and no part hits cut or blow off", async () => {
    let flagged = 0;
    for (const id of db.formIdsOfType('BPTD')) {
      const record = await db.get(id);
      if (!record) continue;
      for (const part of parse(record)) {
        if ((part.flags & (BodyPartFlag.severable | BodyPartFlag.explodable)) !== 0) flagged++;
      }
    }
    expect(flagged).toBe(0);
    const human = await db.get(0x1d);
    if (!human) throw new Error('no DefaultBodyPartData');
    expect(human.editorId).toBe('DefaultBodyPartData');
    const parts = parse(human);
    expect(headNode(parts)).toBe('NPC Head [Head]');
    const head = parts.find((part) => part.type === BodyPartType.head);
    expect(head?.target).toBe('NPC Head [Head]');
    expect(head?.goreNode).toBe('Camera3rd [Cam3]');
    expect(head?.severed.decalCount).toBe(4);
    expect(head?.severed.impactData).not.toBe(0);
  });

  it('gives the playable races their decapitation armor and blood', async () => {
    const nord = await db.get(NORD_RACE);
    if (!nord) throw new Error('no NordRace');
    const race = parseRace(nord);
    expect(race.decapitateArmors).toEqual([DECAPITATED_HEAD, DECAPITATED_HEAD]);
    const blood = race.dismemberBlood === undefined ? undefined : await db.get(race.dismemberBlood);
    expect(blood?.editorId).toBe(BLOOD_SPRAY_DECAP);
    expect(blood?.fields.zstring('MODL')).toBe('Effects\\BloodSprayDecap01.nif');
    // Creatures have none: their Decapitate does nothing.
    const wolf = (await Promise.all(db.formIdsOfType('RACE').map((id) => db.get(id)))).find(
      (record) => record?.editorId === 'WolfRace',
    );
    expect(wolf && parseRace(wolf).decapitateArmors).toEqual([undefined, undefined]);
  });

  it('puts a stump on the neck the body keeps and a cut under the head the piece shows', async () => {
    const resolver = new ActorResolver(db);
    const look = await resolver.resolve(0x7, 0x14, 1, {
      race: NORD_RACE,
      female: false,
      outfit: null,
      equipped: [DECAPITATED_HEAD],
    });
    const worn = look?.worn.filter((addon) => addon.armor === DECAPITATED_HEAD) ?? [];
    expect(worn.map((addon) => addon.editorId).sort()).toEqual([
      'DecapitatedHeadAA',
      'DecapitatedNeckAA',
    ]);
    for (const addon of worn) {
      const path = meshPath(addon.model.path);
      const skins = await partitions(path);
      expect(skins.length).toBeGreaterThan(0);
      for (const skin of skins) {
        // Both hang on the head bone (they go where the head goes, and the stump with the neck).
        expect(skin.bones).toContain('NPC Head [Head]');
        // The neck's stump (51) stays on the body; the head's cut (150) shows on the piece.
        if (addon.editorId === 'DecapitatedNeckAA') {
          expect(skin.parts.every((part) => part < 100 && !pieceShowsPartition(part))).toBe(true);
        } else {
          expect(skin.parts.every((part) => pieceShowsPartition(part))).toBe(true);
        }
      }
    }
    // The head itself: its head and ears go with the piece, its neck (230) nowhere.
    const head = await partitions('meshes\\actors\\character\\character assets\\malehead.nif');
    expect(head[0]?.parts.filter(faceKeepsPartition).sort()).toEqual([130, 143]);
    expect(head[0]?.parts).toContain(230);
  });

  it('raises Decapitate in the chop and 2_Decapitate in the decapitating killmoves, before the kill', async () => {
    const triggers = async (path: string): Promise<Map<string, Map<string, number>>> => {
      const graph = parseBehaviorGraph(Packfile.parse(await vfs.read(path)));
      const found = new Map<string, Map<string, number>>();
      const seen = new Set<object>();
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        const generator = node as BehaviorGenerator;
        if ('kind' in generator && generator.kind === 'clip') {
          for (const trigger of generator.triggers ?? []) {
            const name = graph.events[trigger.event.id] ?? '';
            let clip = found.get(generator.name);
            if (!clip) found.set(generator.name, (clip = new Map<string, number>()));
            clip.set(name, trigger.localTime);
          }
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) for (const item of value) walk(item);
          else walk(value);
        }
      };
      walk(graph.root);
      return found;
    };
    // The executionee's chop: Decapitate (8.16 s before its end) before KillActor (3.39 s).
    const chop = (await triggers('meshes\\actors\\character\\behaviors\\mt_behavior.hkx')).get(
      'AOExecutioneeChop.hkx',
    );
    expect(chop?.get('Decapitate')).toBeCloseTo(-8.16, 2);
    expect(chop?.get('KillActor')).toBeCloseTo(-3.39, 2);
    // The one-handed killmoves: seven decapitations, each before its kill.
    const oneHanded = await triggers('meshes\\actors\\character\\behaviors\\1hm_behavior.hkx');
    const decapitating = [...oneHanded].filter(([, events]) => events.has('2_Decapitate'));
    expect(decapitating.length).toBe(7);
    for (const [, events] of decapitating) {
      expect(events.get('2_Decapitate')).toBeLessThanOrEqual(events.get('2_KillActor') ?? -1);
    }
  });
});
