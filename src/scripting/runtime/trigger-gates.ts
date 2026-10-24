// Trigger volumes that wait for the player (docs/ai.md, "Town scenes"): most of the game's
// street and town scenes begin with their quests and wait in their first phase for a stage or
// a quest variable that a trigger box's script sets as the player walks in (Riften's north
// gate: RDSTriggerScript sets DialogueRiftenSS01's stage 10, whose fragment sets pGo, which
// RDS01Scene's first phase waits for). Read from the scripts themselves: a trigger waits for
// the player if its OnTriggerEnter (in any state, its own or a parent script's) asks for
// Game.GetPlayer, or if a property of its scripts names the player (defaultOnEnter's target
// lists); one that names only other actors (defaultSetStageTRIGSpecificActor's TriggerActor:
// MQ101's cart horse) does not. Platform-independent.

import type { PexScript } from '../../formats/pex/pex.ts';
import { ObjectHandle, PapyrusArray, type Value } from '../values.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

/** The event a trigger volume's scripts get as something walks in. */
const ENTER_EVENT = 'ontriggerenter';

/**
 * Whether a script's OnTriggerEnter asks for the player (Game.GetPlayer), in any of its
 * states; with none of its own, its parent's (`load` reads a script by name).
 */
export async function triggerEnterAsksForPlayer(
  name: string,
  load: (name: string) => Promise<PexScript | undefined>,
): Promise<boolean> {
  const seen = new Set<string>();
  let next = name.toLowerCase();
  while (next !== '' && !seen.has(next)) {
    seen.add(next);
    const script = await load(next);
    const object = script?.objects[0];
    if (!object) return false;
    const handlers = object.states.flatMap((state) =>
      state.functions.filter((fn) => fn.name.toLowerCase() === ENTER_EVENT),
    );
    if (handlers.length > 0) {
      return handlers.some((fn) =>
        fn.code.some((instruction) => {
          if (instruction.op !== 'callstatic') return false;
          const [type, method] = instruction.args;
          return (
            type?.kind === 'identifier' &&
            type.name.toLowerCase() === 'game' &&
            method?.kind === 'identifier' &&
            method.name.toLowerCase() === 'getplayer'
          );
        }),
      );
    }
    next = object.parent.toLowerCase();
  }
  return false;
}

/** The forms a property value names (an object, or each of an array's). */
function namedForms(value: Value): number[] {
  if (value instanceof ObjectHandle) return [value.formId];
  if (value instanceof PapyrusArray) {
    return value.items.flatMap((item) => (item instanceof ObjectHandle ? [item.formId] : []));
  }
  return [];
}

/** A trigger volume that waits for the player, and what its scripts' properties name. */
export interface PlayerTrigger {
  readonly reference: number;
  /** Every form its scripts' properties name (quests, scenes, globals, references). */
  readonly names: ReadonlySet<number>;
}

/**
 * A reference's trigger scripts, if one of them waits for the player (above); undefined if
 * none does.
 */
export async function playerTrigger(
  runtime: ScriptRuntime,
  reference: number,
): Promise<PlayerTrigger | undefined> {
  const scripts = await runtime.forms.attachedScripts(new ObjectHandle(reference, 'form'));
  const names = new Set<number>();
  let waits = false;
  for (const script of scripts) {
    const named = [...script.properties.values()].flatMap(namedForms);
    for (const form of named) names.add(form);
    if (waits) continue;
    waits =
      named.includes(PLAYER_REF) ||
      (await triggerEnterAsksForPlayer(script.name, (name) => runtime.forms.db.script(name)));
  }
  return waits ? { reference, names } : undefined;
}
