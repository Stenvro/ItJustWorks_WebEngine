// What a race's DATA flags tell its members' movement and pathing (RaceAiFlag, RaceFlag2;
// xEdit's wbDefinitionsTES5 RACE DATA, CommonLibSSE RACE_DATA::Flag / Flag2): who opens doors,
// who is pushed aside, who never moves, who keeps off roads and who goes round others ahead of
// time. (Always Use Proxy Controller, the dragons': every actor's controller here is the
// character proxy, src/physics/character.ts.) The readers: src/shell/actor-doors.ts, actor-movers.ts, src/ai/pathfinding.ts,
// avoidance.ts. Platform-independent.

import { RaceAiFlag, RaceFlag2 } from './race-combat-records.ts';

/**
 * Whether an actor of the race opens doors (Can't Open Doors clear). 60 races have the flag:
 * the animals, the dragons, the giants and mammoths, the spiders, the chaurus, the dwarven
 * centurions, the wisps. A door they come to shut stays shut to them (their paths keep off it)
 * and they take no load door; one already open they pass.
 */
export function raceOpensDoors(raceFlags: number): boolean {
  return (raceFlags & RaceAiFlag.cantOpenDoors) === 0;
}

/**
 * Whether others push an actor of the race aside (Not Pushable clear). 9 races have the flag:
 * the dragons, the Forgemaster, Miraak, the ghost frost giant. One of them bumped into does not
 * flinch and step aside, and gives way to no one on a narrow way.
 */
export function racePushable(raceFlags: number): boolean {
  return (raceFlags & RaceAiFlag.notPushable) === 0;
}

/**
 * Whether an actor of the race never moves of itself (Immobile): the mannequins (ManakinRace)
 * and the Midden's empty actor. Its packages ask it to go nowhere: it stands and keeps its
 * facing. TODO(M13): whether the engine still turns it to face (a head track, a dialogue).
 */
export function raceImmobile(raceFlags: number): boolean {
  return (raceFlags & RaceAiFlag.immobile) !== 0;
}

/**
 * Whether an actor of the race keeps off roads (Avoids Roads): the giants, the mammoths, the
 * ghost frost giant and the lurkers. The navmeshes mark roads as preferred triangles; to these
 * they cost more instead of less (ROAD_AVOID_COST in pathfinding.ts). TODO(M13): the engine's
 * own cost is not documented.
 */
export function raceAvoidsRoads(raceFlags: number): boolean {
  return (raceFlags & RaceAiFlag.avoidsRoads) !== 0;
}

/**
 * Whether an actor of the race uses the advanced avoidance (Flags 2 Use Advanced Avoidance, 90
 * races: the people, the undead, trolls, giants, atronachs, the dwarven machines, mudcrabs,
 * frostbite spiders; not the wolves, bears, deer, horses): it foresees where those moving near
 * it will be and passes one coming head-on on its right (avoidance.ts). The others go round
 * those in their way as they stand. TODO(M13): what "advanced" is beside the plain avoidance is
 * not documented; this is the plain reading of the name.
 */
export function raceAdvancedAvoidance(raceFlags2: number): boolean {
  return (raceFlags2 & RaceFlag2.useAdvancedAvoidance) !== 0;
}
