// Temporal anti-aliasing (taa.ts): this frame (rendered with a sub-pixel jitter) blended with
// the history of the last frames, found again through the opaque scene's depth and the camera's
// move; the history is clamped to this frame's 3×3 neighbourhood so moved or new things do not
// leave ghosts. Blended in a tone-mapped space so bright highlights do not flicker.

struct Taa {
  // This frame's clip space to the last frame's.
  reproject: mat4x4f,
  // The history's share, whether it is valid, 1 / the size.
  params: vec4f,
};

@group(0) @binding(0) var<uniform> taa: Taa;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var current: texture_2d<f32>;
@group(0) @binding(3) var history: texture_2d<f32>;
@group(0) @binding(4) var depth: texture_2d<f32>;

@vertex
fn vs_fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

fn toneMap(c: vec3f) -> vec3f {
  return c / (1.0 + max(c.r, max(c.g, c.b)));
}

fn untoneMap(c: vec3f) -> vec3f {
  return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-4);
}

@fragment
fn fs_resolve(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(current));
  let pixel = vec2i(position.xy);
  let here = toneMap(textureLoad(current, pixel, 0).rgb);
  var low = here;
  var high = here;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let at = clamp(pixel + vec2i(x, y), vec2i(0), size - 1);
      let c = toneMap(textureLoad(current, at, 0).rgb);
      low = min(low, c);
      high = max(high, c);
    }
  }
  let uv = position.xy * taa.params.zw;
  let d = textureLoad(depth, pixel, 0).r;
  let clip = taa.reproject * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  if (taa.params.y < 0.5 || clip.w <= 1e-6) {
    return vec4f(untoneMap(here), 1.0);
  }
  let ndc = clip.xy / clip.w;
  let previous = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(previous < vec2f(0.0)) || any(previous > vec2f(1.0))) {
    return vec4f(untoneMap(here), 1.0);
  }
  let past = clamp(toneMap(textureSampleLevel(history, linearSampler, previous, 0.0).rgb), low, high);
  return vec4f(untoneMap(mix(here, past, taa.params.x)), 1.0);
}
