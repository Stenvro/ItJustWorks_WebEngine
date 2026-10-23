// Integration test: what held weapons bring along in their models, on the local game data: a
// bow's own graph drawing its string as its wielder's graph events reach it (WeaponGraph), and
// a sword's hidden blood shapes (ModelPart.weaponBlood). Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphEvent } from '../src/animation/graph-events.ts';
import type { BehaviorHost } from '../src/animation/behavior-runtime.ts';
import { WeaponGraph } from '../src/animation/weapon-graph.ts';
import { readAnimationContainer, type AnimationBinding } from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { behaviorGraphPath } from '../src/render/animation.ts';
import { identity } from '../src/render/math.ts';
import { buildModel } from '../src/render/model-data.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

/** SLSF2 Weapon_Blood. */
const WEAPON_BLOOD = 0x20000;

describe.skipIf(!hasGamedata())('held weapons on the local game data', () => {
  let vfs: Vfs;
  const read = (path: string): Promise<Uint8Array> => vfs.read(path);
  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it("draws the iron bow's string at BowDraw and bowDrawStart and lets go at BowRelease", async () => {
    const nif = parseNif(await read('meshes\\weapons\\iron\\ironbow.nif'));
    const project = behaviorGraphPath(nif);
    expect(project).toBe('meshes\\weapons\\iron\\ironbow.hkx');
    const nodes = buildModel(nif).nodes ?? [];
    const string = nodes.findIndex((node) => node.name === 'Bow_StringBone1');
    expect(string).toBeGreaterThan(0);
    if (!project) return;
    const character = await loadCharacterInfo(project, read);
    if (!character.behavior || !character.rig) throw new Error('no character');
    const havok = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
    if (!havok) throw new Error('no skeleton');
    const { root, files } = await loadBehaviorFiles(project, character.behavior, read);
    const clips = new Map<string, AnimationBinding | undefined>();
    const pending: Promise<void>[] = [];
    const host: BehaviorHost = {
      clip: (animation) => {
        const path = projectRelative(project, animation);
        if (!clips.has(path)) {
          clips.set(path, undefined);
          pending.push(
            read(path).then((bytes) => {
              clips.set(path, readAnimationContainer(Packfile.parse(bytes)).bindings[0]);
            }),
          );
        }
        return clips.get(path);
      },
      behavior: (name) => files.get(projectRelative(project, name)),
    };
    const placed = Int16Array.from(nodes, (_, i) => i);
    const bow = WeaponGraph.start(nodes, { root, havok, host }, () => 0.5, placed);
    if (!bow) throw new Error('the bow graph moves nothing');
    const driven = new Map<number, Float32Array>();
    const run = async (seconds: number): Promise<void> => {
      for (let t = 0; t < seconds; t += 1 / 30) {
        bow.update(1 / 30, identity(), driven);
        await Promise.all(pending.splice(0));
      }
    };
    const stringAt = (): [number, number, number] => {
      const world = driven.get(string);
      return [world?.[12] ?? 0, world?.[13] ?? 0, world?.[14] ?? 0];
    };
    await run(0.5);
    const rest = stringAt();
    expect(bow.states().map((s) => s.state)).toContain('Idle');
    // The wielder's graph: weaponSpeedMult as the engine sets it, then the draw's events.
    bow.setVariable('weaponSpeedMult', 1);
    bow.hear([graphEvent('BowDraw'), graphEvent('SoundPlay.WPNBowNockSD')]);
    await run(0.3);
    bow.hear([graphEvent('bowDrawStart')]);
    await run(1.5);
    expect(bow.states().map((s) => s.state)).toContain('IdleDrawn');
    const drawn = stringAt();
    const pulled = Math.hypot(drawn[0] - rest[0], drawn[1] - rest[1], drawn[2] - rest[2]);
    expect(pulled).toBeGreaterThan(5);
    bow.hear([graphEvent('BowRelease'), graphEvent('arrowRelease')]);
    await run(1.5);
    expect(bow.states().map((s) => s.state)).toContain('Idle');
    const after = stringAt();
    const back = Math.hypot(after[0] - rest[0], after[1] - rest[1], after[2] - rest[2]);
    expect(back).toBeLessThan(pulled / 4);
  });

  it("keeps a sword's hidden blood shapes: a Weapon_Blood effect over a sheen", async () => {
    const model = buildModel(parseNif(await read('meshes\\weapons\\iron\\longsword.nif')));
    const blood = model.parts.filter((part) => part.weaponBlood === true);
    expect(blood.map((part) => part.name).sort()).toEqual(['BloodEffects', 'BloodLighting']);
    const effect = blood.find((part) => part.material?.kind === 'effect');
    expect(effect?.material?.kind === 'effect' && effect.material.sourceTexture).toBe(
      'textures\\blood\\bloodedge01.dds',
    );
    expect((effect?.material?.flags2 ?? 0) & WEAPON_BLOOD).toBe(WEAPON_BLOOD);
    // Multiplied over the blade (src ZERO, dst SRC_COLOR), alpha tested.
    expect(effect?.alpha?.flags).toBe(0x5243);
    const sheen = blood.find((part) => part.material?.kind === 'lighting');
    expect(sheen?.material?.kind === 'lighting' && sheen.material.textures[0]).toBe(
      'textures\\blood\\bloodedge01add.dds',
    );
    // The blade itself is drawn as always.
    expect(model.parts.some((part) => part.name === 'IronLongSword01:0' && !part.weaponBlood)).toBe(
      true,
    );
  });
});
