// The events the game's scripts handle (docs/scripting.md, "Events"): each event's declaration in
// the base scripts (Form, ObjectReference, Actor, Quest, Alias, ReferenceAlias, ActiveMagicEffect)
// and how many scripts of the load order have a handler for it (tools/script-event-usage.ts).
//
//   node tools/script-events.ts                every event, most handled first
//   node tools/script-events.ts OnTrigger      one event: its declarations and its scripts

import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';
import { scriptEventUsage } from './script-event-usage.ts';

const wanted = process.argv[2]?.toLowerCase();
const vfs = await Vfs.mount(openGameFolder());
try {
  const { declared, handlers } = await scriptEventUsage(vfs);
  if (wanted !== undefined) {
    for (const line of declared.get(wanted) ?? ['(not declared in the base scripts)'])
      console.log(line);
    for (const line of handlers.get(wanted) ?? []) console.log(`  ${line}`);
  } else {
    const rows = [...declared].sort(
      (a, b) => (handlers.get(b[0])?.length ?? 0) - (handlers.get(a[0])?.length ?? 0),
    );
    for (const [event, lines] of rows) {
      console.log(
        `${String(handlers.get(event)?.length ?? 0).padStart(5)}  ${lines.join('  |  ')}`,
      );
    }
  }
} finally {
  await vfs.close();
}
