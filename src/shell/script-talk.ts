// A script's Activate of an actor by the player (ObjectReference.Activate with the player as
// the activator): the actor's default activation, a conversation, as the player's own
// activation starts one (docs/scripting.md, "Activation", an actor the player is made to activate).
// A talking activator's default activation by the player: a conversation with it.

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { CellObject } from '../world/cell-loader.ts';
import type { ActorStage } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';
import type { Activatable } from './play-session.ts';

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

/**
 * A talking activator (TACT) the player activates starts a conversation with it, as an actor
 * does (Creation Kit: a talking activator is a dialogue speaker): its dialogue's speaker is the
 * activator, its name and voice type (VNAM) its own, its voice said from where it stands. Its
 * scripts' OnActivate runs as with any activator (the engine's activation, before this default),
 * and a script that blocks its activation keeps the conversation from starting. From the data:
 * the Whispering Door's "(Listen at the door)" topic is said by the door (DA08's stage 25 waits
 * for it), and the Daedric shrines' voices are talking activators. Anyone else activating it
 * (an activate parent, an actor's AI) only runs its scripts.
 */
export function talkingActivation(
  target: Activatable,
  object: CellObject,
  session: GameSession | undefined,
  activator: number | undefined,
): Activatable {
  if (object.baseType !== 'TACT' || (activator ?? PLAYER_REF) !== PLAYER_REF || !session) {
    return target;
  }
  return {
    ...target,
    activate: () => {
      target.activate();
      talkToActivator(session, object).catch((error: unknown) => {
        session.scriptsReady?.warn(
          `the conversation does not start: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
  };
}

async function talkToActivator(session: GameSession, object: CellObject): Promise<void> {
  const menus = session.hud.menus;
  const runtime = session.scriptsReady;
  if (!menus || !runtime) return;
  const voice = await runtime.voiceType(object.reference);
  const voiceType = voice === undefined ? undefined : (await runtime.forms.record(voice))?.editorId;
  menus.talk({
    reference: object.reference,
    name: object.name,
    voiceType,
    at: [object.world[12] ?? 0, object.world[13] ?? 0, object.world[14] ?? 0],
  });
}
