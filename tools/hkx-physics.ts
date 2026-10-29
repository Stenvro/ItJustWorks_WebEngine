// The ragdoll physics of the skeleton files (src/formats/hkx/physics.ts): per file its ragdoll
// (bodies, constraints by kind, shapes by kind), checked for consistency (one body per ragdoll
// bone, every constraint between two of the bodies, no shape or constraint of an unknown
// class), and set beside skeleton.nif's bhk bodies in the same folder (the bodies the original
// simulates, docs/formats/hkx.md, "Ragdoll physics").
//
//   node tools/hkx-physics.ts              every skeleton file with a ragdoll
//   node tools/hkx-physics.ts wolf         the files whose path contains "wolf"
//   node tools/hkx-physics.ts wolf --bodies  each body: name, shape, mass, filter info

import { Packfile } from '../src/formats/hkx/packfile.ts';
import {
  readHavokPhysics,
  type HavokResourceContainer,
  type HavokShape,
} from '../src/formats/hkx/physics.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const filter = (process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '').toLowerCase();
const showBodies = process.argv.includes('--bodies');

const shapeName = (shape: HavokShape | undefined): string => {
  if (!shape) return 'none';
  switch (shape.kind) {
    case 'convex-translate':
    case 'convex-transform':
    case 'mopp':
      return `${shape.kind}(${shapeName(shape.child)})`;
    case 'list':
      return `list(${shape.children.map((child) => shapeName(child.shape)).join(',')})`;
    case 'unknown':
      return `unknown ${shape.className}`;
    default:
      return shape.kind;
  }
};

const resources = (container: HavokResourceContainer | undefined): number =>
  container
    ? container.resources.length +
      container.children.reduce((sum, child) => sum + resources(child), 0)
    : 0;

let files = 0;
let problems = 0;
const totals = { bodies: 0, others: 0, constraints: 0, shapes: new Map<string, number>() };
for (const file of vfs.list('meshes').filter((path) => path.endsWith('.hkx'))) {
  if (!file.includes('skeleton') || !file.includes(filter)) continue;
  const pack = Packfile.parse(await vfs.read(file));
  if (pack.objectsOf('hkaRagdollInstance').length === 0) continue;
  files++;
  const physics = readHavokPhysics(pack);
  const ragdoll = physics.ragdoll;
  const issues: string[] = [];
  if (!ragdoll) {
    issues.push('no ragdoll read');
  } else {
    const bones = ragdoll.skeleton?.bones.length ?? -1;
    if (bones !== ragdoll.rigidBodies.length) {
      issues.push(`${String(bones)} ragdoll bones, ${String(ragdoll.rigidBodies.length)} bodies`);
    }
    if (ragdoll.boneToRigidBodyMap.some((body) => body >= ragdoll.rigidBodies.length)) {
      issues.push('a bone maps past the bodies');
    }
    for (const constraint of ragdoll.constraints) {
      if (constraint.bodyA < 0 || constraint.bodyB < 0)
        issues.push(`${constraint.name}: a body outside`);
      if (constraint.data.kind === 'unknown')
        issues.push(`${constraint.name}: ${constraint.data.className}`);
    }
    for (const body of ragdoll.rigidBodies) {
      const name = shapeName(body.shape);
      if (name.includes('unknown') || name === 'none') issues.push(`${body.name}: shape ${name}`);
      totals.shapes.set(name, (totals.shapes.get(name) ?? 0) + 1);
    }
    // The physics system holds the ragdoll's bodies and the rest of the scene (the character
    // bumper, attachments): their shapes are read too.
    for (const system of physics.systems) {
      for (const body of system.rigidBodies) {
        if (ragdoll.rigidBodies.some((other) => other.name === body.name)) continue;
        const name = shapeName(body.shape);
        if (name.includes('unknown') || name === 'none') issues.push(`${body.name}: shape ${name}`);
        totals.shapes.set(name, (totals.shapes.get(name) ?? 0) + 1);
        totals.others++;
      }
    }
    totals.bodies += ragdoll.rigidBodies.length;
    totals.constraints += ragdoll.constraints.length;
  }
  // The same bodies in skeleton.nif: names of its bhkRigidBody(T) blocks' nodes are not kept by
  // the NIF reader, so their count is compared.
  const nifPath = file.replace(/[^\\/]+$/, 'skeleton.nif');
  let nifBodies = -1;
  if (vfs.has(nifPath)) {
    const nif = parseNif(await vfs.read(nifPath));
    nifBodies = nif.blockTypes.filter((type) => type.startsWith('bhkRigidBody')).length;
  }
  const kinds = new Map<string, number>();
  for (const constraint of ragdoll?.constraints ?? []) {
    kinds.set(constraint.data.kind, (kinds.get(constraint.data.kind) ?? 0) + 1);
  }
  problems += issues.length;
  console.log(
    `${file}: ${String(ragdoll?.rigidBodies.length ?? 0)} bodies (skeleton.nif ${nifBodies < 0 ? 'none' : String(nifBodies)}), ` +
      `constraints ${[...kinds].map(([kind, count]) => `${kind} ${String(count)}`).join(', ')}, ` +
      `${String(physics.systems.length)} system(s), ${String(resources(physics.container))} resources` +
      (issues.length > 0 ? `\n    ${issues.join('\n    ')}` : ''),
  );
  if (showBodies) {
    for (const body of ragdoll?.rigidBodies ?? []) {
      console.log(
        `    ${body.name.padEnd(28)} ${shapeName(body.shape).padEnd(24)} mass ${body.motion.mass.toFixed(2)} ` +
          `filter ${body.collisionFilterInfo.toString(16)} friction ${body.material.friction.toFixed(2)} ` +
          `damping ${body.motion.linearDamping.toFixed(3)}/${body.motion.angularDamping.toFixed(3)}`,
      );
    }
  }
}
console.log(
  `${String(files)} skeleton files with a ragdoll: ${String(totals.bodies)} ragdoll bodies (and ${String(totals.others)} other bodies), ${String(totals.constraints)} constraints, ${String(problems)} problems`,
);
for (const [shape, count] of [...totals.shapes].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)} ${shape}`);
}
await vfs.close();
