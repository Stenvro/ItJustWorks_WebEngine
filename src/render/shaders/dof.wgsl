// Adapted from Community Shaders' shaders (MIT, Copyright (c) 2022 Ilya Perapechka); see
// THIRD_PARTY_NOTICES.md.
// Depth of field of the imagespace (IMGS DNAM), as the engine's ISDepthOfField shader does it
// for weathers ("distant" blur, Community Shaders ISDepthOfField.hlsl, DISTANT): beyond the
// focus distance the image turns into its blurred copy over the range, up to the strength.
// Image-space modifiers may blur in front of the focus too (the shader without DISTANT: the
// mode's front and back flags pick the sides). Where the sky is not blurred, a sky pixel is
// blurred only next to geometry (by the share of sky around it), so silhouettes soften against
// the sky. The world map blurs its own way (ISWorldMap, below). Runs on the tone-mapped image.
// The underwater view (src/world/underwater.ts), as the original's fogged and masked fogged
// depth of field shaders do it: inside the underwater mask (the whole image when the near
// plane is wholly under) the water's imagespace's depth of field, then the image turns toward
// the fog colour by the view depth, from none at the fog's near plane to all at its far plane.
// ASCII only.

struct Dof {
  // Strength (0..1), focus distance, range (world units), 1 if the sky is blurred too.
  params: vec4f,
  // 1 / width, 1 / height of the image, the camera's near plane, unused.
  screen: vec4f,
  // The world map's blur (y > 0): focal depth, maximum step, step per unit, near scale.
  map: vec4f,
  // x: 1 to blur in front of the focus, y: 1 to blur beyond it (imagespaces: beyond only).
  mode: vec4f,
  // Inside the underwater mask where the view crosses the surface: the water's imagespace's
  // params and mode (as above; strength 0 without one).
  underParams: vec4f,
  underMode: vec4f,
  // The underwater fog: colour (rgb), w 1 when the underwater view is on.
  fogColor: vec4f,
  // x: the fog's near plane, y: its far plane (view depth).
  fog: vec4f,
  // The underwater mask: under the surface where x * ndc.x + y * ndc.y + z < 0; w 1: the
  // whole image.
  mask: vec4f,
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
  if (dof.map.y > 0.0) {
    return worldMapBlur(input);
  }
  let color = textureSampleLevel(image, dofSampler, input.uv, 0.0).rgb;
  let pixel = vec2i(input.position.xy);
  let ndc = vec2f(input.uv.x * 2.0 - 1.0, 1.0 - input.uv.y * 2.0);
  let under = dof.mask.w > 0.5 || dot(dof.mask.xy, ndc) + dof.mask.z < 0.0;
  // Wholly under, the scene's depth of field is already the water's (mask.w).
  let inside = under && dof.mask.w < 0.5;
  let params = select(dof.params, dof.underParams, inside);
  let mode = select(dof.mode, dof.underMode, inside);
  let scene = sceneDistance(pixel, params.w > 0.5);
  var result = color;
  if (params.x > 0.0 && scene.z < 0.5) {
    let beyond = scene.x - params.y;
    let side = select(mode.x, mode.y, beyond > 0.0);
    let amount = clamp(abs(beyond) / max(params.z, 1.0), 0.0, 1.0) * side *
      params.x * (1.0 - 0.5 * scene.y);
    if (amount > 0.0) {
      let blur = textureSampleLevel(blurred, dofSampler, input.uv, 0.0).rgb;
      result = mix(color, blur, amount);
    }
  }
  if (dof.fogColor.w > 0.5 && under) {
    // Open sky where the sky is not blurred: the original's shader reads the raw depth there
    // (the far end, 1) as the distance.
    let distance = select(scene.x, 1.0, scene.z > 0.5);
    result = mix(result, dof.fogColor.rgb, underwaterFogShare(distance));
  }
  return vec4f(result, 1.0);
}

// The view depth at a pixel (x), the share of sky around it (y) and whether it is open sky
// where the sky is not blurred (z = 1). Where the sky is not blurred, a sky pixel takes the
// depth averaged 3 pixels around (sky beside geometry), so silhouettes soften against the sky.
fn sceneDistance(pixel: vec2i, skyBlurred: bool) -> vec3f {
  let center = dofDepthAt(pixel);
  var depth = center;
  var skyShare = 0.0;
  if (center <= DOF_SKY_DEPTH && !skyBlurred) {
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
      return vec3f(1e9, skyShare, 1.0);
    }
  }
  // Reversed Z with an infinite far plane: distance = near / depth (the sky is infinitely far).
  return vec3f(select(1e9, dof.screen.z / depth, depth > DOF_SKY_DEPTH), skyShare, 0.0);
}

// The original's fogged shaders: saturate((depth - near) / (far - near)).
fn underwaterFogShare(distance: f32) -> f32 {
  let span = dof.fog.y - dof.fog.x;
  if (span == 0.0) {
    return select(0.0, 1.0, distance >= dof.fog.x);
  }
  return clamp((distance - dof.fog.x) / span, 0.0, 1.0);
}

// The world map's blur (Community Shaders' ISWorldMap.hlsl): a 7x7 box over the image, its step
// (pixels) the distance from the focal depth times the scale, up to the maximum; nearer than
// the focus, times the near scale; none on the sky when the sky is not blurred.
fn worldMapBlur(input: FullscreenOut) -> vec4f {
  let depth = dofDepthAt(vec2i(input.position.xy));
  let distance = select(1e9, dof.screen.z / depth, depth > DOF_SKY_DEPTH);
  var step = min(dof.map.y, dof.map.z * abs(distance - dof.map.x));
  if (depth <= DOF_SKY_DEPTH && dof.params.w < 0.5) {
    step = 0.0;
  }
  if (distance < dof.map.x) {
    step *= dof.map.w;
  }
  let texel = dof.screen.xy * step;
  let start = input.uv - 3.0 * texel;
  var sum = vec3f(0.0);
  for (var i = 0; i < 7; i++) {
    for (var j = 0; j < 7; j++) {
      sum += textureSampleLevel(image, dofSampler, start + texel * vec2f(f32(i), f32(j)), 0.0).rgb;
    }
  }
  return vec4f(sum / 49.0, 1.0);
}
