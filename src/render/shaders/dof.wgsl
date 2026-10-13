// Adapted from Community Shaders' shaders (MIT, Copyright (c) 2022 Ilya Perapechka); see
// THIRD_PARTY_NOTICES.md.
// Depth of field of the imagespace (IMGS DNAM), as the engine's ISDepthOfField shader does it
// for weathers ("distant" blur, Community Shaders ISDepthOfField.hlsl, DISTANT): beyond the
// focus distance the image turns into its blurred copy over the range, up to the strength.
// Where the sky is not blurred, a sky pixel is blurred only next to geometry (by the share of
// sky around it), so silhouettes soften against the sky. Runs on the tone-mapped image.
// ASCII only.

struct Dof {
  // Strength (0..1), focus distance, range (world units), 1 if the sky is blurred too.
  params: vec4f,
  // 1 / width, 1 / height of the image, the camera's near plane, unused.
  screen: vec4f,
};

@group(0) @binding(0) var<uniform> dof: Dof;
@group(0) @binding(1) var dofSampler: sampler;
@group(0) @binding(2) var image: texture_2d<f32>;
@group(0) @binding(3) var blurred: texture_2d<f32>;
// The opaque scene's depth (reversed Z, infinite far plane: 0 is the sky).
@group(0) @binding(4) var sceneDepth: texture_2d<f32>;

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

const DOF_SKY_DEPTH = 1e-7;

fn dofDepthAt(pixel: vec2i) -> f32 {
  let size = vec2i(textureDimensions(sceneDepth));
  return textureLoad(sceneDepth, clamp(pixel, vec2i(0), size - 1), 0).r;
}

@fragment
fn fs_dof(input: FullscreenOut) -> @location(0) vec4f {
  let color = textureSampleLevel(image, dofSampler, input.uv, 0.0).rgb;
  let blur = textureSampleLevel(blurred, dofSampler, input.uv, 0.0).rgb;
  let pixel = vec2i(input.position.xy);
  let center = dofDepthAt(pixel);
  var depth = center;
  var skyShare = 0.0;
  if (center <= DOF_SKY_DEPTH && dof.params.w < 0.5) {
    // The sky stays sharp except beside geometry: average the depth 3 pixels around.
    skyShare = 1.0 / 9.0;
    var total = center;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        if (x == 0 && y == 0) {
          continue;
        }
        let d = dofDepthAt(pixel + vec2i(x, y) * 3);
        total += d;
        if (d <= DOF_SKY_DEPTH) {
          skyShare += 1.0 / 9.0;
        }
      }
    }
    depth = total / 9.0;
    if (depth <= DOF_SKY_DEPTH) {
      return vec4f(color, 1.0);
    }
  }
  // Reversed Z with an infinite far plane: distance = near / depth (the sky is infinitely far).
  let distance = select(1e9, dof.screen.z / depth, depth > DOF_SKY_DEPTH);
  let amount = clamp((distance - dof.params.y) / max(dof.params.z, 1.0), 0.0, 1.0) *
    dof.params.x * (1.0 - 0.5 * skyShare);
  return vec4f(mix(color, blur, amount), 1.0);
}
