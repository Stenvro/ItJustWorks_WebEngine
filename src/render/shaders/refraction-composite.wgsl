// Adapted from Community Shaders' shaders (MIT, Copyright (c) 2022 Ilya Perapechka); see
// THIRD_PARTY_NOTICES.md.
// The engine's image-space refraction (ISRefraction, as Community Shaders' ISRefraction.hlsl
// reproduces it): after everything is drawn, the scene is shifted where refraction shapes
// wrote into the refraction buffer (rg: normal map xy, b: strength, a: mask). The offset is
// 0.1 * strength * (normal - 0.5) with x mirrored; offsets near the screen edges are pulled in
// (past 0.15 and 0.85 the coordinate only moves at 0.78 of the rate), more so the stronger the
// shape; the mask is read where the shifted coordinate lands, so nothing in front of the shape
// is pulled into it. ASCII only.

@group(0) @binding(0) var compositeSampler: sampler;
// The scene so far (resolved, everything blended) and the refraction buffer.
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var refraction: texture_2d<f32>;

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

// Past these screen coordinates offsets are compressed by EDGE_RATE.
const EDGE_LOW = 0.15;
const EDGE_HIGH = 0.85;
const EDGE_RATE = 0.78;

@fragment
fn fs_refraction_composite(in: FullscreenOut) -> @location(0) vec4f {
  let original = textureSampleLevel(refraction, compositeSampler, in.uv, 0.0);
  let color = textureSampleLevel(scene, compositeSampler, in.uv, 0.0);
  let shifted = in.uv + vec2f(-1.0, 1.0) * 0.1 * original.b * (original.rg - 0.5);
  var soft = shifted;
  soft = select(soft, EDGE_HIGH + EDGE_RATE * (soft - EDGE_HIGH), soft > vec2f(EDGE_HIGH));
  soft = select(soft, EDGE_LOW + EDGE_RATE * (soft - EDGE_LOW), soft < vec2f(EDGE_LOW));
  let uv = mix(shifted, soft, original.b);
  let mask = textureSampleLevel(refraction, compositeSampler, uv, 0.0).a;
  let refracted = textureSampleLevel(scene, compositeSampler, uv, 0.0);
  return mix(color, refracted, mask);
}
