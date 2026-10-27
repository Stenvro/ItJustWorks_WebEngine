// Water surfaces (cell water planes and BSWaterShaderProperty meshes): three scrolling noise
// layers for the normal, refraction of the scene below with depth fog towards the water's
// shallow and deep colours, reflections of the scene (screen space) and the sky, fresnel and
// the sun's specular and sparkle. Drawn after the opaque scene, whose colour and depth are
// copied for it. Prepended with frame.wgsl and common.wgsl. ASCII only.

struct WaterParams {
  // Shallow colour (rgb), opacity (a).
  shallow: vec4f,
  // Deep colour (rgb), reflectivity (a).
  deep: vec4f,
  // Reflection colour (rgb), fresnel (a).
  reflection: vec4f,
  // x refraction magnitude, y reflection magnitude, z noise falloff, w flowmap scale.
  surface: vec4f,
  // x fog near, y fog far, z fog amount, w unused.
  fog: vec4f,
  // x sun specular power, y sun specular magnitude, z sun sparkle power, w sparkle magnitude.
  sun: vec4f,
  // Per noise layer (xyz): wind direction (radians), speed, UV scale, amplitude.
  windDirection: vec4f,
  windSpeed: vec4f,
  uvScale: vec4f,
  amplitude: vec4f,
  // Rivers: the cell's flow map covers x..x+4096, y..y+4096 (xy); z = 1 if there is one.
  flow: vec4f,
};

@group(2) @binding(6) var<uniform> water: WaterParams;
@group(2) @binding(7) var waterSampler: sampler;
@group(2) @binding(8) var noise0: texture_2d<f32>;
@group(2) @binding(9) var noise1: texture_2d<f32>;
@group(2) @binding(10) var noise2: texture_2d<f32>;
// Flow map: rg = flow direction (east, north), a = 1 - strength; row 0 is the north edge.
@group(2) @binding(11) var flowMap: texture_2d<f32>;

struct WaterFrame {
  horizon: vec4f,
  lower: vec4f,
  upper: vec4f,
  // Weather water multiplier (rgb).
  multiplier: vec4f,
  // 1 / width, 1 / height, 1 if there is a sky, unused.
  screen: vec4f,
  // Sky dome weights by elevation: horizon, lower, upper, alpha.
  profile: array<vec4f, 32>,
  // Rings spreading on the water (water-ripples.ts): x, y, age (seconds), strength (0: none).
  ripples: array<vec4f, 16>,
};

// Rings from splashes and wakes (water-ripples.ts): how fast their front spreads (units a
// second), their wavelength and the width of the wave packet around the front (units), and how
// long they last (seconds, RIPPLE_LIFETIME).
const RIPPLE_SPEED = 80.0;
const RIPPLE_WAVELENGTH = 22.0;
const RIPPLE_WIDTH = 28.0;
const RIPPLE_LIFETIME = 2.5;

// The surface's slope from the rings at a point.
fn rippleSlope(position: vec2f) -> vec2f {
  var slope = vec2f(0.0);
  for (var i = 0u; i < 16u; i++) {
    let ring = waterFrame.ripples[i];
    if (ring.w <= 0.0) {
      continue;
    }
    let offset = position - ring.xy;
    let d = length(offset);
    let x = d - ring.z * RIPPLE_SPEED;
    let envelope = exp(-x * x / (2.0 * RIPPLE_WIDTH * RIPPLE_WIDTH)) *
      (1.0 - clamp(ring.z / RIPPLE_LIFETIME, 0.0, 1.0)) * ring.w;
    let wave = cos(x * 6.2831853 / RIPPLE_WAVELENGTH);
    slope += offset / max(d, 1e-3) * wave * envelope * 0.6;
  }
  return slope;
}

// The opaque scene's colour and depth come from the frame group (sceneColor, sceneDepth).
@group(3) @binding(0) var<uniform> waterFrame: WaterFrame;

fn skyColorAt(direction: vec3f) -> vec3f {
  let elevation = asin(clamp(direction.z, 0.0, 1.0));
  let s = elevation / 1.5707964 * 31.0;
  let i = min(u32(floor(s)), 30u);
  let w = mix(waterFrame.profile[i], waterFrame.profile[i + 1u], fract(s));
  return waterFrame.horizon.rgb * w.x + waterFrame.lower.rgb * w.y + waterFrame.upper.rgb * w.z;
}

// World units a river's surface moves per second at full flow strength.
const FLOW_SPEED = 160.0;
// Seconds between restarts of the flow offset (two phases hide the jump).
const FLOW_PERIOD = 4.0;

// One noise layer's normal (tangent space, z up), weighted by its amplitude, at a position
// moved by `offset` world units (river flow).
fn layerNormal(layer: u32, position: vec2f, offset: vec2f, time: f32) -> vec3f {
  let angle = water.windDirection[layer];
  let wind = vec2f(cos(angle), sin(angle)) * water.windSpeed[layer] * time;
  let uv = (position - offset) / max(water.uvScale[layer], 1.0) + wind;
  var n: vec3f;
  switch (layer) {
    case 0u: { n = textureSample(noise0, waterSampler, uv).xyz; }
    case 1u: { n = textureSample(noise1, waterSampler, uv).xyz; }
    default: { n = textureSample(noise2, waterSampler, uv).xyz; }
  }
  return (n * 2.0 - 1.0) * water.amplitude[layer];
}

fn sceneDepthAt(uv: vec2f) -> f32 {
  let size = vec2f(textureDimensions(sceneDepth));
  let pixel = vec2u(clamp(uv * size, vec2f(0.0), size - 1.0));
  return textureLoad(sceneDepth, pixel, 0).r;
}

// Screen-space reflection: marches the reflected ray and returns the scene where it passes
// behind something (rgb, a = hit), or no hit. A ray that leaves the screen takes what stands
// at the edge where it left (the shore's trees and hills above the view), half weighted; past
// an edge of sky it finds nothing and the sky stays.
fn screenReflection(origin: vec3f, direction: vec3f) -> vec4f {
  var distance = 64.0;
  var onScreen = false;
  for (var i = 0; i < 24; i++) {
    let p = origin + direction * distance;
    let clip = frame.viewProj * vec4f(p, 1.0);
    if (clip.w <= 0.0) {
      break;
    }
    let ndc = clip.xyz / clip.w;
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
      let edge = clamp(uv, vec2f(0.0), vec2f(1.0));
      // Reversed Z: the sky (cleared depth) is 0.
      if (onScreen && sceneDepthAt(edge) > 0.0) {
        return vec4f(textureSampleLevel(sceneColor, screenSampler, edge, 0.0).rgb, 0.5);
      }
      break;
    }
    onScreen = true;
    let scene = sceneDepthAt(uv);
    // Reversed Z: the scene is in front of the ray point when its depth is larger.
    if (scene > ndc.z && scene - ndc.z < 0.5 * ndc.z) {
      let fade = smoothstep(1.0, 0.8, max(abs(ndc.x), abs(ndc.y)));
      return vec4f(textureSampleLevel(sceneColor, screenSampler, uv, 0.0).rgb, fade);
    }
    distance *= 1.35;
  }
  return vec4f(0.0);
}

@fragment
fn fs_water(input: VertexOut) -> @location(0) vec4f {
  // LOD water (WaterShaderFlag lod) gives way to the cell water of loaded cells.
  if ((draw.flags.w & 0x2u) != 0u && lodHidden(input.worldPos)) {
    discard;
  }
  let time = frame.time.x;
  let toCamera = frame.cameraPos.xyz - input.worldPos;
  let distance = length(toCamera);
  let view = toCamera / max(distance, 1e-3);

  // Normal: the noise layers' normals weighted by amplitude, calming down with distance.
  var sum = vec3f(0.0);
  if (water.flow.z > 0.5) {
    // Rivers: the waves travel along the flow map, in two phases half a period apart.
    let local = (input.worldPos.xy - water.flow.xy) / 4096.0;
    let flowTexel = textureSampleLevel(flowMap, waterSampler, vec2f(local.x, 1.0 - local.y), 0.0);
    let direction = normalize(flowTexel.rg * 2.0 - 1.0 + vec2f(1e-4, 0.0));
    let velocity = direction * (1.0 - flowTexel.a) * FLOW_SPEED * water.surface.w;
    let phase0 = fract(time / FLOW_PERIOD);
    let phase1 = fract(time / FLOW_PERIOD + 0.5);
    let blend = abs(phase0 * 2.0 - 1.0);
    for (var layer = 0u; layer < 3u; layer++) {
      let a = layerNormal(layer, input.worldPos.xy, velocity * phase0 * FLOW_PERIOD, time);
      let b = layerNormal(layer, input.worldPos.xy, velocity * phase1 * FLOW_PERIOD, time);
      sum += mix(a, b, blend);
    }
  } else {
    for (var layer = 0u; layer < 3u; layer++) {
      sum += layerNormal(layer, input.worldPos.xy, vec2f(0.0), time);
    }
  }
  let combined = sum / max(sum.z, 1e-3);
  let slope = combined.xy * clamp(water.surface.z / max(distance, 1.0), 0.15, 1.0) +
    rippleSlope(input.worldPos.xy);
  let normal = normalize(vec3f(slope, 1.0));

  // Refraction: the scene below, shifted by the waves where that is still under the water.
  let invSize = waterFrame.screen.xy;
  let screenUv = input.position.xy * invSize;
  let waterDepth = input.position.z;
  var refractUv = screenUv + slope * water.surface.x * invSize;
  if (sceneDepthAt(refractUv) > waterDepth) {
    refractUv = screenUv;
  }
  let below = textureSampleLevel(sceneColor, screenSampler, refractUv, 0.0).rgb;
  let belowDepth = sceneDepthAt(refractUv);
  // Distance the view ray travels through the water (depths are near / view z).
  let thickness = select(1e6, distance * (waterDepth / belowDepth - 1.0), belowDepth > 0.0);
  let fogRange = max(water.fog.y - water.fog.x, 1.0);
  let fog = clamp((thickness - water.fog.x) / fogRange, 0.0, 1.0) * water.fog.z;
  let multiplier = waterFrame.multiplier.rgb;
  let waterColor = mix(water.shallow.rgb, water.deep.rgb, fog) * multiplier;
  let underwater = mix(below, waterColor, fog);

  // Reflection: the scene where the ray finds it, else the sky, tinted by the water.
  let reflected = reflect(-view, normal);
  var reflection = mix(skyColorAt(reflected), water.reflection.rgb * multiplier, water.surface.y);
  let hit = screenReflection(input.worldPos, reflected);
  reflection = mix(reflection, hit.rgb, hit.a);
  let facing = clamp(dot(normal, view), 0.0, 1.0);
  let fresnel = water.reflection.a + (1.0 - water.reflection.a) * pow(1.0 - facing, 5.0);
  var color = mix(underwater, reflection, clamp(fresnel * water.deep.a, 0.0, 1.0));

  // The sun on the waves: a sharp specular highlight and sparkles.
  let toSun = frame.sunDir.xyz;
  let halfway = normalize(toSun + view);
  let nDotH = max(dot(normal, halfway), 0.0);
  let specular = pow(nDotH, max(water.sun.x, 1.0)) * water.sun.y;
  let sparkle = pow(nDotH, max(water.sun.z, 1.0)) * water.sun.w;
  color += frame.sunColor.rgb * (specular + sparkle) * step(0.0, toSun.z);

  return vec4f(applyFog(color, input.worldPos), 1.0);
}
