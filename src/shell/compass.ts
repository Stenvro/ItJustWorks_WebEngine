// What the HUD's compass shows (its CompassTargetDataA: per marker its heading in degrees from
// north, its alpha 0..100, its icon frame and its scale in percent; then SetCompassMarkers):
// the targets of the active quests' shown objectives (QOBJ QSTA: the alias's reference) in the
// player's worldspace or cell, and the map markers near the player in the worldspace: within
// iMapMarkerVisibleDistance, fading out from iMapMarkerFadeStartDistance, with their discovered
// icon (frame 5 + type) or the undiscovered one (72 + type) of the HUD's "Compass Marker". A map
// marker comes into view as it is near (visible on the map) and is discovered within
// iMapMarkerRevealDistance: the HUD says so (its name, sDiscoveredText) and it can be travelled
// to; a discovery plays its music (MUSDiscovery*, by the place's type). A quest target in another
// cell or world shows as the load door that leads toward it (QuestDoor: the first door of the
// route, src/ai/routes.ts). The player's own marker (the map's Place Marker) shows in its world,
// always (PlayerSet). Skyrim gives no experience for a discovery (iXPRewardDiscoverMapMarker
// and the movie's Enemy frame are Fallout's, unused).

import { findRoute } from '../ai/routes.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { spaceOf } from './actors-away.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { GameSettings } from '../world/game-settings.ts';
import { MapMarkerFlag, readMapMarkers, type MapMarker } from '../world/map-markers.ts';
import type { GameSession } from './game-session.ts';
import type { Vec3 } from '../render/math.ts';

/** The HUD's "Compass Marker" frames. */
export const CompassFrame = { quest: 1, questDoor: 2, playerSet: 3, enemy: 4 } as const;
const DISCOVERED_FIRST = 5;

/** MUSC of a discovery (Skyrim.esm): the city's, the town's, the dungeon's, the others'. */
const DISCOVERY_MUSIC = {
  city: 0xabda5,
  town: 0xabda3,
  dungeon: 0xabda4,
  generic: 0xac13d,
  highHrothgar: 0x17411,
} as const;
/** Map marker types (TNAM: the map's icons) and their discovery music. */
const CITY_MARKERS = new Set([1, 34, 35, 36, 37, 38, 39, 40, 41, 42]);
const TOWN_MARKERS = new Set([2, 3]);
/** Cave, fort, Nordic ruins, Dwemer ruin, mine, Imperial tower, Nordic tower. */
const DUNGEON_MARKERS = new Set([4, 6, 7, 8, 15, 21, 30]);
const HIGH_HROTHGAR_MARKER = 43;
/** A quest door's way is searched again this often (ms): the player moves meanwhile. */
const QUEST_DOOR_MS = 3000;

/**
 * The music a discovery plays by its place's type. TODO(M13): the engine's own choice is not
 * documented (here: cities and their castles, towns and settlements, the dungeon kinds).
 */
export function discoveryMusic(markerType: number): number {
  if (markerType === HIGH_HROTHGAR_MARKER) return DISCOVERY_MUSIC.highHrothgar;
  if (CITY_MARKERS.has(markerType)) return DISCOVERY_MUSIC.city;
  if (TOWN_MARKERS.has(markerType)) return DISCOVERY_MUSIC.town;
  if (DUNGEON_MARKERS.has(markerType)) return DISCOVERY_MUSIC.dungeon;
  return DISCOVERY_MUSIC.generic;
}
const UNDISCOVERED_FIRST = 72;

/** A marker's heading from a point in degrees: 0 north (+Y), 90 east (+X). */
export function headingTo(from: readonly number[], to: readonly number[]): number {
  const degrees =
    (Math.atan2((to[0] ?? 0) - (from[0] ?? 0), (to[1] ?? 0) - (from[1] ?? 0)) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** A map marker's alpha by its distance (100 near, fading to 0 at the visible distance). */
export function markerAlpha(distance: number, fadeStart: number, visible: number): number {
  if (distance >= visible) return 0;
  if (distance <= fadeStart) return 100;
  return Math.round((100 * (visible - distance)) / (visible - fadeStart));
}

export class Compass {
  readonly #session: GameSession;
  /** The doors toward targets elsewhere, by where the player is and the target is: when found. */
  readonly #doors = new Map<string, { readonly at: number; readonly door: Vec3 | undefined }>();
  #markers: Promise<MapMarker[]> | undefined;
  #markersOf: ScriptRuntime | undefined;

  constructor(session: GameSession) {
    this.#session = session;
  }

  /** The compass's data now (4 numbers a marker), discovering the markers the player reached. */
  async targets(): Promise<number[]> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    const at = session.scriptWorld.livePlacement(PLAYER_REF);
    if (!runtime || !at) return [];
    const settings = await session.settings();
    const data = [...(await this.#questTargets(runtime, at))];
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
    this.#session.soundSystem?.music.add(discoveryMusic(marker.type));
    if (marker.name) {
      this.#session.hud.discovered(marker.name, settings.string('sDiscoveredText') ?? 'discovered');
    }
  }

  /** The first load door on the way from the player to a place in another cell or world. */
  async #doorToward(
    at: { readonly position: readonly number[]; readonly cell?: number; readonly world?: number },
    target: Placement,
  ): Promise<Vec3 | undefined> {
    const key = `${String(at.cell ?? at.world)}>${String(target.cell ?? target.world)}:${target.position.map((v) => Math.round(v / 512)).join(',')}`;
    const known = this.#doors.get(key);
    if (known && performance.now() - known.at < QUEST_DOOR_MS) return known.door;
    const routes = await this.#session.routeMap();
    const here = spaceOf({ cell: at.cell, world: at.world });
    const there = spaceOf(target);
    const position: Vec3 = [at.position[0] ?? 0, at.position[1] ?? 0, at.position[2] ?? 0];
    const start = routes.nearestNavmesh(here, position);
    const end = routes.nearestNavmesh(there, target.position);
    const route =
      start === undefined || end === undefined
        ? undefined
        : findRoute(
            routes,
            { space: here, position, navmesh: start },
            { space: there, position: target.position, navmesh: end },
          );
    const door = route?.doors[0]?.position;
    this.#doors.set(key, { at: performance.now(), door });
    return door;
  }

  /** The targets of the active quests' shown objectives in the player's space. */
  async #questTargets(
    runtime: ScriptRuntime,
    at: { readonly position: readonly number[]; readonly cell?: number; readonly world?: number },
  ): Promise<number[]> {
    const data: number[] = [];
    for (const target of await questTargets(runtime)) {
      const { placement } = target;
      const here =
        at.world !== undefined
          ? placement.world === at.world
          : placement.cell !== undefined && placement.cell === at.cell;
      if (!here) {
        // Elsewhere: the load door that leads toward it.
        const door = await this.#doorToward(at, placement);
        if (door) data.push(headingTo(at.position, door), 100, CompassFrame.questDoor, 100);
        continue;
      }
      data.push(headingTo(at.position, placement.position), 100, CompassFrame.quest, 100);
    }
    return data;
  }
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
        if (
          target.conditions.length > 0 &&
          !(await runtime.conditionsHold(target.conditions, runtime.referenceHandle(PLAYER_REF)))
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
