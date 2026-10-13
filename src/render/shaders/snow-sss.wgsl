// Adapted from Community Shaders' shaders (MIT, Copyright (c) 2022 Ilya Perapechka); see
// THIRD_PARTY_NOTICES.md.
// The improved snow's subsurface scattering (the engine's ISSnowSSS pass, as Community
// Shaders' ISSnowSSS.hlsl reproduces it): snow pixels are blurred along the screen with a
// wide kernel whose blue reaches farthest, stopping at depth edges, and darkened towards a cool
// tint where the result is dark. Runs on the opaque scene, written into the multisampled
// colour target before the blended pass. ASCII only.

struct SnowScattering {
  // fSnowSSSStrength, fSnowSSSDepthDiff, the camera's near plane, unused.
  params: vec4f,
  // fSnowSSSColor (rgb) and fSnowSSSDarkColorIntensity (a).
  darkColor: vec4f,
};

@group(0) @binding(0) var<uniform> sss: SnowScattering;
@group(0) @binding(1) var sssSampler: sampler;
// The resolved opaque scene, its depth (reversed Z) and the G-buffer (b: snow mask, a: written).
@group(0) @binding(2) var scene: texture_2d<f32>;
@group(0) @binding(3) var sceneDepth: texture_2d<f32>;
@group(0) @binding(4) var gbuffer: texture_2d<f32>;

struct FullscreenOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) index: u32) -> FullscreenOut {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  var out: FullscreenOut;
  out.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2f(x, y);
  return out;
}

// Per tap: the weight of each colour channel (blue spreads farthest) and the offset. The
// kernel is Separable SSS's 11-tap one (Jimenez and Gutierrez; BSD licence, see
// THIRD_PARTY_NOTICES.md) with its channels in reverse order.
const SSS_TAPS = array<vec4f, 11>(
  vec4f(0.784728, 0.669086, 0.560479, 0.0),
  vec4f(0.000051, 0.000185, 0.004717, -2.0),
  vec4f(0.000842, 0.002820, 0.019283, -1.28),
  vec4f(0.006437, 0.013100, 0.036390, -0.72),
  vec4f(0.020926, 0.035861, 0.082190, -0.32),
  vec4f(0.079380, 0.113491, 0.077180, -0.08),
  vec4f(0.079380, 0.113491, 0.077180, 0.08),
  vec4f(0.020926, 0.035861, 0.082190, 0.32),
  vec4f(0.006437, 0.013100, 0.036390, 0.72),
  vec4f(0.000842, 0.002820, 0.019283, 1.28),
  vec4f(0.000051, 0.000185, 0.004717, 2.0),
);

fn sssDistance(uv: vec2f) -> f32 {
  let size = vec2i(textureDimensions(sceneDepth));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1);
  let depth = textureLoad(sceneDepth, pixel, 0).r;
  return sss.params.z / max(depth, 1e-9);
}

fn sssLuminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.3, 0.59, 0.11));
}

@fragment
fn fs_snow_sss(input: FullscreenOut) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(gbuffer));
  let pixel = clamp(vec2i(input.position.xy), vec2i(0), size - 1);
  let g = textureLoad(gbuffer, pixel, 0);
  let mask = select(0.0, g.b, g.a > 0.5);
  if (mask <= 1e-5) {
    discard;
  }
  let source = textureSampleLevel(scene, sssSampler, input.uv, 0.0).rgb;
  let distance = sssDistance(input.uv);
  var color = SSS_TAPS[0].xyz * source;
  // The engine's step for a 16:9 screen, scaled by the strength over the depth.
  let step = vec2f(0.078125, 0.13889) * sss.params.x / distance;
  let depthFactor = 0.1 * sss.params.y;
  for (var i = 1; i < 11; i++) {
    let tap = SSS_TAPS[i];
    let uv = input.uv + tap.w * step;
    let sample = textureSampleLevel(scene, sssSampler, uv, 0.0).rgb;
    let keep = min(1.0, depthFactor * abs(distance - sssDistance(uv)));
    color += tap.xyz * mix(sample, source, keep);
  }
  let luminance = clamp(sssLuminance(color), 0.0, 1.0);
  let dark = max(vec3f(0.0), mix(sss.darkColor.rgb * sss.darkColor.a, source, luminance));
  let snow = mix(dark, color, luminance);
  return vec4f(mix(source, snow, mask), 1.0);
}
