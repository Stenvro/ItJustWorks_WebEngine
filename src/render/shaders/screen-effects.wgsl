// Adapted from Community Shaders' shaders (MIT, Copyright (c) 2022 Ilya Perapechka); see
// THIRD_PARTY_NOTICES.md.
// The image-space modifiers' screen effects on the finished image: the full-screen blur
// (the image turning into its blurred copy), double vision (ISDoubleVision), radial blur
// (ISRadialBlur) and full-screen motion blur (the previous image kept by a share).
// ASCII only.

struct Effect {
  // fs_mix: x the share of the second image. fs_double_vision: xy the offset of the two
  // images, z how fast the edges turn into the blurred copy. fs_radial_blur: x strength,
  // y ramp up, z start, w ramp down.
  a: vec4f,
  // fs_radial_blur: xy the centre (0..1), z down start.
  b: vec4f,
};

@group(0) @binding(0) var<uniform> effect: Effect;
@group(0) @binding(1) var effectSampler: sampler;
@group(0) @binding(2) var image: texture_2d<f32>;
// The blurred copy (fs_mix for the blur, fs_double_vision), the previous image (fs_mix for
// motion blur); unused by fs_radial_blur and fs_copy.
@group(0) @binding(3) var second: texture_2d<f32>;

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

fn sampleImage(uv: vec2f) -> vec3f {
  return textureSampleLevel(image, effectSampler, uv, 0.0).rgb;
}

@fragment
fn fs_copy(input: FullscreenOut) -> @location(0) vec4f {
  return vec4f(sampleImage(input.uv), 1.0);
}

@fragment
fn fs_mix(input: FullscreenOut) -> @location(0) vec4f {
  let other = textureSampleLevel(second, effectSampler, input.uv, 0.0).rgb;
  return vec4f(mix(sampleImage(input.uv), other, effect.a.x), 1.0);
}

// Two copies of the image shifted apart, turning into the blurred copy towards the edges.
@fragment
fn fs_double_vision(input: FullscreenOut) -> @location(0) vec4f {
  let uv = input.uv;
  let offset = effect.a.xy;
  let first = sampleImage(vec2f(max(0.0, uv.x - offset.x), max(uv.y - offset.y, 0.0)));
  let other = sampleImage(vec2f(min(1.0, uv.x + offset.x), min(1.0, uv.y + offset.y)));
  let blurred = textureSampleLevel(second, effectSampler, uv, 0.0).rgb;
  let edge = min(1.0, effect.a.z * length(2.0 * (uv - 0.5)));
  return vec4f(0.5 * (1.0 - edge) * (first + other) + edge * blurred, 1.0);
}

// Samples on each side along the line to the centre. TODO(M13): the game's ISRadialBlur
// techniques differ in their step count (quality); calibrate.
const RADIAL_STEPS = 8;

fn circle(distance: f32, start: f32, ramp: f32) -> f32 {
  let beyond = max(0.0, distance - start);
  if (beyond > 0.0) {
    return effect.a.x * (1.0 - 1.0 / (ramp * beyond + 1.0));
  }
  return 0.0;
}

// Blur along the lines to the centre, growing from `start` by `ramp up` and falling off
// again from `down start` by `ramp down`.
@fragment
fn fs_radial_blur(input: FullscreenOut) -> @location(0) vec4f {
  let offset = effect.b.xy - input.uv;
  let distance = length(offset);
  if (distance <= 0.0) {
    return vec4f(sampleImage(input.uv), 1.0);
  }
  let delta = 0.5 * normalize(offset) *
    max(0.0, circle(distance, effect.a.z, effect.a.y) - circle(distance, effect.b.z, effect.a.w));
  var sum = vec3f(0.0);
  for (var i = -RADIAL_STEPS; i <= RADIAL_STEPS; i++) {
    sum += sampleImage(input.uv + delta * f32(i));
  }
  return vec4f(sum / f32(2 * RADIAL_STEPS + 1), 1.0);
}
