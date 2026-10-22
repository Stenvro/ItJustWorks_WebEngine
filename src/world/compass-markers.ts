// The compass's pure rules (src/shell/compass.ts): headings, map markers' fading, the music a
// discovery plays. Platform-independent.

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
