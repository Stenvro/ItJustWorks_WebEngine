// The image-based lens flare of bright lights (image-lens-flare.ts; the passes and their order
// in image-lens-flare-data.ts). Each entry point is one of the original's image-space shaders,
// observed in its shader cache: the downsample keeping the brightest tap with its temporal
// average, the lights filter (ISIBLensFlares), the separable blur, the additive copy and the
// composite onto the scene (ISCompositeLensFlare).

struct Pass {
  // downsample: source texel (xy), tap count, temporal (1/0)
  // filter: downshift, lateral taps either side, source texel across, intensity
  // blur: tap count
  params: vec4f,
  // downsample and blur: offsets in uv (xy) and the blur's weight (z)
  taps: array<vec4f, 15>,
};

struct Frame {
  // This frame's clip space to the last frame's (for the history's place of still pixels).
  reproject: mat4x4f,
  // Whether reproject holds a last frame (x).
  params: vec4f,
};

@group(0) @binding(0) var<uniform> pass_: Pass;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var history: texture_2d<f32>;
// Moving draws' motion vectors: the uv offset to the last frame (rg), written (b).
@group(0) @binding(4) var velocity: texture_2d<f32>;
@group(0) @binding(5) var depth: texture_2d<f32>;
@group(0) @binding(6) var<uniform> frame: Frame;

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

// The passes read their source black outside it (TODO(M13): the original's sampler address
// mode for these passes is its fifth, taken here for a black border).
fn sourceAt(uv: vec2f) -> vec4f {
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
    return vec4f(0.0);
  }
  return textureSampleLevel(source, linearSampler, uv, 0.0);
}

// Where this pixel was in the last frame: a moving draw's motion vector, else the camera's
// move through the opaque scene's depth (the original reads one motion-vector target that
// holds both).
fn previousUv(uv: vec2f) -> vec2f {
  let size = vec2f(textureDimensions(velocity));
  let pixel = vec2i(clamp(uv * size, vec2f(0.0), size - 1.0));
  let motion = textureLoad(velocity, pixel, 0);
  if (motion.b > 0.5) {
    return uv + motion.rg;
  }
  if (frame.params.x < 0.5) {
    return uv;
  }
  let depthSize = vec2f(textureDimensions(depth));
  let d = textureLoad(depth, vec2i(clamp(uv * depthSize, vec2f(0.0), depthSize - 1.0)), 0).r;
  let clip = frame.reproject * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  if (clip.w <= 1e-6) {
    return uv;
  }
  let ndc = clip.xy / clip.w;
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

// Of the taps the one with the highest luminance (0.3, 0.59, 0.11; black never wins), averaged
// half and half with the last frame's result where the pixel was.
@fragment
fn fs_downsample(in: FullscreenOut) -> @location(0) vec4f {
  var best = vec4f(0.0);
  var bestLuminance = 0.0;
  let count = u32(pass_.params.z);
  for (var i = 0u; i < count; i++) {
    let c = sourceAt(in.uv + pass_.taps[i].xy);
    let l = dot(c.rgb, vec3f(0.3, 0.59, 0.11));
    if (bestLuminance < l) {
      best = c;
      bestLuminance = l;
    }
  }
  if (pass_.params.w < 0.5) {
    return best;
  }
  let past = textureSampleLevel(history, linearSampler, previousUv(in.uv), 0.0);
  return (best + past) * 0.5;
}

// The lights filter: each tap across passes as saturate(colour) where a channel is above the
// downshift, the taps summed and scaled by the intensity.
@fragment
fn fs_filter(in: FullscreenOut) -> @location(0) vec4f {
  let repeat = i32(pass_.params.y);
  var sum = vec4f(0.0);
  for (var i = -repeat; i <= repeat; i++) {
    let c = sourceAt(in.uv + vec2f(f32(i) * pass_.params.z, 0.0));
    let over = saturate(c.rgb - vec3f(pass_.params.x));
    if (over.r + over.g + over.b > 0.0) {
      sum += saturate(c);
    }
  }
  return sum * pass_.params.w;
}

// A separable blur: the taps' weighted sum (the weights carry the pass's strength).
@fragment
fn fs_blur(in: FullscreenOut) -> @location(0) vec4f {
  let count = u32(pass_.params.x);
  var sum = vec4f(0.0);
  for (var i = 0u; i < count; i++) {
    sum += sourceAt(in.uv + pass_.taps[i].xy) * pass_.taps[i].z;
  }
  return sum;
}

// The additive copy (one target's streaks onto another's) and the composite onto the scene.
@fragment
fn fs_add(in: FullscreenOut) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(source, linearSampler, in.uv, 0.0).rgb, 0.0);
}
