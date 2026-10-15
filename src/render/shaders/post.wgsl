// Adapted from Community Shaders' shaders (MIT, Copyright (c) 2022 Ilya Perapechka); see
// THIRD_PARTY_NOTICES.md.
// Image post-processing as the game's HDR imagespace shader does it: eye adaptation from
// two running averages of the scene luminance, a Reinhard tone curve, bloom added where the
// image is dark enough to receive it, then saturation, tint, brightness and contrast; last the
// player's brightness setting (fGamma) as a gamma curve.
// ASCII only.

const LUMINANCE = vec3f(0.2125, 0.7154, 0.0721);

struct Post {
  // x: receive bloom threshold, y: tone curve shape (1 / white^2), z: eye adaptation on.
  param: vec4f,
  // x: saturation, y: 1 / the player's gamma (fGamma), z: contrast, w: brightness.
  cinematic: vec4f,
  // Tint colour (rgb) and amount (a).
  tint: vec4f,
  // Bloom: x threshold, y scale, z texel step (blur direction x), w texel step (y).
  bloom: vec4f,
  // Blur weights for offsets 0..15 (one side).
  weights: array<vec4f, 4>,
};

@group(0) @binding(0) var<uniform> post: Post;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var bloomTexture: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> adaptation: vec4f;

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

// Bloom source: what is brighter than the threshold, at a quarter of the resolution.
@fragment
fn fs_bright(input: FullscreenOut) -> @location(0) vec4f {
  let c = clamp(textureSampleLevel(source, linearSampler, input.uv, 0.0).rgb, vec3f(0.0), vec3f(50.0));
  return vec4f(max(c - vec3f(post.bloom.x), vec3f(0.0)) * post.bloom.y, 1.0);
}

fn blurWeight(i: u32) -> f32 {
  return post.weights[i / 4u][i % 4u];
}

// Separable Gaussian blur; post.bloom.zw is one texel in the blur direction.
@fragment
fn fs_blur(input: FullscreenOut) -> @location(0) vec4f {
  let step = post.bloom.zw;
  var sum = textureSampleLevel(source, linearSampler, input.uv, 0.0).rgb * blurWeight(0u);
  for (var i = 1u; i < 16u; i++) {
    let w = blurWeight(i);
    if (w <= 0.0) {
      break;
    }
    let offset = step * f32(i);
    sum += textureSampleLevel(source, linearSampler, input.uv + offset, 0.0).rgb * w;
    sum += textureSampleLevel(source, linearSampler, input.uv - offset, 0.0).rgb * w;
  }
  return vec4f(sum, 1.0);
}

// Reinhard with a white point: L (p L + 1) / (L + 1); p = 1 leaves the image unchanged.
fn toneCurve(color: vec3f) -> vec3f {
  let p = post.param.y;
  return color * (color * p + 1.0) / (color + 1.0);
}

@fragment
fn fs_composite(input: FullscreenOut) -> @location(0) vec4f {
  var color = max(textureSampleLevel(source, linearSampler, input.uv, 0.0).rgb, vec3f(0.0));
  let bloom = textureSampleLevel(bloomTexture, linearSampler, input.uv, 0.0).rgb;
  let adapted = max(adaptation.xy, vec2f(0.001));
  if (post.param.z > 0.5) {
    color *= adapted.y / adapted.x;
  }
  var blended = toneCurve(color);
  blended += clamp(vec3f(post.param.x) - blended, vec3f(0.0), vec3f(1.0)) * bloom;
  let luminance = dot(blended, LUMINANCE);
  let saturated = mix(vec3f(luminance), blended, post.cinematic.x);
  let tinted = post.cinematic.w * mix(saturated, luminance * post.tint.rgb, post.tint.a);
  let pivot = select(0.5, adapted.x, post.param.z > 0.5);
  let contrasted = mix(vec3f(pivot), tinted, post.cinematic.z);
  let graded = clamp(contrasted, vec3f(0.0), vec3f(1.0));
  return vec4f(pow(graded, vec3f(post.cinematic.y)), 1.0);
}
