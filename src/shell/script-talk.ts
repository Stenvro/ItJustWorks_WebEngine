// A script's Activate of an actor by the player (ObjectReference.Activate with the player as
// the activator): the actor's default activation, a conversation, as the player's own
// activation starts one (docs/scripting.md, "Activation", an actor the player is made to activate).

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorStage } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';

/**
 * Opens the dialogue menu with a living actor of the loaded area that a script had the player
 * activate (MQ202EsbernsDoorScript has Esbern activated by the player through his door's slot,
 * so they talk through it). One that is dead, not on the stage, or kept from talking to the
 * player (AllowPCDialogue false; bleeding out without AllowBleedoutDialogue) gives nothing.
 * True if the conversation was opened. TODO(M13): the original's other default activations of
 * an actor by a script (a dead one's inventory, pickpocketing while sneaking).
 */
export function talkOnActivate(
  stage: ActorStage,
  session: GameSession,
  reference: number,
  activator: number | undefined,
): boolean {
  if ((activator ?? PLAYER_REF) !== PLAYER_REF) return false;
  const staged = stage.get(reference);
  const menus = session.hud.menus;
  if (!staged || staged.dead || staged.visibility.hidden || !menus) return false;
  const scripts = session.scriptsReady;
  const own = scripts?.state.actors.get(reference);
  const bleeding = scripts?.world.combat?.(reference)?.bleedingOut === true;
  if (own?.allowPlayerDialogue === false || (bleeding && own?.allowBleedoutDialogue !== true)) {
    return false;
  }
  menus.talk(staged.placed);
  return true;
}
