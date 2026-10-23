// Integration test: killmoves on the local game data (docs/animation.md, "Killmoves"): the
// power attack's idle tree searched as the engine searches it, the victims' events in the
// people's graphs, the paired clips' partner marks, the synchronized clips' members, and the
// kill cameras' order. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  behaviorGraphKey,
  orderSiblings,
  readIdleTree,
  type IdleTree,
} from '../src/ai/idle-records.ts';
import { partnerMark } from '../src/animation/paired-clips.ts';
import { readAnimationContainer } from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  type BehaviorGenerator,
  type BehaviorGraph,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { parseCameraPath, type CameraPathRecord } from '../src/gameplay/combat/combat-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const PEOPLE = 'meshes\\actors\\character\\defaultmale.hkx';
const MASTER = behaviorGraphKey('Actors\\Character\\Behaviors\\0_Master.hkx');

describe.skipIf(!hasGamedata())('killmoves on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let tree: IdleTree;
  let files: ReadonlyMap<string, BehaviorGraph>;
  const read = (path: string): Promise<Uint8Array> => vfs.read(path);

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    tree = await readIdleTree(db);
    const behavior = (await loadCharacterInfo(PEOPLE, read)).behavior;
    if (behavior === undefined) throw new Error('no behavior');
    files = (await loadBehaviorFiles(PEOPLE, behavior, read)).files;
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  /** The idles under one of the power attack's (for the people's graph). */
  const idlesUnder = (editorId: string): { editorId: string; event: string | undefined }[] => {
    const root = [...tree.idles.values()].find((idle) => idle.editorId === editorId);
    if (!root) throw new Error(`no ${editorId}`);
    const found: { editorId: string; event: string | undefined }[] = [];
    const visit = (parent: number): void => {
      for (const idle of tree.children(parent, MASTER)) {
        found.push({ editorId: idle.editorId, event: idle.event });
        visit(idle.formId);
      }
    };
    visit(root.formId);
    return found;
  };

  it("gives every killmove on a person a victim event the people's graphs have", () => {
    const events = new Set<string>();
    for (const graph of files.values())
      for (const event of graph.events) events.add(event.toLowerCase());
    // Those on people (HasKeyword ActorTypeNPC on the target): the creatures' are in their
    // own graphs.
    const killmoves = ['KillMoveShortRoot', 'KillMoveBackSideRoot']
      .flatMap(idlesUnder)
      .filter((idle) => idle.event?.toLowerCase().startsWith('pa_kill'));
    expect(killmoves.length).toBeGreaterThan(40);
    const missing = killmoves
      .map((idle) => idle.event?.slice(3) ?? '')
      .filter((event) => !events.has(event.toLowerCase()));
    expect(missing).toEqual([]);
  });

  it('searches the power attack depth first: a killmove group with nothing under it gives way', () => {
    const action = tree.action('ActionRightPowerAttack');
    if (!action) throw new Error('no ActionRightPowerAttack');
    // Nothing of the killmoves (their groups' conditions hold, none of theirs below), no
    // mount, no sprint, no fists: the standing power attack after them.
    const groups = new Set(['KillMoveFrontSideRoot', 'KillMoveBackSideRoot']);
    const idle = tree.resolve(action.formId, MASTER, (candidate) => {
      if (groups.has(candidate.editorId)) return true;
      return !/kill|^mounted|sprint|h2h|bash|ripheart/i.test(candidate.editorId);
    });
    expect(idle?.event).toBe('attackPowerStartInPlace');
    // A killmove group whose children qualify: its first one.
    const killmove = tree.resolve(action.formId, MASTER, (candidate) =>
      [
        'PowerAttackRoot',
        'NonMountedCombatRightPower',
        'KillMoveFrontSideRoot',
        'KillMoveShortRoot',
      ].includes(candidate.editorId)
        ? true
        : candidate.editorId === 'KillMoveShortBlade' || candidate.editorId === 'KillMoveShortB',
    );
    expect(killmove?.event).toBe('pa_KillMoveShortB');
  });

  it("reads the partners' marks from the paired clips", async () => {
    const mark = async (path: string): Promise<ReturnType<typeof partnerMark>> => {
      const binding = readAnimationContainer(Packfile.parse(await read(path))).bindings[0];
      return binding && partnerMark(binding);
    };
    const human = await mark('meshes\\actors\\character\\animations\\paired_1hmkillmoveb.hkx');
    expect(human?.offset[1]).toBeCloseTo(72.8, 1);
    expect(Math.abs(human?.yaw ?? 0)).toBeCloseTo(Math.PI, 3);
    const bear = await mark(
      'meshes\\actors\\sharedkillmoves\\human&bear\\paired_1hmkillmovebeara.hkx',
    );
    expect(bear?.offset[1]).toBeCloseTo(157, 0);
    const wolf = await mark(
      'meshes\\actors\\sharedkillmoves\\human&wolf\\paired_2hwkillmovewolfa.hkx',
    );
    expect(wolf?.offset[1]).toBeCloseTo(116.6, 0);
  });

  it('parses the synchronized clips: the leaders prefix 2_, killmove partners get to their marks at once', () => {
    const syncs: Extract<BehaviorGenerator, { kind: 'synchronized-clip' }>[] = [];
    const seen = new Set<BehaviorGenerator>();
    const visit = (node: BehaviorGenerator | undefined): void => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.kind === 'synchronized-clip') syncs.push(node);
      if ('generator' in node) visit(node.generator);
      if (node.kind === 'state-machine') for (const state of node.states) visit(state.generator);
      if (node.kind === 'blender') for (const child of node.children) visit(child.generator);
      if (node.kind === 'manual-selector') for (const child of node.generators) visit(child);
    };
    for (const graph of files.values()) visit(graph.root);
    const leaders = syncs.filter((sync) => sync.leadCharacter && sync.syncPrefix === '2_');
    expect(leaders.length).toBeGreaterThan(40);
    const killmoves = syncs.filter(
      (sync) => sync.generator?.kind === 'clip' && /killmove/i.test(sync.generator.animation),
    );
    expect(killmoves.length).toBeGreaterThan(80);
    expect(killmoves.filter((sync) => sync.getToMarkTime > 0.051 || !sync.reorientSupport)).toEqual(
      [],
    );
  });

  it("orders the kill cameras' paths: under PairedKillTest the dragons first, the failsafe last", async () => {
    const paths: CameraPathRecord[] = [];
    for (const formId of db.formIdsOfType('CPTH')) {
      const record = await db.get(formId);
      if (record && !record.deleted) paths.push(parseCameraPath(record));
    }
    const root = paths.find((path) => path.editorId === 'PairedKillTest');
    if (!root) throw new Error('no PairedKillTest');
    const children = orderSiblings(paths.filter((path) => path.parent === root.formId));
    expect(children[0]?.editorId).toBe('DragonCams');
    expect(children.at(-1)?.editorId).toBe('FailSafeCamera');
    expect(children.at(-2)?.editorId).toBe('1stPFailsafeCam');
    const roots = orderSiblings(paths.filter((path) => path.parent === undefined));
    expect(roots.map((path) => path.editorId).slice(0, 2)).toEqual(['PlayerDeath', 'DoVatsAtAll']);
  });
});
