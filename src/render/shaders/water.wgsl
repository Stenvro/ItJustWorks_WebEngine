// Water surfaces (cell water planes and BSWaterShaderProperty meshes), with the original water
// shader's terms (docs/rendering.md "Water"): three noise layers and the displacement field
// (water-displacement.ts) for the normal, refraction of the scene below with depth fog towards
// the water's shallow and deep colours, the reflection cube (water-reflection.ts) with the
// screen-space reflections over it, Schlick's fresnel, the sun's specular and the sparkle; the
// water's depth properties take each of them back where the water is shallow. Drawn after the
// opaque scene, whose colour and depth are copied for it. Prepended with frame.wgsl and
// common.wgsl. ASCII only.

struct WaterParams {
  // Shallow colour (rgb), opacity (a).
  shallow: vec4f,
  // Deep colour (rgb), reflectivity (a).
  deep: vec4f,
  // Reflection colour (rgb), fresnel (a).
  reflection: vec4f,
  // x refraction magnitude, y reflection magnitude, z noise falloff, w flowmap scale.
  surface: vec4f,
  // x fog near, y fog far, z fog amount, w displacement dampener (how much the field shows).
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
  // Depth properties: how much of the reflections, refraction, normals and sun specular
  // shallow water loses.
  depth: vec4f,
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
  // 1 / width, 1 / height, 1 if there is a sky, 1 if the reflection cube holds this frame's
  // reflections.
  screen: vec4f,
  // Sky dome weights by elevation: horizon, lower, upper, alpha.
  profile: array<vec4f, 32>,
  // The displacement field's grid: its centre (xy), 1 / its width (z), 1 while it runs (w).
  displacement: vec4f,
  // The reflection's faces (+X, -X, +Y, -Y, +Z): each one's rotation and projection from its
  // centre, to look a direction up in them (water-reflection.ts).
  faces: array<mat4x4f, 5>,
};

// The opaque scene's colour and depth come from the frame group (sceneColor, sceneDepth).
@group(3) @binding(0) var<uniform> waterFrame: WaterFrame;
// The displacement field's slopes per texel (rg) over the grid (water-displacement-gpu.ts).
@group(3) @binding(1) var displacementSlopes: texture_2d<f32>;
// What the water reflects (water-reflection.ts): the scene seen from the camera mirrored under
// the water's plane, one layer per cube face, looked up by the reflected view direction.
@group(3) @binding(2) var reflectionFaces: texture_2d_array<f32>;

// The reflection along a direction: the face of its largest axis (no face looks down; the lower
// directions take the side faces' bottom rows).
fn reflectionAt(direction: vec3f) -> vec3f {
  let a = abs(direction);
  var face = 4u;
  if (direction.z < 0.0 || max(a.x, a.y) > a.z) {
    face = select(select(3u, 2u, direction.y >= 0.0), select(1u, 0u, direction.x >= 0.0), a.x >= a.y);
  }
  let clip = waterFrame.faces[face] * vec4f(direction, 1.0);
  let ndc = clamp(clip.xy / max(clip.w, 1e-4), vec2f(-1.0), vec2f(1.0));
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  return textureSampleLevel(reflectionFaces, screenSampler, uv, face, 0.0).rgb;
}

// The field's slope per texel to the normal's tilt (TODO(M13): the original's scale).
const DISPLACEMENT_SLOPE = 2.0;

// The tilt the displacement field gives the surface at a point, as much as the water type's
// dampener lets it show; nothing off the grid (it fades out towards its edges).
fn displacementSlope(position: vec2f) -> vec2f {
  let grid = waterFrame.displacement;
  if (grid.w < 0.5 || water.fog.w <= 0.0) {
    return vec2f(0.0);
  }
  let uv = (position - grid.xy) * grid.z + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  if (edge <= 0.0) {
    return vec2f(0.0);
  }
  let slopes = textureSampleLevel(displacementSlopes, screenSampler, uv, 0.0).xy;
  return -slopes * DISPLACEMENT_SLOPE * water.fog.w * smoothstep(0.0, 0.05, edge);
}

fn skyColorAt(direction: vec3f) -> vec3f {
  let elevation = asin(clamp(direction.z, 0.0, 1.0));
  let s = elevation / 1.5707964 * 31.0;
  let i = min(u32(floor(s)), 30u);
  let w = mix(waterFrame.profile[i], waterFrame.profile[i + 1u], fract(s));
  return waterFrame.horizon.rgb * w.x + waterFrame.lower.rgb * w.y + waterFrame.upper.rgb * w.z;
}

// The share of reflections, refraction, normals and specular (xyzw) the water keeps at a depth
// (0 at the shore, 1 deep): all deep down, the depth properties' share less at the shore
// (water-color.ts depthControl).
fn waterDepthControl(properties: vec4f, deepness: vec4f) -> vec4f {
  return properties * (saturate(deepness) - 1.0) + 1.0;
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

// The sparkle's fixed direction: the original lights its sparkle from a slant of the up axis,
// not from the sun (pow(saturate(dot(normal, d)), sparkle power)).
const SPARKLE_DIRECTION = vec3f(-0.099, -0.099, 0.99);
// Distance where the noise's detail has faded to its floor (the original's 8192 units).
const DETAIL_FADE_END = 8192.0;
// The detail's floor past that distance. TODO(M13): a per-frame value the original keeps in its
// shared constants, unread; 0 lets distant water show only its first noise layer, mirror-like.
const DETAIL_FLOOR = 0.0;

// A view-space distance from the camera along `view` (the unit vector from the camera) to the
// opaque scene at a screen position: depths are near / view z (reversed Z, infinite far).
fn sceneDistanceAt(uv: vec2f, distance: f32, waterDepth: f32) -> f32 {
  let d = sceneDepthAt(uv);
  return select(1e6, distance * waterDepth / d, d > 0.0);
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
  let fogNear = water.fog.x;
  let fogFar = max(water.fog.y, 1e-3);

  // How deep the water is here: the way the view ray goes through it to the scene below (for
  // the reflections and refraction) and how far that scene lies under the surface (for the
  // normals and specular), each as a share of the fog's far distance; the depth properties
  // take their part away where the water is shallow.
  let invSize = waterFrame.screen.xy;
  let screenUv = input.position.xy * invSize;
  let waterDepth = input.position.z;
  let rayDepth = max(sceneDistanceAt(screenUv, distance, waterDepth) - distance, 0.0);
  let verticalDepth = rayDepth * abs(view.z);
  let depthControl = waterDepthControl(
    water.depth,
    vec4f(rayDepth, rayDepth, verticalDepth, verticalDepth) / fogFar,
  );
  // Near the camera the noise shows in full; it fades to its floor at DETAIL_FADE_END, from the
  // water's noise falloff distance where that is nearer.
  let detail = saturate(
    (distance - DETAIL_FADE_END) / min(water.surface.z - DETAIL_FADE_END, -1.0) * (1.0 - DETAIL_FLOOR) +
      DETAIL_FLOOR,
  );

  // Normal: the first layer by its amplitude around the up axis, the other two added by
  // theirs, flattened by the normals' depth property; rivers take their flow's waves over it,
  // the displacement field's ripples bend it, and far away only the first layer stays.
  var first = vec3f(0.0, 0.0, 1.0);
  var waves = vec3f(0.0);
  if (water.flow.z > 0.5) {
    // Rivers: the waves travel along the flow map, in two phases half a period apart.
    // TODO(M13): the original samples WATR NAM5's flow-normal texture on a staggered grid of
    // the flow map from per-geometry constants that are unread; ours moves the noise layers.
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
      let n = mix(a, b, blend);
      waves += n;
      if (layer == 0u) {
        first = n;
      }
    }
  } else {
    for (var layer = 0u; layer < 3u; layer++) {
      let n = layerNormal(layer, input.worldPos.xy, vec2f(0.0), time);
      waves += n;
      if (layer == 0u) {
        first = n;
      }
    }
  }
  // layerNormal weighs each layer by its amplitude; the first keeps the rest of the up axis.
  waves += vec3f(0.0, 0.0, 1.0 - water.amplitude.x);
  let up = vec3f(0.0, 0.0, 1.0);
  var normal = safeNormalize(mix(up, safeNormalize(waves), depthControl.z));
  let firstNormal = select(up, first / water.amplitude.x, water.amplitude.x > 0.0);
  normal = safeNormalize(mix(firstNormal, normal, detail));
  // The ripples: the field's tilt as a normal, the waves' normal taken over by how flat it is.
  let ripple = normalize(vec3f(displacementSlope(input.worldPos.xy), 1.0));
  normal = normalize(mix(ripple, normal, ripple.z));

  // Refraction: the scene below the surface point moved along the normal by the refraction
  // magnitude (world units, less in shallow water), unless what lies there is above the water.
  let shifted = vec3f(input.worldPos.xy + normal.xy * water.surface.x * depthControl.y, input.worldPos.z);
  let clip = frame.viewProj * vec4f(shifted, 1.0);
  var refractUv = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
  if (clip.w <= 0.0 || sceneDepthAt(refractUv) > waterDepth) {
    refractUv = screenUv;
  }
  let below = textureSampleLevel(sceneColor, screenSampler, refractUv, 0.0).rgb;
  // The water's body: shallow towards deep colour over the fog's far distance; the fog
  // 1 - ((far - depth) / (far - near))^amount covers the scene below with it.
  let multiplier = waterFrame.multiplier.rgb;
  let deep = saturate(rayDepth / fogFar);
  let body = mix(water.shallow.rgb, water.deep.rgb, deep) * multiplier;
  let clear = saturate((fogFar - min(rayDepth, fogFar)) / max(fogFar - fogNear, 1e-3));
  let fog = 1.0 - pow(clear, max(water.fog.z, 1e-3));
  let refracted = mix(below, body, fog);

  // Reflection: the reflection cube (else the sky) by the view reflected about the normal
  // flattened towards the up axis by the reflectivity, the screen-space reflection over it
  // where it finds the scene, then the reflection colour taken over by it by the reflection
  // magnitude.
  let reflectNormal = mix(up, normal, water.deep.a);
  let reflected = reflect(-view, reflectNormal);
  var environment = skyColorAt(reflected);
  if (waterFrame.screen.w > 0.5) {
    environment = reflectionAt(reflected);
  }
  let hit = screenReflection(input.worldPos, reflect(-view, normal));
  let scene = mix(environment, hit.rgb, saturate(detail * hit.a));
  let reflection = mix(water.reflection.rgb * multiplier, scene, water.surface.y);
  // Schlick's fresnel from the Fresnel Amount, less in shallow water; far away the reflection
  // takes over.
  let facing = saturate(dot(view, normal));
  let fresnel = water.reflection.a + (1.0 - water.reflection.a) * pow(1.0 - facing, 5.0);
  let share = mix(1.0, fresnel * depthControl.x, detail);
  var color = mix(refracted, reflection, share);

  // The sun's specular along the reflected view, and the sparkle; less in shallow water.
  let specular = pow(saturate(dot(reflect(-view, normal), frame.sunDir.xyz)), max(water.sun.x, 1.0)) *
    water.sun.y;
  let sparkle = pow(saturate(dot(normal, SPARKLE_DIRECTION)), max(water.sun.z, 1.0)) *
    water.sun.w;
  color += frame.sunColor.rgb * (specular + sparkle) * depthControl.w;

  return vec4f(applyFog(color, input.worldPos), 1.0);
}
