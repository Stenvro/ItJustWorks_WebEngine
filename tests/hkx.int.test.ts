// Integration test: the behavior graphs of placed objects on the local game data, and what
// they play. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectGraph } from '../src/animation/object-graph.ts';
import { graphStart, loadBehaviorGraph } from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { behaviorGraphPath, buildSequences } from '../src/render/animation.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('behavior graphs on the local game data', () => {
  let vfs: Vfs;
  const read = (path: string): Promise<Uint8Array> => vfs.read(path);
  /** A mesh's sequences and its running graph, started at `now`. */
  const run = async (mesh: string, now: number): Promise<ObjectGraph> => {
    const nif = parseNif(await vfs.read(mesh));
    const project = behaviorGraphPath(nif);
    if (!project) throw new Error(`${mesh} has no behavior graph`);
    const sequences = buildSequences(nif, true);
    return new ObjectGraph(
      await loadBehaviorGraph(project, read),
      sequences?.byName ?? new Map(),
      now,
    );
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('reads the generic graph that toggles fires: it starts unlit', async () => {
    const mesh = 'meshes\\effects\\fxfirewithembersheavytoggle.nif';
    const project = behaviorGraphPath(parseNif(await vfs.read(mesh)));
    expect(project).toBe(
      'meshes\\genericbehaviors\\blendbetweenstatesvariable\\blendbetweenstatesvariable.hkx',
    );
    const graph = await loadBehaviorGraph(project ?? '', read);
    expect(graph.variables.map((variable) => variable.name)).toEqual([
      'fToggleBlend',
      'fToggleBlendDampened',
      'fDampRate',
    ]);
    expect(graph.variables[2]?.initial).toBeCloseTo(0.03, 5);
    // partA (lit) by the damped blend variable (0), partB (unlit) by one minus it.
    expect(graphStart(graph).sequences).toEqual([
      { sequence: 'parta', weight: 0 },
      { sequence: 'partb', weight: 1 },
    ]);
    expect((await run(mesh, 0)).playing.map((playing) => playing.sequence)).toEqual(['partb']);
  });

  it("plays a camera effect's intro, then its loop from the moment the intro ends", async () => {
    const graph = await run('meshes\\effects\\fxcameraattachfog.nif', 100);
    expect(graph.playing.map((playing) => playing.sequence)).toEqual(['autoplay']);
    graph.update(105);
    expect(graph.playing.map((playing) => playing.sequence)).toEqual(['autoloop']);
    expect(graph.playing[0]?.start).toBeGreaterThan(100);
    expect(graph.playing[0]?.start).toBeLessThan(105);
  });

  it('plays the shader loop beside the idle of the Eye of Magnus barriers and word walls', async () => {
    const barrier = await run('meshes\\clutter\\eyeofmagnus\\mgeyebarriersmalltall.nif', 0);
    expect(barrier.playing.map((playing) => playing.sequence)).toEqual([
      'shaderloopidle',
      'animidle01',
    ]);
    const wall = await run('meshes\\dungeons\\nordic\\chambers\\powerwordfus.nif', 0);
    expect(wall.playing.map((playing) => playing.sequence)).toEqual(['waiting', 'uvanim']);
  });

  it('reads every behavior graph that a vanilla mesh names (bows share theirs via ..)', async () => {
    const graph = await loadBehaviorGraph('meshes\\weapons\\iron\\ironbow.hkx', read);
    expect(graph.root?.kind).toBe('state-machine');
    for (const project of [
      'meshes\\genericbehaviors\\autoplay.hkx',
      'meshes\\genericbehaviors\\idletransidlebackml.hkx',
      'meshes\\traps\\beartrap\\beartrap01.hkx',
      'meshes\\dungeons\\nordic\\chambers\\norrunicamphitheatrewordtiid.hkx',
    ]) {
      const loaded = await loadBehaviorGraph(project, read);
      expect(loaded.root, project).toBeDefined();
    }
  });

  it('rejects the tagfiles that Creation Club behaviors ship', async () => {
    const tagfile = await vfs.read(
      'meshes\\_resourcepack\\genericbehaviors\\stagescycle\\stagescycle.hkt',
    );
    expect(() => Packfile.parse(tagfile)).toThrow(/tagfile/);
  });
});
