// Integration test: the player's body and the keep's doors in Helgen Keep on the headless
// simulation (MQ101, Ralof's route as the player walks in). Two playtest reports from the keep
// that the simulation does not show: the Imperial armor found there drawn in its bind pose, and
// the player walking through shut doors. These cases hold what was measured. Skipped without
// game data.

import { describe, expect, it } from 'vitest';
import { HAVOK_SCALE } from '../src/physics/collision-data.ts';
import { thinModelPath } from '../src/render/actor-model.ts';
import {
  PALETTE_BONE_FLOATS,
  skinPositions,
  writePaletteBone,
  writeRestPalette,
} from '../src/render/bone-palette.ts';
import { meshPath } from '../src/world/actors.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const MQ101 = 0x3372b;
/** HelgenKeep01. */
const KEEP = 0x5de24;
/**
 * The keep's doors on the routes (non-load): the wooden doors of the barracks and the storeroom
 * (ImpDoorSingle01), the jail doors (ImpJailDoor01, ImpJailDoor02) and the torture room's cage
 * doors (MetalCageDoor01).
 */
const KEEP_DOORS = [0x938f3, 0x938f2, 0x938f9, 0x9b0a5, 0xb167f, 0xb1680, 0xb1681, 0x9158f];
/** What the keep's chests and soldiers give: the Imperial light set and gauntlets. */
const IMPERIAL_ARMOR = [
  'ArmorImperialLightCuirass',
  'ArmorImperialLightBoots',
  'ArmorImperialLightHelmet',
  'ArmorImperialGauntlets',
];

/** A new game in the keep as the player walks in with Ralof (MQ101 220), its scenes stopped. */
async function inTheKeep(): Promise<Sim> {
  const sim = await openSim({ opening: true });
  await sim.step(1);
  for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
  void sim.runtime.quests.setStage(MQ101, 220);
  await sim.step(0.5);
  await sim.openInterior(KEEP);
  for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
  await sim.step(1);
  const controls = sim.runtime.controls;
  controls.movement = controls.fighting = controls.looking = controls.activate = true;
  return sim;
}

/** A door's leaf: the middle of its keyframed body's shapes (feet height) and its normal. */
function leaf(sim: Sim, door: number): { mid: Vec3; normal: [number, number] } | undefined {
  const body = sim.world.play
    ?.placementsOf(door)[0]
    ?.bodies.find((placed) => placed.data.motion === 'keyframed');
  if (!body) return undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const shape of body.data.shapes) {
    const points =
      shape.type === 'convex' ? shape.points : shape.type === 'mesh' ? shape.vertices : undefined;
    for (let i = 0; points && i + 2 < points.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] ?? 0, points[i + k] ?? 0);
        max[k] = Math.max(max[k] ?? 0, points[i + k] ?? 0);
      }
    }
  }
  const t = body.body.translation();
  const q = body.body.rotation();
  const angle = 2 * Math.atan2(q.z, q.w);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const lx = ((min[0] ?? 0) + (max[0] ?? 0)) / 2;
  const ly = ((min[1] ?? 0) + (max[1] ?? 0)) / 2;
  // The leaf is thin across its y (these models' doors).
  return {
    mid: [
      t.x * HAVOK_SCALE + lx * c - ly * s,
      t.y * HAVOK_SCALE + lx * s + ly * c,
      t.z * HAVOK_SCALE + (min[2] ?? 0) + 15,
    ],
    normal: [-s, c],
  };
}

/** How far past a door's leaf the player got walking into it from each side (negative: through). */
async function walkInto(sim: Sim, door: number): Promise<number[]> {
  const found = leaf(sim, door);
  if (!found) return [];
  const { mid, normal } = found;
  const [nx, ny] = normal;
  const reached: number[] = [];
  for (const side of [1, -1]) {
    await sim.moveTo([mid[0] + nx * 70 * side, mid[1] + ny * 70 * side, mid[2]]);
    await sim.step(0.1);
    await sim.walkTo([mid[0] - nx * 100 * side, mid[1] - ny * 100 * side, mid[2]], 2, 15);
    const [x, y] = sim.world.player.feet;
    reached.push(((x - mid[0]) * nx + (y - mid[1]) * ny) * side);
  }
  return reached;
}

describe.skipIf(!hasGamedata())('the player in Helgen Keep', () => {
  // Reported 2026-11-01: walking through the keep's doors. Shut, each door's keyframed leaf
  // stops the player from both sides, and one shut on the player pushes them out of its way.
  it('is stopped by the keep’s shut doors, and pushed out by one shutting on them', async () => {
    const sim = await inTheKeep();
    try {
      for (const door of KEEP_DOORS) {
        sim.runtime.setOpen(door, false);
        await sim.step(3);
        for (const reached of await walkInto(sim, door))
          expect(reached, door.toString(16)).toBeGreaterThan(10);
        // Standing where the shut leaf goes, the door shuts on the player.
        const closed = leaf(sim, door);
        expect(closed).toBeDefined();
        sim.runtime.setOpen(door, true);
        await sim.step(3);
        if (closed) await sim.moveTo(closed.mid);
        await sim.step(0.5);
        sim.runtime.setOpen(door, false);
        await sim.step(3);
        for (const reached of await walkInto(sim, door))
          expect(reached, door.toString(16)).toBeGreaterThan(10);
      }
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Reported again 2026-11-04 (doors that open and close vaguely, walked through). A leaf swings
  // without a jump and ends where its sequence ends, and neither a door shutting on the player
  // in its way nor one opened and shut again as they walk at it lets them through a shut leaf.
  it('walks into doors as they swing, and only through while they stand open', async () => {
    const sim = await inTheKeep();
    try {
      for (const door of [0x938f3, 0x9b0a5]) {
        const body = sim.world.play
          ?.placementsOf(door)[0]
          ?.bodies.find((placed) => placed.data.motion === 'keyframed')?.body;
        const closed = leaf(sim, door);
        if (!body || !closed) throw new Error('no leaf');
        const [nx, ny] = closed.normal;
        const at = (d: number): Vec3 => [
          closed.mid[0] + nx * d,
          closed.mid[1] + ny * d,
          closed.mid[2],
        ];
        const side = (): number => {
          const [x, y] = sim.world.player.feet;
          return (x - closed.mid[0]) * nx + (y - closed.mid[1]) * ny;
        };
        const yaw = (): number => {
          const q = body.rotation();
          return (2 * Math.atan2(q.z, q.w) * 180) / Math.PI;
        };
        // How far apart two yaws are, across the wrap at ±180.
        const turned = (a: number, b: number): number => {
          const apart = Math.abs(a - b) % 360;
          return Math.min(apart, 360 - apart);
        };
        // The swing: small steps of the leaf, never a jump, to a wide open door and back.
        const shut = yaw();
        for (const open of [true, false]) {
          sim.runtime.setOpen(door, open);
          let last = yaw();
          let swing = 0;
          for (let i = 0; i < 90; i++) {
            await sim.step(1 / 60);
            const now = yaw();
            swing = Math.max(swing, turned(now, last));
            last = now;
          }
          expect(swing, door.toString(16)).toBeLessThan(15);
          if (open) expect(turned(last, shut)).toBeGreaterThan(60);
          else expect(turned(last, shut)).toBeLessThan(0.5);
        }
        // It shuts on the player: out of its way, and the shut leaf holds them on that side.
        for (const off of [-20, 0, 20]) {
          sim.runtime.setOpen(door, true);
          await sim.step(1.5);
          await sim.moveTo(at(off));
          await sim.step(0.2);
          sim.runtime.setOpen(door, false);
          await sim.step(1.5);
          const after = side();
          expect(Math.abs(after), door.toString(16)).toBeGreaterThan(10);
          const dir = after >= 0 ? -1 : 1;
          await sim.walkTo(at(dir * 120), 1.5, 10);
          expect(side() * dir, door.toString(16)).toBeLessThan(-10);
        }
        // Walked at from each side, opened for a moment and shut before they reach it.
        for (const from of [1, -1]) {
          await sim.moveTo(at(from * 100));
          await sim.step(0.1);
          sim.look(at(-from * 100));
          sim.press('Forward', true);
          for (let i = 0; i < 180 && side() * from > 45; i++) await sim.step(1 / 60);
          sim.runtime.setOpen(door, true);
          await sim.step(0.1);
          sim.runtime.setOpen(door, false);
          await sim.step(1.5);
          sim.press('Forward', false);
          expect(side() * from, door.toString(16)).toBeGreaterThan(10);
        }
      }
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Reported 2026-11-04: floating after a jump on stairs. With the jump key, up and down the
  // keep's stairs (MQ101's way to the storeroom) and standing on them: the controller lands, on
  // the ground, at rest, its graph out of its jump. What is left between its feet and the tread
  // under its middle (up to a tread's edge under its lower cone, as the shape stands anywhere on
  // stairs) is no more after a jump than before it.
  it('lands from a jump on the stairs, at rest and on the ground', async () => {
    const sim = await inTheKeep();
    try {
      const character = sim.world.player.character;
      const graph = sim.world.playerView?.avatar?.body.behavior;
      const spots: readonly (readonly [Vec3, number])[] = [
        [[-547, 4148, 382], 1.86],
        [[-405, 4115, 308], 1.81],
        [[-345, 4101, 268], 1.81],
      ];
      for (const [spot, along] of spots) {
        for (const mode of ['still', 'down', 'up']) {
          await sim.moveTo([spot[0], spot[1], spot[2] + 2]);
          await sim.step(0.5);
          const before = character.feet[2];
          sim.world.look(mode === 'up' ? along + Math.PI : along);
          if (mode !== 'still') sim.press('Forward', true);
          await sim.step(0.2);
          const leaving = character.feet[2];
          sim.press('Jump', true);
          await sim.step(1 / 60);
          sim.press('Jump', false);
          let top = character.feet[2];
          for (let i = 0; i < 40; i++) {
            await sim.step(1 / 60);
            top = Math.max(top, character.feet[2]);
          }
          sim.press('Forward', false);
          expect(top - leaving, `${mode} at ${String(spot[0])}`).toBeGreaterThan(30);
          await sim.step(2);
          const rest = character.feet[2];
          await sim.step(0.5);
          expect(character.grounded, `${mode} at ${spot[0]}`).toBe(true);
          expect(character.verticalSpeed).toBe(0);
          expect(Math.abs(character.feet[2] - rest)).toBeLessThan(0.5);
          const jumping = graph?.states().filter(({ state }) => /jump|fall/i.test(state)) ?? [];
          expect(jumping).toEqual([]);
          if (mode === 'still') expect(Math.abs(rest - before)).toBeLessThan(1);
        }
      }
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Reported 2026-11-01: the keep's Imperial armor drawn in its bind pose (arms out, the helmet
  // turned). Put on in first person and seen in third, every bone of every piece is the body's
  // skeleton's, and its vertices go where that pose puts them, away from the bind pose.
  it('skins the Imperial armor put on in first person to the body’s skeleton', async () => {
    const sim = await inTheKeep();
    try {
      const player = sim.world.player;
      player.setPov('first');
      await sim.step(0.5);
      for (const name of IMPERIAL_ARMOR) {
        const form = await sim.formId('ARMO', name);
        await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(form), 1, true);
        await sim.equip(form);
        await sim.step(0.5);
      }
      player.setPov('third');
      await sim.step(1);
      const body = sim.world.playerView?.avatar?.body;
      expect(body).toBeDefined();
      if (!body) return;
      const session = sim.world.session;
      const pose = body.pose;
      const worn = body.look.worn.filter((addon) => !addon.skin);
      expect(worn.length).toBeGreaterThanOrEqual(IMPERIAL_ARMOR.length);
      for (const addon of worn) {
        const path = meshPath(addon.model.path);
        const thin = addon.weighted ? thinModelPath(path) : undefined;
        const { model } = await session.loader.loadActorPart(
          path,
          thin !== undefined && session.vfs.has(thin) ? thin : undefined,
          Math.round(body.look.weight),
          {},
        );
        for (const part of model.parts) {
          const skin = part.skin;
          const skinning = part.layout.skinning;
          if (!skin || skinning === undefined) continue;
          const posed = new Float32Array(skin.bones.length * PALETTE_BONE_FLOATS);
          const rest = new Float32Array(skin.bones.length * PALETTE_BONE_FLOATS);
          writeRestPalette(skin, rest);
          skin.names.forEach((name, i) => {
            const node = pose.skeleton.nodeByName.get(name.toLowerCase());
            expect(node, `${path} ${part.name}: ${name}`).toBeDefined();
            if (node !== undefined) {
              writePaletteBone(posed, i * 12, pose.worlds, node * 16, skin.bind, i * 16);
            }
          });
          const at = (palette: Float32Array): Float32Array =>
            skinPositions(part.vertices, part.layout.stride, skinning, part.vertexCount, palette);
          const a = at(posed);
          const b = at(rest);
          let moved = 0;
          for (let v = 0; v < part.vertexCount; v++) {
            moved += Math.hypot(
              (a[v * 3] ?? 0) - (b[v * 3] ?? 0),
              (a[v * 3 + 1] ?? 0) - (b[v * 3 + 1] ?? 0),
              (a[v * 3 + 2] ?? 0) - (b[v * 3 + 2] ?? 0),
            );
          }
          // Standing, the arms hang and the head sits on the neck: units off the bind pose.
          expect(moved / part.vertexCount, `${path} ${part.name}`).toBeGreaterThan(2);
        }
      }
    } finally {
      await sim.close();
    }
  }, 600_000);
});
