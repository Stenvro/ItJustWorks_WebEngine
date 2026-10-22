// What the HUD's compass shows (its CompassTargetDataA: per marker its heading in degrees from
// north, its alpha 0..100, its icon frame and its scale in percent; then SetCompassMarkers):
// the targets of the active quests' shown objectives (QOBJ QSTA: the alias's reference) in the
// player's worldspace or cell, and the map markers near the player in the worldspace: within
// iMapMarkerVisibleDistance, fading out from iMapMarkerFadeStartDistance, with their discovered
// icon (frame 5 + type) or the undiscovered one (72 + type) of the HUD's "Compass Marker". A map
// marker comes into view as it is near (visible on the map) and is discovered within
// iMapMarkerRevealDistance: the HUD says so (its name, sDiscoveredText) and it can be travelled
// to, with its discovery music (by the marker's type: discoveryMusic). Skyrim gives no
// experience for it (iXPRewardDiscoverMapMarker is one of Fallout's unused XP settings: levels
// come from skills). A quest target in another cell or world shows at the load door the way
// there goes through (QuestDoor: the routes over navmeshes and load doors); the actors fighting
// the player show as enemies (Enemy) within fHUDCompassLocationMaxDist. The player's own marker
// (the map's Place Marker) shows in its world, always (PlayerSet).

import { findRoute, type RouteMap } from '../ai/routes.ts';
import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { GameSettings } from '../world/game-settings.ts';
import { MapMarkerFlag, readMapMarkers, type MapMarker } from '../world/map-markers.ts';
import { spaceOf } from './actors-away.ts';
import type { GameSession } from './game-session.ts';

/** The HUD's "Compass Marker" frames. */
export const CompassFrame = { quest: 1, questDoor: 2, playerSet: 3, enemy: 4 } as const;
const DISCOVERED_FIRST = 5;
const UNDISCOVERED_FIRST = 72;

/** A marker's heading from a point in degrees: 0 north (+Y), 90 east (+X). */
export function headingTo(from: readonly number[], to: readonly number[]): number {
  const degrees =
    (Math.atan2((to[0] ?? 0) - (from[0] ?? 0), (to[1] ?? 0) - (from[1] ?? 0)) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** The discovery music types (MUSC in Skyrim.esm). */
const DiscoveryMusic = {
  generic: 0xac13d,
  city: 0xabda5,
  dungeon: 0xabda4,
  town: 0xabda3,
} as const;

/** Map marker types (TNAM, xEdit's list) whose discovery plays a dungeon's music. */
const DUNGEON_MARKERS = new Set([4, 6, 7, 8, 12, 15, 31, 53, 59]);
/** ... a town's: towns, settlements, orc strongholds. */
const TOWN_MARKERS = new Set([2, 3, 28]);

/**
 * The music a place's discovery plays, by its map marker's type: a city (and its castles and
 * capitols, Raven Rock) MUSDiscoveryCity, a town MUSDiscoveryTown, a cave, fort, ruin, mine or
 * dragon lair MUSDiscoveryDungeon, anything else MUSDiscoveryGeneric. TODO(M13): the engine's
 * own table is not documented (this one is read from the types' names);
 * MUSDiscoveryHighHrothgar is not reached by a type.
 */
export function discoveryMusic(markerType: number): number {
  if (markerType === 1 || (markerType >= 35 && markerType <= 52) || markerType === 54)
    return DiscoveryMusic.city;
  if (TOWN_MARKERS.has(markerType)) return DiscoveryMusic.town;
  if (DUNGEON_MARKERS.has(markerType)) return DiscoveryMusic.dungeon;
  return DiscoveryMusic.generic;
}

/** A map marker's alpha by its distance (100 near, fading to 0 at the visible distance). */
export function markerAlpha(distance: number, fadeStart: number, visible: number): number {
  if (distance >= visible) return 0;
  if (distance <= fadeStart) return 100;
  return Math.round((100 * (visible - distance)) / (visible - fadeStart));
}

export class Compass {
  readonly #session: GameSession;
  #markers: Promise<MapMarker[]> | undefined;
  #markersOf: ScriptRuntime | undefined;
  /** The load door toward a quest target in another space, by space and target. */
  readonly #doorsToward = new Map<
    string,
    { readonly door: number; readonly position: readonly number[] } | undefined
  >();

  /** Where the actors fighting the player are now. */
  readonly #enemies: () => readonly (readonly number[])[];

  constructor(session: GameSession, enemies: () => readonly (readonly number[])[] = () => []) {
    this.#session = session;
    this.#enemies = enemies;
  }

  /** The compass's data now (4 numbers a marker), discovering the markers the player reached. */
  async targets(): Promise<number[]> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    const at = session.scriptWorld.livePlacement(PLAYER_REF);
    if (!runtime || !at) return [];
    const settings = await session.settings();
    const data = [...(await this.#questTargets(runtime, at))];
    // The actors fighting the player (Enemy: a red mark), within the compass's reach.
    const reach = settings.number('fHUDCompassLocationMaxDist') ?? 20000;
    for (const enemy of this.#enemies()) {
      const far = Math.hypot((enemy[0] ?? 0) - at.position[0], (enemy[1] ?? 0) - at.position[1]);
      if (far <= reach) data.push(headingTo(at.position, enemy), 100, CompassFrame.enemy, 100);
    }
    if (at.world === undefined) return data;
    const own = runtime.state.playerMarker;
    if (own?.world === at.world) {
      data.push(headingTo(at.position, own.position), 100, CompassFrame.playerSet, 100);
    }
    if (this.#markersOf !== runtime || !this.#markers) {
      this.#markersOf = runtime;
      this.#markers = readMapMarkers(runtime.forms.db);
    }
    const number = (name: string, fallback: number): number => settings.number(name) ?? fallback;
    const visibleDistance = number('iMapMarkerVisibleDistance', 12500);
    const fadeStart = number('iMapMarkerFadeStartDistance', 10000);
    const reveal = number('iMapMarkerRevealDistance', 1000);
    for (const marker of await this.#markers) {
      if (marker.world !== at.world) continue;
      const distance = Math.hypot(
        marker.position[0] - at.position[0],
        marker.position[1] - at.position[1],
      );
      if (distance >= visibleDistance) continue;
      let discovered =
        runtime.mapMarkerFastTravel(marker.reference) ||
        (marker.flags & MapMarkerFlag.canTravel) !== 0;
      if (!discovered && distance <= reveal) {
        discovered = true;
        this.#discover(runtime, settings, marker);
      }
      // Seen near, it shows on the map from now on.
      if (!runtime.mapMarkerVisible(marker.reference)) {
        runtime.mapMarker(marker.reference, true, discovered);
      }
      data.push(
        headingTo(at.position, marker.position),
        markerAlpha(distance, fadeStart, visibleDistance),
        (discovered ? DISCOVERED_FIRST : UNDISCOVERED_FIRST) + marker.type,
        100,
      );
    }
    return data;
  }

  #discover(runtime: ScriptRuntime, settings: GameSettings, marker: MapMarker): void {
    runtime.mapMarker(marker.reference, true, true);
    if (marker.name) {
      this.#session.hud.discovered(marker.name, settings.string('sDiscoveredText') ?? 'discovered');
    }
    // Its discovery music (a type that plays one selection, then ends: src/audio/music.ts).
    const music = runtime.forms.db.formIdOf('Skyrim.esm', discoveryMusic(marker.type));
    if (music !== undefined) this.#session.soundSystem?.music.add(music);
  }

  /** The targets of the active quests' shown objectives in the player's space. */
  async #questTargets(
    runtime: ScriptRuntime,
    at: { readonly position: readonly number[]; readonly cell?: number; readonly world?: number },
  ): Promise<number[]> {
    const data: number[] = [];
    const doors = new Set<number>();
    for (const target of await questTargets(runtime)) {
      const { placement } = target;
      const here =
        at.world !== undefined
          ? placement.world === at.world
          : placement.cell !== undefined && placement.cell === at.cell;
      if (here) {
        data.push(headingTo(at.position, placement.position), 100, CompassFrame.quest, 100);
        continue;
      }
      // Elsewhere: the load door of this space the way there goes through (QuestDoor), once.
      const door = await this.#doorToward(at, target.reference, placement);
      if (!door || doors.has(door.door)) continue;
      doors.add(door.door);
      data.push(headingTo(at.position, door.position), 100, CompassFrame.questDoor, 100);
    }
    return data;
  }

  /**
   * The first load door on the way from the player to a place in another space (the routes
   * over the navmeshes and load doors: src/ai/routes.ts), kept for a target while the player
   * and it stay in their spaces.
   */
  async #doorToward(
    at: { readonly position: readonly number[]; readonly cell?: number; readonly world?: number },
    reference: number,
    to: Placement,
  ): Promise<{ readonly door: number; readonly position: readonly number[] } | undefined> {
    const here = spaceOf({ cell: at.cell, world: at.world });
    const there = spaceOf(to);
    const key = `${JSON.stringify(here)}>${JSON.stringify(there)}:${String(reference)}`;
    if (this.#doorsToward.has(key)) return this.#doorsToward.get(key);
    // Searched once per space and target (a route over the whole map is not cheap).
    this.#doorsToward.set(key, undefined);
    const found = firstDoorToward(await this.#session.routeMap(), at, to);
    this.#doorsToward.set(key, found);
    return found;
  }
}

/**
 * The first load door on the way from a place to a place in another space (the routes over the
 * navmeshes and load doors: src/ai/routes.ts): the compass's QuestDoor, Clairvoyance's trail.
 */
export function firstDoorToward(
  routes: RouteMap,
  at: { readonly position: readonly number[]; readonly cell?: number; readonly world?: number },
  to: Placement,
): { readonly door: number; readonly position: Vec3 } | undefined {
  const here = spaceOf({ cell: at.cell, world: at.world });
  const there = spaceOf(to);
  const position: Vec3 = [at.position[0] ?? 0, at.position[1] ?? 0, at.position[2] ?? 0];
  const target: Vec3 = [...to.position];
  const start = routes.nearestNavmesh(here, position);
  const end = routes.nearestNavmesh(there, target);
  if (start === undefined || end === undefined) return undefined;
  const route = findRoute(
    routes,
    { space: here, position, navmesh: start },
    { space: there, position: target, navmesh: end },
  );
  const door = route?.doors[0];
  return (
    door && { door: door.door, position: [door.position[0], door.position[1], door.position[2]] }
  );
}

/** A target of an active quest's shown objective: the quest and where the target is. */
export interface QuestTarget {
  readonly quest: number;
  readonly questName: string;
  /** The objective (QOBJ index) it is a target of. */
  readonly objective: number;
  readonly reference: number;
  readonly placement: Placement;
}

/**
 * The targets of the active quests' shown objectives (QOBJ QSTA: the alias's reference, its
 * conditions holding), wherever they are.
 */
export async function questTargets(runtime: ScriptRuntime): Promise<QuestTarget[]> {
  const targets: QuestTarget[] = [];
  for (const [formId, quest] of runtime.state.quests) {
    if (!quest.running || !quest.active || quest.completed || quest.failed) continue;
    const record = await runtime.forms.quest(formId);
    for (const objective of record?.objectives ?? []) {
      const state = quest.objectives.get(objective.index);
      if (!state?.displayed || state.completed || state.failed) continue;
      for (const target of objective.targets) {
        const reference = quest.aliases.get(target.alias);
        if (reference === undefined) continue;
        // Its conditions run on the target (DialogueFollower's "is waiting for you": the
        // follower's WaitingForPlayer).
        if (
          target.conditions.length > 0 &&
          !(await runtime.conditionsHold(target.conditions, runtime.referenceHandle(reference)))
        ) {
          continue;
        }
        const placement = await runtime.placement(reference);
        if (!placement) continue;
        targets.push({
          quest: formId,
          questName: record?.name ?? '',
          objective: objective.index,
          reference,
          placement,
        });
      }
    }
  }
  return targets;
}
