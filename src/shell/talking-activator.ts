// Talking to a talking activator (TACT): activated by the player, it opens a conversation as an
// actor does, the activator its speaker: its greeting and topics are its quests' dialogue whose
// conditions name it (GetIsID on its base), said in its voice type (TACT VNAM) where it stands.
// The Sanctuary's Black Door asks its question so ("What is the music of life?"), and DB04's
// Night Mother speaks from her coffin; MG04's Augur of Dunlain, the Whispering Door's voice (DA08's stage 25 waits for its line) and the Daedric shrines' voices talk so too. Its scripts hear the activation first, as for any
// activator (ScriptRuntime.playerActivated runs the default after OnActivate).

import type { CellObject } from '../world/cell-loader.ts';
import type { ObjectSpeaker } from './actors.ts';
import type { GameSession } from './game-session.ts';

/** The speaker a talking activator is in a conversation. */
export async function activatorSpeaker(
  session: GameSession,
  object: Pick<CellObject, 'reference' | 'name' | 'world'>,
): Promise<ObjectSpeaker | undefined> {
  const runtime = session.scriptsReady;
  if (!runtime) return undefined;
  const voice = await runtime.voiceType(object.reference);
  const voiceType = voice === undefined ? undefined : (await runtime.forms.record(voice))?.editorId;
  const at = runtime.world.livePlacement?.(object.reference)?.position;
  return {
    actor: { reference: object.reference },
    look: { name: object.name, voiceType },
    // Where it stands now (a script may have moved it), else where it was placed.
    position: at
      ? [at[0], at[1], at[2]]
      : [object.world[12] ?? 0, object.world[13] ?? 0, object.world[14] ?? 0],
  };
}

/** The player talks to a talking activator: the game's dialogue menu opens with it. */
export async function talkToActivator(
  session: GameSession,
  object: Pick<CellObject, 'reference' | 'name' | 'world'>,
): Promise<void> {
  const speaker = await activatorSpeaker(session, object);
  if (speaker) session.hud.menus?.talk(speaker);
}
