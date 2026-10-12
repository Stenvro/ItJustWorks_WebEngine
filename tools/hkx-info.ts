// Shows a Havok Behavior graph: its variables, events, generator tree and what it plays when
// it starts; or the objects of any packfile.
//
//   node tools/hkx-info.ts meshes\effects\fxfirewithembersheavytoggle.nif   the mesh's graph
//   node tools/hkx-info.ts meshes\genericbehaviors\autoplay.hkx             a project
//   node tools/hkx-info.ts <file.hkx> --objects                             a packfile's objects
//   node tools/hkx-info.ts --audit            every vanilla mesh's graph: loads and starts

import {
  graphStart,
  loadBehaviorGraph,
  parseBehaviorGraph,
  type BehaviorGenerator,
  type BehaviorGraph,
  type StateTransition,
} from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { behaviorGraphPath } from '../src/render/animation.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const read = (path: string): Promise<Uint8Array> => vfs.read(path);
const [target = ''] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

function printGraph(graph: BehaviorGraph): void {
  console.log(`behavior ${graph.name}`);
  console.log(`  events: ${graph.events.map((event, i) => `${String(i)} ${event}`).join(', ')}`);
  for (const [i, variable] of graph.variables.entries()) {
    console.log(
      `  variable ${String(i)} ${variable.name} = ${String(variable.initial)} (type ${String(variable.type)})`,
    );
  }
  const transition = (t: StateTransition): string =>
    `${graph.events[t.eventId] ?? String(t.eventId)} → ${String(t.toStateId)}` +
    `${t.conditional ? ' (condition)' : ''} flags 0x${t.flags.toString(16)}`;
  const bound = (value: number, variable?: number): string =>
    variable === undefined
      ? String(value)
      : `${graph.variables[variable]?.name ?? '?'} (${String(value)})`;
  const walk = (node: BehaviorGenerator | undefined, depth: number): void => {
    const pad = '  '.repeat(depth + 1);
    if (!node) return;
    switch (node.kind) {
      case 'state-machine':
        console.log(
          `${pad}state machine ${node.name}: start ${bound(node.startStateId.value, node.startStateId.variable)} mode ${String(node.startStateMode)}`,
        );
        for (const wildcard of node.wildcardTransitions)
          console.log(`${pad}  * ${transition(wildcard)}`);
        for (const state of node.states) {
          console.log(
            `${pad}  state ${String(state.id)} ${state.name}${state.enable ? '' : ' (disabled)'}`,
          );
          for (const t of state.transitions) console.log(`${pad}    on ${transition(t)}`);
          walk(state.generator, depth + 2);
        }
        return;
      case 'blender':
        console.log(
          `${pad}blender ${node.name}: flags 0x${node.flags.toString(16)} parameter ${bound(node.blendParameter.value, node.blendParameter.variable)}`,
        );
        for (const child of node.children) {
          console.log(`${pad}  child weight ${bound(child.weight.value, child.weight.variable)}`);
          walk(child.generator, depth + 2);
        }
        return;
      case 'modifier-generator':
        console.log(`${pad}modifier generator ${node.name}`);
        walk(node.generator, depth + 1);
        return;
      case 'gamebryo-sequence':
        console.log(
          `${pad}NIF sequence ${node.sequence} (blend mode ${String(node.blendMode)}, percent ${bound(node.percent.value, node.percent.variable)})`,
        );
        return;
      case 'clip':
        console.log(
          `${pad}clip ${node.animation} (mode ${String(node.mode)}, speed ${String(node.playbackSpeed)})`,
        );
        return;
      case 'reference-pose':
        console.log(`${pad}reference pose ${node.name}`);
        return;
      case 'other':
        console.log(`${pad}${node.className} ${node.name}`);
        return;
    }
  };
  walk(graph.root, 0);
  const start = graphStart(graph);
  const sequences = start.sequences.map((s) => `${s.sequence} ×${String(s.weight)}`).join(', ');
  const clips = start.clips.length > 0 ? `; clips ${start.clips.join(', ')}` : '';
  console.log(`  starts: ${sequences || 'no NIF sequence'}${clips}`);
}

if (process.argv.includes('--audit')) {
  // Every mesh naming a graph: does the graph load, and what does it start?
  const projects = new Map<string, string[]>();
  for (const path of vfs.list('meshes')) {
    if (!path.endsWith('.nif')) continue;
    try {
      const project = behaviorGraphPath(parseNif(await vfs.read(path)));
      if (project) projects.set(project, [...(projects.get(project) ?? []), path]);
    } catch {
      // Broken meshes are the NIF tools' business.
    }
  }
  let loaded = 0;
  for (const [project, meshes] of projects) {
    try {
      const start = graphStart(await loadBehaviorGraph(project, read));
      loaded++;
      if (process.argv.includes('--verbose')) {
        console.log(
          `${project} (${String(meshes.length)}): ${start.sequences.map((s) => s.sequence).join(', ')}`,
        );
      }
    } catch (error) {
      console.log(
        `! ${project} (${String(meshes.length)} meshes): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(`${String(projects.size)} graphs named by meshes, ${String(loaded)} loaded`);
} else if (target.toLowerCase().endsWith('.nif')) {
  const project = behaviorGraphPath(parseNif(await vfs.read(target)));
  if (!project) console.log(`${target}: no behavior graph`);
  else {
    console.log(`${target} → ${project}`);
    printGraph(await loadBehaviorGraph(project, read));
  }
} else {
  const file = Packfile.parse(await vfs.read(target));
  console.log(
    `${target}: ${file.version}, ${String(file.objects.size)} objects, root ${file.root?.className ?? '-'}`,
  );
  if (process.argv.includes('--objects')) {
    for (const object of file.objects.values())
      console.log(`  ${String(object.offset).padStart(6)} ${object.className}`);
  } else if (file.objectsOf('hkbProjectData').length > 0) {
    printGraph(await loadBehaviorGraph(target, read));
  } else if (file.objectsOf('hkbBehaviorGraph').length > 0) {
    printGraph(parseBehaviorGraph(file));
  }
}
await vfs.close();
