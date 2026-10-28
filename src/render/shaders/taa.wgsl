// Temporal anti-aliasing (taa.ts): this frame (rendered with a sub-pixel jitter) blended with
// the history of the last frames, found again through the motion vectors of moving draws
// (velocity.wgsl) or else the opaque scene's depth and the camera's move; the history is clamped to this frame's 3×3 neighbourhood so moved or new things do not
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
// Moving draws' motion vectors: the uv offset to the last frame (rg), written (b).
@group(0) @binding(5) var velocity: texture_2d<f32>;

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

// The history at a uv through a Catmull-Rom filter (five bilinear taps): a moving view
// fetches its history between texels every frame, and a bilinear fetch would soften the image
// a little more each time.
fn historyAt(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(history));
  let at = uv * size;
  let centre = floor(at - 0.5) + 0.5;
  let f = at - centre;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let p0 = (centre - 1.0) / size;
  let p3 = (centre + 2.0) / size;
  let p12 = (centre + w2 / w12) / size;
  var sum = textureSampleLevel(history, linearSampler, vec2f(p12.x, p0.y), 0.0).rgb * (w12.x * w0.y);
  sum += textureSampleLevel(history, linearSampler, vec2f(p0.x, p12.y), 0.0).rgb * (w0.x * w12.y);
  sum += textureSampleLevel(history, linearSampler, p12, 0.0).rgb * (w12.x * w12.y);
  sum += textureSampleLevel(history, linearSampler, vec2f(p3.x, p12.y), 0.0).rgb * (w3.x * w12.y);
  sum += textureSampleLevel(history, linearSampler, vec2f(p12.x, p3.y), 0.0).rgb * (w12.x * w3.y);
  let total = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(sum / total, vec3f(0.0));
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
  if (taa.params.y < 0.5) {
    return vec4f(untoneMap(here), 1.0);
  }
  var previous: vec2f;
  let motion = textureLoad(velocity, pixel, 0);
  if (motion.b > 0.5) {
    // A moving draw: where its surface was.
    previous = uv + motion.rg;
  } else {
    // Still: where the camera saw this point.
    let d = textureLoad(depth, pixel, 0).r;
    let clip = taa.reproject * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
    if (clip.w <= 1e-6) {
      return vec4f(untoneMap(here), 1.0);
    }
    let ndc = clip.xy / clip.w;
    previous = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  }
  if (any(previous < vec2f(0.0)) || any(previous > vec2f(1.0))) {
    return vec4f(untoneMap(here), 1.0);
  }
  let past = clamp(toneMap(historyAt(previous)), low, high);
  return vec4f(untoneMap(mix(here, past, taa.params.x)), 1.0);
}
