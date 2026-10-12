// Per-frame data shared by every world shader (objects, terrain, water): camera, the
// directional light and its cascaded shadow maps, directional ambient, fog and point lights.
// Prepended to each shader module in TypeScript. ASCII only.

struct Frame {
  viewProj: mat4x4f,
  cameraPos: vec4f,
  // Direction towards the directional light (normalized) and its colour.
  sunDir: vec4f,
  sunColor: vec4f,
  // Directional ambient: light arriving from +X, -X, +Y, -Y, +Z, -Z.
  ambient: array<vec4f, 6>,
  fogNearColor: vec4f,
  fogFarColor: vec4f,
  // Fog near, far, power, max.
  fogParams: vec4f,
  // Point light count, fog enabled, debug view, unused.
  counts: vec4u,
  // Time in seconds, wind strength (0..1), unused.
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
};

struct PointLight {
  position: vec3f,
  radius: f32,
  color: vec3f,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> pointLights: array<PointLight>;
@group(0) @binding(2) var shadowMap: texture_depth_2d_array;
@group(0) @binding(3) var shadowSampler: sampler_comparison;
// Copies of the opaque scene (colour and linear-ish depth) for soft effects and refraction.
@group(0) @binding(4) var sceneColor: texture_2d<f32>;
@group(0) @binding(5) var sceneDepth: texture_2d<f32>;
@group(0) @binding(6) var screenSampler: sampler;

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

// How much of the sun reaches a point (0 in shadow, 1 lit): the first cascade that holds
// it, sampled 3x3 with a small offset along the normal against acne, fading out at the end
// of the shadow distance.
fn sunShadow(worldPos: vec3f, n: vec3f) -> f32 {
  if (frame.shadowParams.x < 0.5) {
    return 1.0;
  }
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

// Ambient, the directional light (times `shadow`: 1 lit, 0 in shadow) and point lights
// (brightness falls off as 1 - d^2/r^2).
// TODO(M13): the engine's per-object light limit; shadows of interior point lights.
fn lightAt(
  n: vec3f,
  worldPos: vec3f,
  toCamera: vec3f,
  glossiness: f32,
  specular: bool,
  shadow: f32,
) -> Lighting {
  var result: Lighting;
  let toSun = frame.sunDir.xyz;
  let sunNDotL = max(dot(n, toSun), 0.0) * shadow;
  result.diffuse = directionalAmbient(n) + frame.sunColor.rgb * sunNDotL;
  result.specular = vec3f(0.0);
  if (specular && sunNDotL > 0.0) {
    let halfway = safeNormalize(toSun + toCamera);
    result.specular += frame.sunColor.rgb * pow(max(dot(n, halfway), 0.0), glossiness) * shadow;
  }
  for (var i = 0u; i < frame.counts.x; i++) {
    let light = pointLights[i];
    let offset = light.position - worldPos;
    let distanceSquared = dot(offset, offset);
    let radiusSquared = light.radius * light.radius;
    if (distanceSquared >= radiusSquared) {
      continue;
    }
    let toLight = offset * inverseSqrt(max(distanceSquared, 1e-4));
    let attenuation = 1.0 - distanceSquared / radiusSquared;
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

// The G-buffer (gbuffer.ts) of the opaque pass: the world-space normal in octahedral encoding
// (rg), the snow mask (b) and 1 (a: something opaque wrote here).
fn gbufferValue(n: vec3f, snowMask: f32) -> vec4f {
  let p = n.xy / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6);
  let signs = select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0));
  let folded = select(p, (1.0 - abs(p.yx)) * signs, n.z < 0.0);
  return vec4f(folded, snowMask, 1.0);
}
