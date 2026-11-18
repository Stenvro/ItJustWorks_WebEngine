// Sums a V8 CPU profile (.cpuprofile: tests/sim-frame-profile.int.test.ts, tools/qa-perf.ts) by
// system (src/<folder>, Rapier, the rest), source file and function, as milliseconds a frame.
//
//   node tools/cpu-profile-summary.ts <file.cpuprofile> <frames> [--top N] [--children <regex>]
//
// --children: the functions the matching ones call, with their time (inclusive), to see what a
// system's time goes to.

import fs from 'node:fs';

interface ProfileNode {
  readonly id: number;
  readonly callFrame: {
    readonly functionName: string;
    readonly url: string;
    readonly lineNumber: number;
  };
  readonly children?: readonly number[];
}

interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

const [file, framesArg, ...rest] = process.argv.slice(2);
if (!file || !framesArg) {
  console.log('usage: node tools/cpu-profile-summary.ts <file.cpuprofile> <frames> [--top N]');
  console.log('       [--children <regex>]');
  process.exit(2);
}
let top = 30;
let children: RegExp | undefined;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--top') top = Number(rest[++i]);
  else if (rest[i] === '--children') children = new RegExp(rest[++i] ?? '');
}
const frames = Number(framesArg);
const profile = JSON.parse(fs.readFileSync(file, 'utf8')) as CpuProfile;
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map<number, number>();
for (const node of profile.nodes)
  for (const child of node.children ?? []) parent.set(child, node.id);
/** Microseconds sampled in each node itself. */
const self = new Map<number, number>();
profile.samples.forEach((id, i) => {
  self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0));
});

const source = (url: string): string => {
  const match = /\/(src|tests|tools|node_modules)\/(.*)$/.exec(url.replace(/\\/g, '/'));
  return match ? `${match[1]}/${match[2]}` : url || '(native)';
};
const system = (url: string): string => {
  const at = source(url);
  if (at.startsWith('src/')) return at.split('/').slice(0, 2).join('/');
  if (at.includes('rapier') || at.startsWith('wasm://')) return 'Rapier (wasm and its bindings)';
  return at.startsWith('node_modules/') ? at.split('/').slice(0, 2).join('/') : at;
};
const name = (id: number): string => {
  const frame = byId.get(id)?.callFrame;
  if (!frame) return '?';
  return `${frame.functionName || '(anonymous)'} ${source(frame.url)}:${String(frame.lineNumber + 1)}`;
};
const ms = (us: number): string => (us / 1000 / frames).toFixed(3).padStart(8);
const add = (map: Map<string, number>, key: string, us: number): void => {
  map.set(key, (map.get(key) ?? 0) + us);
};
const print = (title: string, map: ReadonlyMap<string, number>): void => {
  console.log(`\n${title} (ms a frame)`);
  for (const [key, us] of [...map].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`${ms(us)}  ${key}`);
  }
};

const bySystem = new Map<string, number>();
const byFile = new Map<string, number>();
const byFunction = new Map<string, number>();
const inclusive = new Map<string, number>();
let total = 0;
for (const [id, us] of self) {
  total += us;
  const url = byId.get(id)?.callFrame.url ?? '';
  add(bySystem, system(url), us);
  add(byFile, source(url), us);
  add(byFunction, name(id), us);
  // Each function once on the way up (recursion counted once).
  const seen = new Set<string>();
  for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
    const key = name(at);
    if (seen.has(key)) continue;
    seen.add(key);
    add(inclusive, key, us);
  }
}
console.log(`sampled ${ms(total).trim()} ms a frame`);
print('By system (self)', bySystem);
print('By file (self)', byFile);
print('By function (self)', byFunction);
print(
  'By function, with what it calls (src/)',
  new Map([...inclusive].filter(([key]) => key.includes(' src/'))),
);

if (children) {
  const subtree = (id: number): number => {
    let us = 0;
    const stack = [id];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      us += self.get(at) ?? 0;
      stack.push(...(byId.get(at)?.children ?? []));
    }
    return us;
  };
  const called = new Map<string, number>();
  const pattern = children;
  for (const node of profile.nodes) {
    if (!pattern.test(name(node.id))) continue;
    let nested = false;
    for (let at = parent.get(node.id); at !== undefined; at = parent.get(at)) {
      if (pattern.test(name(at))) nested = true;
    }
    if (nested) continue;
    add(called, '(itself)', self.get(node.id) ?? 0);
    for (const child of node.children ?? []) add(called, name(child), subtree(child));
  }
  print(`What ${String(pattern)} calls`, called);
}
