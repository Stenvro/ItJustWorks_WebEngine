// What the HUD's compass shows (its CompassTargetDataA: per marker its heading in degrees from
// north, its alpha 0..100, its icon frame and its scale in percent; then SetCompassMarkers):
// the targets of the active quests' shown objectives (QOBJ QSTA: the alias's reference) in the
// player's worldspace or cell, and the map markers near the player in the worldspace: within
// iMapMarkerVisibleDistance, fading out from iMapMarkerFadeStartDistance, with their discovered
// icon (frame 5 + type) or the undiscovered one (72 + type) of the HUD's "Compass Marker". A map
// marker comes into view as it is near (visible on the map) and is discovered within
// iMapMarkerRevealDistance: the HUD says so (its name, sDiscoveredText) and it can be travelled
// to. TODO(M10): a quest target in another cell (the door that leads toward it, QuestDoor),
// enemies (Enemy), the discovery's experience (iXPRewardDiscoverMapMarker) and music. TODO(M9):
// the player's own marker (PlayerSet, from the map).

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { GameSettings } from '../world/game-settings.ts';
import { MapMarkerFlag, readMapMarkers, type MapMarker } from '../world/map-markers.ts';
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
      if (!here) continue;
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
