// Per-frame data shared by every world shader (objects, terrain, water): camera, the
// directional light and its cascaded shadow maps, directional ambient, fog and point lights.
// Prepended to each shader module in TypeScript. ASCII only.

struct Frame {
  viewProj: mat4x4f,
  cameraPos: vec4f,
  // Direction towards the directional light (normalized) and its colour.
  sunDir: vec4f,
  sunColor: vec4f,
  // Directional ambient: light arriving from +X, -X, +Y, -Y, +Z, -Z (rgb). In w: the ambient
  // specular colour (+X, -X, +Y), its fresnel power (-Y), the character light's primary and
  // secondary intensity (+Z, -Z).
  ambient: array<vec4f, 6>,
  fogNearColor: vec4f,
  fogFarColor: vec4f,
  // Fog near, far, power, max.
  fogParams: vec4f,
  // Point light count, fog enabled, debug view, unused.
  counts: vec4u,
  // Time in seconds, wind strength (0..1), the character light's luminance scale and maximum.
  time: vec4f,
  // Distant LOD is hidden in loaded cells: south-west cell of a 7x7 grid (xy) and one bit per
  // cell, row by row from the south-west (zw: bits 0-31, 32-48).
  lodMask: vec4i,
  // Sun shadows: light view-projection of each cascade, the distance where each ends, and
  // x: on, y: map size (texels), z: depth bias, w: normal offset in texels.
  shadowMatrices: array<mat4x4f, 4>,
  shadowSplits: vec4f,
  shadowParams: vec4f,
  // 1 / width, 1 / height of the target, the camera's near plane, unused.
  screen: vec4f,
  // The camera's right and up axes in world space (camera-facing quads).
  cameraRight: vec4f,
  cameraUp: vec4f,
  // Clip space back to world space (screen-space decals).
  inverseViewProj: mat4x4f,
  // The first-person geometry's view-projection (the player's arms and what they hold): the
  // same view with first person's own field of view and near plane (common.wgsl).
  firstPersonViewProj: mat4x4f,
};

struct PointLight {
  position: vec3f,
  radius: f32,
  color: vec3f,
  // A spot light's cone: the cosine of half its angle (below -1: no cone, it lights every
  // way) and its axis.
  coneCos: f32,
  coneAxis: vec3f,
  // A portal-strict light's room (0: it lights every room).
  room: f32,
  // x: its slot of the light-shadow map (below 0: it casts no shadow this frame), y: how much
  // of its shadow shows (fading in and out of the shadow lights).
  shadow: vec4f,
};

// The shadow lights' maps (light-shadows.ts): six layers per slot, each with the matrix it was
// rendered with; per slot near, far, omni (1: a cube, 0: one frustum) and the world size of a
// texel at distance 1; then the map size, the bias along the light (world units) and along the
// normal (texels). Then the sun's focus maps (focus-shadows.ts): each one's matrix, its texel
// size (world units) and depth bias (x, y), and their count (focusParams.x).
struct LightShadows {
  matrices: array<mat4x4f, 24>,
  slots: array<vec4f, 4>,
  params: vec4f,
  focusMatrices: array<mat4x4f, 4>,
  focusInfo: array<vec4f, 4>,
  focusParams: vec4f,
};

// The layer of the sun's shadow map that holds the focus maps, one per quarter.
const FOCUS_LAYER = 5;

// Whether a portal-strict light leaves a draw of another room unlit (`room`: the draw's room,
// 0 none).
fn lightOtherRoom(light: PointLight, room: u32) -> bool {
  return light.room > 0.5 && room != 0u && u32(light.room + 0.5) != room;
}

// How much of a light reaches a point by its cone: a spot light (the engine's shadow
// spotlights: sunbeams through a ceiling) lights only within its cone, its edge softened over
// a tenth of the rest of the cosine range. `offset`: from the point to the light.
// TODO(M13): the engine's spot edge (its shadow map's frustum) and what stands in the beam.
fn lightCone(light: PointLight, offset: vec3f) -> f32 {
  if (light.coneCos < -1.0) {
    return 1.0;
  }
  let along = dot(-safeNormalize(offset), light.coneAxis);
  return smoothstep(light.coneCos, mix(light.coneCos, 1.0, 0.1), along);
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> pointLights: array<PointLight>;
@group(0) @binding(2) var shadowMap: texture_depth_2d_array;
@group(0) @binding(3) var shadowSampler: sampler_comparison;
// Copies of the opaque scene (colour and linear-ish depth) for soft effects and refraction.
@group(0) @binding(4) var sceneColor: texture_2d<f32>;
@group(0) @binding(5) var sceneDepth: texture_2d<f32>;
@group(0) @binding(6) var screenSampler: sampler;
@group(0) @binding(7) var<uniform> lightShadows: LightShadows;
@group(0) @binding(8) var lightShadowMap: texture_depth_2d_array;

// How much of a shadow light reaches a point (0 in shadow, 1 lit), faded by how much of its
// shadow shows: the cube face (omni) or the one frustum (spot, hemisphere) that holds the point,
// sampled 3x3. The receiver's distance along the view, less the bias, is compared as the depth
// the map stores; points outside a single frustum are lit.
fn pointShadow(light: PointLight, worldPos: vec3f, n: vec3f) -> f32 {
  if (light.shadow.x < 0.0 || light.shadow.y <= 0.0) {
    return 1.0;
  }
  let slot = min(u32(light.shadow.x + 0.5), 3u);
  let info = lightShadows.slots[slot];
  let v = worldPos - light.position;
  var face = 0u;
  if (info.z > 0.5) {
    let a = abs(v);
    if (a.x >= a.y && a.x >= a.z) {
      face = select(1u, 0u, v.x > 0.0);
    } else if (a.y >= a.z) {
      face = select(3u, 2u, v.y > 0.0);
    } else {
      face = select(5u, 4u, v.z > 0.0);
    }
  }
  let layer = slot * 6u + face;
  let texelWorld = length(v) * info.w;
  let offset = n * texelWorld * lightShadows.params.z;
  let clip = lightShadows.matrices[layer] * vec4f(worldPos + offset, 1.0);
  if (clip.w <= info.x || clip.w >= info.y) {
    return 1.0;
  }
  let ndc = clip.xy / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (info.z < 0.5 && (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)))) {
    return 1.0;
  }
  let along = max(clip.w - lightShadows.params.y - texelWorld, info.x);
  let depth = (info.y / (info.y - info.x)) * (1.0 - info.x / along);
  let texel = 1.0 / lightShadows.params.x;
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let at = uv + vec2f(f32(x), f32(y)) * texel;
      lit += textureSampleCompareLevel(lightShadowMap, shadowSampler, at, i32(layer), depth);
    }
  }
  return mix(1.0, lit / 9.0, light.shadow.y);
}

// View distance of a reversed-Z depth value (infinite far plane: depth = near / distance).
fn viewDistance(depth: f32) -> f32 {
  return frame.screen.z / max(depth, 1e-9);
}

// Distance from a fragment to the opaque scene behind it (large where nothing is behind).
fn depthToScene(fragCoord: vec4f) -> f32 {
  let size = vec2i(textureDimensions(sceneDepth));
  let pixel = clamp(vec2i(fragCoord.xy), vec2i(0), size - 1);
  let scene = textureLoad(sceneDepth, pixel, 0).r;
  return viewDistance(scene) - viewDistance(fragCoord.z);
}

// How much of the sun reaches a point (0 in shadow, 1 lit): a focus map that holds it (sharp
// shadows round the bodies near the player), the cascades fading in over its square's outer
// tenth and taking over outside it.
fn sunShadow(worldPos: vec3f, n: vec3f) -> f32 {
  if (frame.shadowParams.x < 0.5) {
    return 1.0;
  }
  let focus = focusShadow(worldPos, n);
  if (focus.y >= 1.0) {
    return focus.x;
  }
  return mix(cascadeShadow(worldPos, n), focus.x, focus.y);
}

// The first focus map whose view holds a point: how lit it is (x, sampled 3x3 within its
// quarter of the layer) and how much it counts (y: 1 inside, 0 at and beyond its square's edge).
fn focusShadow(worldPos: vec3f, n: vec3f) -> vec2f {
  let count = min(u32(lightShadows.focusParams.x + 0.5), 4u);
  for (var i = 0u; i < count; i++) {
    let info = lightShadows.focusInfo[i];
    let offset = n * info.x * frame.shadowParams.w;
    let clip = lightShadows.focusMatrices[i] * vec4f(worldPos + offset, 1.0);
    let edge = max(abs(clip.x), abs(clip.y));
    if (edge >= 1.0 || clip.z < 0.0 || clip.z > 1.0) {
      continue;
    }
    let quarter = vec2f(f32(i % 2u), f32(i / 2u)) * 0.5;
    let uv = quarter + vec2f(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5) * 0.5;
    let texel = 1.0 / frame.shadowParams.y;
    let low = quarter + vec2f(texel);
    let high = quarter + vec2f(0.5 - texel);
    let depth = clip.z - info.y;
    var lit = 0.0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let at = clamp(uv + vec2f(f32(x), f32(y)) * texel, low, high);
        lit += textureSampleCompareLevel(shadowMap, shadowSampler, at, FOCUS_LAYER, depth);
      }
    }
    return vec2f(lit / 9.0, clamp((1.0 - edge) * 10.0, 0.0, 1.0));
  }
  return vec2f(1.0, 0.0);
}

// How much of the sun reaches a point by the cascades: the first cascade that holds it,
// sampled 3x3 with a small offset along the normal against acne, fading out at the end of the
// shadow distance.
fn cascadeShadow(worldPos: vec3f, n: vec3f) -> f32 {
  let distance = length(worldPos - frame.cameraPos.xyz);
  var cascade = 4u;
  for (var i = 0u; i < 4u; i++) {
    if (distance < frame.shadowSplits[i]) {
      cascade = i;
      break;
    }
  }
  if (cascade >= 4u) {
    return 1.0;
  }
  let far = frame.shadowSplits[cascade];
  let near = select(0.0, frame.shadowSplits[max(cascade, 1u) - 1u], cascade > 0u);
  let texelWorld = 2.0 * (far - near) / frame.shadowParams.y;
  let offset = n * texelWorld * frame.shadowParams.w;
  let clip = frame.shadowMatrices[cascade] * vec4f(worldPos + offset, 1.0);
  let uv = vec2f(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || clip.z > 1.0) {
    return 1.0;
  }
  let depth = clip.z - frame.shadowParams.z;
  let texel = 1.0 / frame.shadowParams.y;
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let at = uv + vec2f(f32(x), f32(y)) * texel;
      lit += textureSampleCompareLevel(shadowMap, shadowSampler, at, cascade, depth);
    }
  }
  lit /= 9.0;
  // The last cascade fades out over its last tenth.
  let fade = select(0.0, clamp((distance - far * 0.9) / (far * 0.1), 0.0, 1.0), cascade == 3u);
  return mix(lit, 1.0, fade);
}

// Whether distant LOD at this position is covered by a loaded cell.
fn lodHidden(worldPos: vec3f) -> bool {
  let cell = vec2i(floor(worldPos.xy / 4096.0)) - frame.lodMask.xy;
  if (any(cell < vec2i(0)) || any(cell >= vec2i(7))) {
    return false;
  }
  let bit = u32(cell.y * 7 + cell.x);
  let word = select(bitcast<u32>(frame.lodMask.z), bitcast<u32>(frame.lodMask.w), bit >= 32u);
  return ((word >> (bit % 32u)) & 1u) != 0u;
}

fn safeNormalize(v: vec3f) -> vec3f {
  let len = length(v);
  return select(vec3f(0.0, 0.0, 1.0), v / len, len > 1e-6);
}

// Ambient light for a world-space normal, blended from the six directional ambient colours.
fn directionalAmbient(n: vec3f) -> vec3f {
  let w = n * n;
  let x = select(frame.ambient[1].rgb, frame.ambient[0].rgb, n.x >= 0.0);
  let y = select(frame.ambient[3].rgb, frame.ambient[2].rgb, n.y >= 0.0);
  let z = select(frame.ambient[5].rgb, frame.ambient[4].rgb, n.z >= 0.0);
  return x * w.x + y * w.y + z * w.z;
}

struct Lighting {
  diffuse: vec3f,
  specular: vec3f,
};

// Ambient and the directional light (times `shadow`: 1 lit, 0 in shadow), without point lights
// (the engine's grass: [Grass] bGrassPointLighting is off by default).
fn sunLightAt(n: vec3f, toCamera: vec3f, glossiness: f32, specular: bool, shadow: f32) -> Lighting {
  var result: Lighting;
  let toSun = frame.sunDir.xyz;
  let sunNDotL = max(dot(n, toSun), 0.0) * shadow;
  result.diffuse = directionalAmbient(n) + frame.sunColor.rgb * sunNDotL;
  result.specular = vec3f(0.0);
  if (specular && sunNDotL > 0.0) {
    let halfway = safeNormalize(toSun + toCamera);
    result.specular += frame.sunColor.rgb * pow(max(dot(n, halfway), 0.0), glossiness) * shadow;
  }
  return result;
}

// Ambient, the directional light and point lights (brightness falls off as 1 - d^2/r^2): land,
// tree LOD and decals, which take every light of the frame. Objects light by their own lists
// (lighting.wgsl, light-lists.ts). TODO(M13): the engine's land gets per-quad lists too (and
// only lights flagged to affect land reach it).
fn lightAt(
  n: vec3f,
  worldPos: vec3f,
  toCamera: vec3f,
  glossiness: f32,
  specular: bool,
  shadow: f32,
) -> Lighting {
  var result = sunLightAt(n, toCamera, glossiness, specular, shadow);
  for (var i = 0u; i < frame.counts.x; i++) {
    let light = pointLights[i];
    let offset = light.position - worldPos;
    let distanceSquared = dot(offset, offset);
    let radiusSquared = light.radius * light.radius;
    if (distanceSquared >= radiusSquared) {
      continue;
    }
    let toLight = offset * inverseSqrt(max(distanceSquared, 1e-4));
    let attenuation = (1.0 - distanceSquared / radiusSquared) * lightCone(light, offset) *
      pointShadow(light, worldPos, n);
    let nDotL = max(dot(n, toLight), 0.0);
    result.diffuse += light.color * nDotL * attenuation;
    if (specular && nDotL > 0.0) {
      let halfway = safeNormalize(toLight + toCamera);
      result.specular += light.color * pow(max(dot(n, halfway), 0.0), glossiness) * attenuation;
    }
  }
  return result;
}

// Fog at a point: how much of the fog colour covers it, and that colour.
fn fogAt(worldPos: vec3f) -> vec4f {
  if (frame.counts.y == 0u) {
    return vec4f(0.0);
  }
  let distance = length(worldPos - frame.cameraPos.xyz);
  let near = frame.fogParams.x;
  let far = max(frame.fogParams.y, near + 1.0);
  let t = clamp((distance - near) / (far - near), 0.0, 1.0);
  let amount = min(pow(t, max(frame.fogParams.z, 0.01)), select(1.0, frame.fogParams.w, frame.fogParams.w > 0.0));
  return vec4f(mix(frame.fogNearColor.rgb, frame.fogFarColor.rgb, t), amount);
}

// Fog: blends from the near to the far colour with distance.
fn applyFog(color: vec3f, worldPos: vec3f) -> vec3f {
  let fog = fogAt(worldPos);
  return mix(color, fog.rgb, fog.a);
}

// The world-space normal in octahedral encoding (the G-buffer's rg).
fn octahedralEncode(n: vec3f) -> vec2f {
  let p = n.xy / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6);
  let signs = select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0));
  return select(p, (1.0 - abs(p.yx)) * signs, n.z < 0.0);
}

fn octahedralDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    let signs = select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
    n = vec3f((1.0 - abs(n.yx)) * signs, n.z);
  }
  return safeNormalize(n);
}

// The G-buffer (gbuffer.ts) of a surface the composite finishes (composite.wgsl): the normal
// (rg), the snow mask (b, the engine's SnowParameters.y) and 1 + the snow's specular (a: the
// rim light, SnowParameters.x), which the composite adds with the AO, fog and sparkles.
fn gbufferValue(n: vec3f, snowMask: f32, snowSpecular: f32) -> vec4f {
  return vec4f(octahedralEncode(n), snowMask, 1.0 + max(snowSpecular, 0.0));
}

// The G-buffer of a surface its own shader finished (lit, fogged): the composite and the
// snow's scattering leave it alone (a = 0, no snow).
fn gbufferFinished(n: vec3f) -> vec4f {
  return vec4f(octahedralEncode(n), 0.0, 0.0);
}
