// The light on an actor (detection's light: src/ai/detection.ts detectionLight; GetLightLevel,
// the console's GetLightLevel / gll): how brightly it is lit where it stands, from what lights
// the scene (the view's lighting: the cell's or the weather's ambient and directional light, the
// placed lights near it). What the engine makes of it is observed in the original (detectionLight): less
// iLightLevelExteriorMod outside or, inside, the lesser of iLightLevelInteriorMod and 100 × the
// brightest channel of the cell's ambient light, between 0 and iLightLevelMax; GetLightLevel
// gives that × fSneakLightMult (fSneakLightExteriorMult outside). The sum is the original's: each
// light's mean channel × its fade × (1 − (d / r)²) within its radius, plus the directional light's
// ambient and diffuse parts as means of their channels, all times 100, worked out every
// fLightRecalcTimer (the player: fLightRecalcTimerPlayer). What stays ours (TODO(M13)): the ambient
// part is the mean of the view's six directional ambients; the original multiplies the diffuse
// part by a renderer value not read yet (here 1); and which lights count: the original takes the
// lights its renderer gave the actor's body and, for the player, tests only the shadow casting
// ones for a line to them; here a ray to each.
// Platform-independent.

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

/** How bright a colour counts: the mean of its channels (observed in the original). */
export function colorLevel(color: Vec3): number {
  return (color[0] + color[1] + color[2]) / 3;
}

/** The light level a light of level 1 gives. */
const LEVEL_SCALE = 100;

/**
 * The light at a point (0 or more): `sunlit` says whether the directional light reaches it
 * (nothing stands between it and the light: the viewer's ray), see the file's comment;
 * `reaches`, whether a point light does (a wall between: it lights the other side, not this
 * one; without it every light within its radius counts).
 */
export function lightLevel(
  probe: LightProbe,
  at: Vec3,
  sunlit: boolean,
  reaches?: (light: ProbeLight) => boolean,
): number {
  let light = 0;
  if (probe.ambient.length > 0) {
    let sum = 0;
    for (const color of probe.ambient) sum += colorLevel(color);
    light += sum / probe.ambient.length;
  }
  if (sunlit) light += colorLevel(probe.sunColor);
  for (const point of probe.lights) {
    if (point.radius <= 0) continue;
    const distance = Math.hypot(
      point.position[0] - at[0],
      point.position[1] - at[1],
      point.position[2] - at[2],
    );
    const falloff = distance / point.radius;
    if (falloff >= 1) continue;
    if (reaches && !reaches(point)) continue;
    light += colorLevel(point.color) * (1 - falloff * falloff);
  }
  return Math.max(0, light * LEVEL_SCALE);
}

/** The brightest channel of the mean ambient light of a probe (0..1). */
export function brightestAmbient(probe: LightProbe): number {
  if (probe.ambient.length === 0) return 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const [r, g, b] of probe.ambient) {
    red += r;
    green += g;
    blue += b;
  }
  return Math.max(red, green, blue) / probe.ambient.length;
}
