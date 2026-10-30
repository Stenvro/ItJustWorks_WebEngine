// A fast travel's journey (the map, Game.FastTravel; Play's and the headless simulation's): the
// hours the way takes pass, the sky takes its next weather at once, the player goes there (as
// the caller enters a place: behind a loading screen, or headless), and the arrival is told
// with the hours it took (TESFastTravelEndEvent: OnPlayerFastTravelEnd).

import { fastTravelHours } from '../gameplay/fast-travel.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement } from '../scripting/runtime/runtime.ts';
import type { GameSession } from './game-session.ts';

/** How far the player goes to a place: across the worldspace they are in, else none. */
export function fastTravelWay(session: GameSession, at: Placement): number {
  const from = session.scriptWorld.livePlacement(PLAYER_REF);
  return from?.world !== undefined && from.world === at.world
    ? Math.hypot(at.position[0] - from.position[0], at.position[1] - from.position[1])
    : 0;
}

/** The journey to a place `way` units off; `enter` takes the player there. Its hours. */
export async function fastTravelJourney(
  session: GameSession,
  at: Placement,
  way: number,
  enter: (at: Placement) => Promise<void>,
): Promise<number> {
  const runtime = session.scriptsReady;
  const player = await session.playerData();
  const settings = await session.settings();
  const hours = fastTravelHours(
    way,
    player.movement.normal.walk.forward,
    settings.number('fFastTravelSpeedMult') ?? 1,
    session.timeScale,
  );
  if (hours > 0) session.advanceClock(hours);
  // The sky takes the next weather at once, without a change.
  session.sky.fastTravel();
  await enter(at);
  // Arrived: the hub tells the time it took (TESFastTravelEndEvent: OnPlayerFastTravelEnd).
  runtime?.events.emit('fastTravelEnd', { hours });
  return hours;
}
