// The light level on an actor (GetLightLevel, the console's GetLightLevel / gll; detection's
// light: src/ai/detection.ts): how brightly it is lit where it stands, from what lights the
// scene (the view's lighting: the cell's or the weather's ambient and directional light, the
// placed lights near it). UESP "Skyrim:Sneak" says only that brighter light makes one easier to
// see, across the whole range; the readings players quote run from 0 in the dark to 150 and
// more in daylight (Realistic AI Detection's notes). The engine's settings bound it: plus
// iLightLevelInteriorMod inside, iLightLevelExteriorMod outside, at most iLightLevelMax.
// TODO(M13): the engine's sum is not documented; here the light's luminance (Rec. 709) at the
// actor, as the renderer has it: the mean of the six directional ambients, the directional light
// unless something stands between it and the actor, each point light within its radius with the
// renderer's falloff (1 − (d / r)²), all times 100. Platform-independent.

type Vec3 = readonly [number, number, number];

/** A point light at a moment (src/render/scene-renderer.ts PointLight). */
export interface ProbeLight {
  readonly position: Vec3;
  readonly radius: number;
  /** Its colour times its fade (0..1 per channel, more for bright lights). */
  readonly color: Vec3;
}

/** What lights a place: the view's lighting near it. */
export interface LightProbe {
  /** Ambient light from +X, −X, +Y, −Y, +Z, −Z. */
  readonly ambient: readonly Vec3[];
  readonly sunColor: Vec3;
  /** Direction towards the directional light (the sun or moon; an interior's own). */
  readonly sunDirection: Vec3;
  /** The point lights near the place. */
  readonly lights: readonly ProbeLight[];
  /** Inside (iLightLevelInteriorMod) or outside (iLightLevelExteriorMod). */
  readonly interior: boolean;
}

/** The light level's bounds and offsets (DetectionSettings' iLightLevel*). */
export interface LightLevelSettings {
  readonly lightLevelExteriorMod: number;
  readonly lightLevelInteriorMod: number;
  readonly lightLevelMax: number;
}

/** A colour's luminance (Rec. 709). */
export function luminance(color: Vec3): number {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

/** The light level a light of luminance 1 gives. */
const LEVEL_SCALE = 100;

/**
 * The light level at a point: `sunlit` says whether the directional light reaches it (nothing
 * stands between it and the light: the viewer's ray), see the file's comment.
 */
export function lightLevel(
  probe: LightProbe,
  at: Vec3,
  sunlit: boolean,
  settings: LightLevelSettings,
): number {
  let light = 0;
  if (probe.ambient.length > 0) {
    let sum = 0;
    for (const color of probe.ambient) sum += luminance(color);
    light += sum / probe.ambient.length;
  }
  if (sunlit) light += luminance(probe.sunColor);
  for (const point of probe.lights) {
    if (point.radius <= 0) continue;
    const distance = Math.hypot(
      point.position[0] - at[0],
      point.position[1] - at[1],
      point.position[2] - at[2],
    );
    const falloff = distance / point.radius;
    if (falloff >= 1) continue;
    light += luminance(point.color) * (1 - falloff * falloff);
  }
  const level =
    light * LEVEL_SCALE +
    (probe.interior ? settings.lightLevelInteriorMod : settings.lightLevelExteriorMod);
  return Math.min(settings.lightLevelMax, Math.max(0, level));
}
