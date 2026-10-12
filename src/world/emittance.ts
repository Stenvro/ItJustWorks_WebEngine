// Emittance (REFR XEMI): an outside colour that drives a reference's External_Emittance shapes
// (window glow maps, ambient glow and mist effects) and the colour of a placed light. It
// names a light (its colour) or a region (the sunlight colour of the region's weather at the
// current hour: the FXLightRegion* regions have weathers made only for this, e.g. windows
// lit at night). Platform-independent. Notes: docs/formats/esm.md ("Emittance").

import type { Rgb } from './cell-records.ts';
import { skyState } from './sky-state.ts';
import type { ClimateRecord, RegionWeather, WeatherRecord } from './weather.ts';

export type EmittanceSource =
  | { readonly kind: 'light'; readonly color: Rgb }
  | { readonly kind: 'region'; readonly weathers: RegionWeather['weathers'] };

/**
 * The weather an emittance region follows: the most likely one of its list (the FXLightRegion*
 * regions have exactly one).
 */
export function emittanceWeather(source: EmittanceSource): number | undefined {
  if (source.kind !== 'region') return undefined;
  let best: (typeof source.weathers)[number] | undefined;
  for (const entry of source.weathers) if (!best || entry.chance > best.chance) best = entry;
  return best?.weather;
}

/**
 * The colour of an emittance source at a game hour: a light's colour, or the sunlight colour
 * of the region's weather (blended over the times of day like the sky).
 */
export function emittanceColor(
  source: EmittanceSource,
  weather: WeatherRecord | undefined,
  climate: ClimateRecord | undefined,
  hour: number,
): Rgb {
  if (source.kind === 'light') return source.color;
  if (!weather) return [0, 0, 0];
  return skyState({ weather, climate, hour, daysPassed: 0, seconds: 0 }).sunlight;
}
