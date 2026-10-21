// The condition functions (CTDA) the load order uses against the evaluators that value them
// (tools/condition-usage.ts): the functions no evaluator values, with how many records of each
// type use them, and those left to a later milestone. An unknown function is an error.
//
//   node tools/condition-audit.ts          the unvalued and the milestone-held functions
//   node tools/condition-audit.ts --all    every function the data uses, with its records

import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { conditionAudit, recordCount, type FunctionUsage } from './condition-usage.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const library = new ScriptLibrary(async (name) => {
  const path = `scripts\\${name}.pex`;
  return vfs.has(path) ? vfs.read(path) : undefined;
});
const runtime = new ScriptRuntime(db, library, { warn: () => undefined });
const audit = await conditionAudit(db, runtime);

const line = (usage: FunctionUsage, note: string): string =>
  `${String(usage.function).padStart(4)} ${conditionFunctionName(usage.function).padEnd(34)}` +
  `${String(recordCount(usage)).padStart(6)}  ${[...usage.records]
    .map(([type, count]) => `${type} ${String(count)}`)
    .join(', ')}${note === '' ? '' : `  (${note})`}`;

if (process.argv.includes('--all')) {
  for (const usage of [...audit.usage.values()].sort((a, b) => recordCount(b) - recordCount(a))) {
    const sound = usage.sound > 0 ? `${String(usage.sound)} ambient sounds or tracks; ` : '';
    console.log(line(usage, sound + usage.examples.join('; ')));
  }
  console.log('');
}
console.log(`${String(audit.usage.size)} condition functions used by the load order`);
console.log(`\nnot valued (${String(audit.unvalued.length)}):`);
for (const finding of audit.unvalued) console.log(line(finding.usage, finding.why));
console.log(`\nheld for a milestone (${String(audit.notYet.length)}):`);
for (const finding of audit.notYet) console.log(line(finding.usage, finding.why));
if (audit.errors.length > 0) {
  console.log(`\nvaluing threw (${String(audit.errors.length)}):`);
  for (const error of audit.errors) console.log(`  ${error}`);
}
await db.close();
await vfs.close();
