// What the human graph does with each weapon in the hands (docs/animation.md, "Weapons in the
// hands"): for every hand setup, the hand variables as the engine sets them (iRightHandType,
// iLeftHandType; iRightHandEquipped, iLeftHandEquipped once the weapon is in the hand), then a
// draw, an attack and a block, each with the states and clips the graph plays and how far the
// hand nodes are from the hands. With --aim, a bow drawn at targets around the character: the
// nocked arrow (the WEAPON bone's forward) against the aim, and the bow (on SHIELD) upright.
//
//   node tools/weapon-poses.ts                every setup, as an NPC
//   node tools/weapon-poses.ts --player       as the player (IsNPC 0, IsPlayer 1; Pitch twists)
//   node tools/weapon-poses.ts bow --aim      one setup (name part), and the bow's aim

import { ActorPose, ActorSkeleton, buildRig } from '../src/animation/skeleton.ts';
import { BehaviorRuntime, type BehaviorHost } from '../src/animation/behavior-runtime.ts';
import {
  readAnimationContainer,
  type AnimationBinding,
  type HkxSkeleton,
} from '../src/formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  projectRelative,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { EquippedItemType as T } from '../src/gameplay/equipment.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const PROJECT = 'meshes\\actors\\character\\defaultmale.hkx';
const SKELETON = 'meshes\\actors\\character\\character assets\\skeleton.nif';
const STEP = 1 / 30;

interface Setup {
  readonly name: string;
  readonly right: number;
  readonly left: number;
  /** The draw's and the attack's events (the idle tree's for ActionDraw, ActionRightAttack). */
  readonly draw: string;
  readonly attack: string;
  /** The left hand's override event (a shield's or a torch's equip). */
  readonly leftEvent?: string;
}

const SETUPS: readonly Setup[] = [
  {
    name: 'unarmed',
    right: T.handToHand,
    left: T.handToHand,
    draw: 'WeapEquip',
    attack: 'attackStart',
  },
  { name: 'sword', right: T.sword, left: T.handToHand, draw: 'WeapEquip', attack: 'attackStart' },
  { name: 'dagger', right: T.dagger, left: T.handToHand, draw: 'WeapEquip', attack: 'attackStart' },
  { name: 'axe', right: T.axe, left: T.handToHand, draw: 'WeapEquip', attack: 'attackStart' },
  { name: 'mace', right: T.mace, left: T.handToHand, draw: 'WeapEquip', attack: 'attackStart' },
  {
    name: 'greatsword',
    right: T.greatsword,
    left: T.greatsword,
    draw: 'WeapEquip',
    attack: 'attackStart',
  },
  {
    name: 'battleaxe',
    right: T.battleaxe,
    left: T.battleaxe,
    draw: 'WeapEquip',
    attack: 'attackStart',
  },
  { name: 'bow', right: T.bow, left: T.bow, draw: 'WeapEquip', attack: 'bowAttackStart' },
  {
    name: 'crossbow',
    right: T.crossbow,
    left: T.crossbow,
    draw: 'WeapEquip',
    attack: 'crossbowAttackStart',
  },
  {
    name: 'staff',
    right: T.staff,
    left: T.handToHand,
    draw: 'Magic_Equip',
    attack: 'MRh_SpellAimedStart',
  },
  {
    name: 'sword and shield',
    right: T.sword,
    left: T.shield,
    draw: 'WeapEquip',
    attack: 'attackStart',
    leftEvent: 'ShdEquip',
  },
  {
    name: 'sword and torch',
    right: T.sword,
    left: T.torch,
    draw: 'WeapEquip',
    attack: 'attackStart',
    leftEvent: 'torchEquip',
  },
  {
    name: 'spell',
    right: T.spell,
    left: T.handToHand,
    draw: 'Magic_Equip',
    attack: 'MRh_SpellAimedStart',
  },
  {
    name: 'spell in both',
    right: T.spell,
    left: T.spell,
    draw: 'Magic_Equip',
    attack: 'MRh_SpellAimedStart',
  },
  {
    name: 'sword and spell',
    right: T.sword,
    left: T.spell,
    draw: 'WeapEquip',
    attack: 'attackStart',
  },
  { name: 'two swords', right: T.sword, left: T.sword, draw: 'WeapEquip', attack: 'attackStart' },
  {
    name: 'sword and staff',
    right: T.sword,
    left: T.staff,
    draw: 'WeapEquip',
    attack: 'attackStart',
  },
];

const args = process.argv.slice(2);
const player = args.includes('--player');
const filter = args.find((arg) => !arg.startsWith('--'));
const vfs = await Vfs.mount(openGameFolder());
const read = (path: string): Promise<Uint8Array> => vfs.read(path);
const character = await loadCharacterInfo(PROJECT, read);
if (!character.behavior || !character.rig) throw new Error('character without behavior or rig');
const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
if (!skeleton) throw new Error('no skeleton');
const havok: HkxSkeleton = skeleton;
const { root, files } = await loadBehaviorFiles(PROJECT, character.behavior, read);
const rig = buildRig(parseNif(await read(SKELETON)));
const clips = new Map<string, AnimationBinding | undefined>();
const pending: Promise<void>[] = [];
const host: BehaviorHost = {
  clip: (animation) => {
    const path = projectRelative(PROJECT, animation);
    if (!clips.has(path)) {
      clips.set(path, undefined);
      pending.push(
        read(path)
          .then((bytes) => {
            clips.set(path, readAnimationContainer(Packfile.parse(bytes)).bindings[0]);
          })
          .catch(() => undefined),
      );
    }
    return clips.get(path);
  },
  behavior: (name) => files.get(projectRelative(PROJECT, name)),
};

/** A graph for one setup, as the engine starts an actor's (third person). */
function start(setup: Setup): { runtime: BehaviorRuntime; pose: ActorPose } {
  const npc = player ? 0 : 1;
  const runtime = new BehaviorRuntime({
    root,
    host,
    skeleton: havok,
    random: () => 0.5,
    properties: { IsNPC: npc, IsPlayer: 1 - npc },
    ...(character.footIk && { footIk: character.footIk }),
  });
  runtime.world = {
    worldFromModel: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    ground: () => undefined,
  };
  const variables: Record<string, number> = {
    IsNPC: npc,
    IsPlayer: 1 - npc,
    iIsPlayer: 1 - npc,
    i1stPerson: 0,
    iRightHandType: setup.right,
    iLeftHandType: setup.left,
    weaponSpeedMult: 1,
    leftWeaponSpeedMult: 1,
  };
  for (const [name, value] of Object.entries(variables)) runtime.setVariable(name, value);
  return { runtime, pose: new ActorPose(new ActorSkeleton(rig, havok)) };
}

async function run(runtime: BehaviorRuntime, seconds: number): Promise<void> {
  for (let time = 0; time < seconds; time += STEP) {
    runtime.update(STEP);
    await Promise.all(pending.splice(0));
    runtime.takeRaised();
  }
}

/** A node's model-space place and its forward (y) and up (z) axes. */
function axes(pose: ActorPose, name: string): { at: number[]; forward: number[]; up: number[] } {
  const m = pose.world(name);
  if (!m) throw new Error(`no node ${name}`);
  return {
    at: [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0],
    forward: [m[4] ?? 0, m[5] ?? 0, m[6] ?? 0],
    up: [m[8] ?? 0, m[9] ?? 0, m[10] ?? 0],
  };
}

const distance = (a: number[], b: number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

function report(label: string, runtime: BehaviorRuntime, pose: ActorPose): void {
  pose.update(runtime.pose);
  const states = runtime
    .states()
    .map((entry) => entry.state)
    .slice(2, 9)
    .join(' > ');
  const playing = runtime
    .playing()
    .map((entry) => entry.animation.replace(/^Animations\\/i, ''))
    .join(', ');
  const weapon = distance(axes(pose, 'WEAPON').at, axes(pose, 'NPC R Hand [RHnd]').at);
  const shield = distance(axes(pose, 'SHIELD').at, axes(pose, 'NPC L Hand [LHnd]').at);
  console.log(`  ${label}: ${states}`);
  console.log(
    `    plays ${playing}; WEAPON ${weapon.toFixed(0)} from the right hand, SHIELD ${shield.toFixed(0)} from the left`,
  );
}

for (const setup of SETUPS) {
  if (filter && !setup.name.includes(filter)) continue;
  console.log(
    `${setup.name} (iRightHandType ${String(setup.right)}, iLeftHandType ${String(setup.left)})`,
  );
  const { runtime, pose } = start(setup);
  await run(runtime, 0.2);
  if (setup.leftEvent) runtime.sendEvent(setup.leftEvent);
  runtime.sendEvent(setup.draw);
  await run(runtime, 0.7);
  // The engine's weaponDraw handler: the hands' codes while the weapons are out.
  runtime.setVariable('iRightHandEquipped', setup.right);
  runtime.setVariable('iLeftHandEquipped', setup.left);
  await run(runtime, 1.2);
  report('drawn', runtime, pose);
  runtime.sendEvent(setup.attack);
  await run(runtime, 0.5);
  report('attack', runtime, pose);
  await run(runtime, 2);
  runtime.setVariable('iWantBlock', 1);
  runtime.sendEvent('blockStart');
  await run(runtime, 0.8);
  report('block', runtime, pose);

  if (args.includes('--aim') && setup.right === T.bow) {
    // At full draw, aimed at points around the character (it stands at the origin facing +y).
    for (const target of [
      [0, 2000, 120],
      [0, 2000, 900],
      [0, 2000, -600],
      [1000, 1700, 120],
    ] as const) {
      const drawn = start(setup);
      drawn.runtime.setDirectAtTarget(2, target);
      drawn.runtime.setVariable('Pitch', player ? 20 : 0);
      drawn.runtime.sendEvent('WeapEquip');
      await run(drawn.runtime, 1.7);
      drawn.runtime.sendEvent('bowAttackStart');
      await run(drawn.runtime, 1.7);
      drawn.pose.update(drawn.runtime.pose);
      const arrow = axes(drawn.pose, 'WEAPON');
      const bow = axes(drawn.pose, 'SHIELD');
      const way = target.map((v, i) => v - (arrow.at[i] ?? 0));
      const length = Math.hypot(...way);
      const dot = way.reduce((sum, v, i) => sum + v * (arrow.forward[i] ?? 0), 0);
      const angle = (Math.acos(Math.min(1, dot / length)) * 180) / Math.PI;
      // The bow model's long axis is its y: upright when SHIELD's y points up. The player's
      // arrow follows Pitch (20° here), not the aim.
      const upright = bow.forward[2]?.toFixed(2) ?? '?';
      const pitch = (Math.asin(arrow.forward[2] ?? 0) * 180) / Math.PI;
      console.log(
        player
          ? `  Pitch 20: the arrow pitched ${pitch.toFixed(1)}°; the bow upright ${upright}`
          : `  aim at ${target.join(',')}: the arrow ${angle.toFixed(1)}° off it; the bow upright ${upright}`,
      );
    }
  }
}
await vfs.close();
