// The order of its terms follows Community Shaders' ISSAOComposite.hlsl (MIT, Copyright (c)
// 2022 Ilya Perapechka; see THIRD_PARTY_NOTICES.md); the code is this engine's own.
// The composite after the opaque pass and the snow's subsurface scattering, as the engine's
// ISSAOComposite (its SAO, Fog and SAOFog variants) does it: the snow's specular (rim light) times the snow mask added to the unfogged colour,
// the colour times the ambient occlusion (not on snow: bDeactivateAOOnSnow), the fog, then the
// snow's sparkles. The engine's lighting, landscape, grass and distant tree shaders leave their
// fog to this pass, so the snow's scattering before it sees the snow as lit, not the fog over
// it. Runs per sample of the multisampled colour target, each with its own depth and G-buffer,
// blended as src + dst * src.a. The sky and the surfaces their own shader finished (G-buffer
// a = 0: sky objects, effects) stay as they are. Prepended with frame.wgsl and snow.wgsl.
// ASCII only. Notes: docs/rendering.md ("Composite").

// The ambient occlusion (r, 1 = open; a white texel without SAO), the G-buffer and the depth.
@group(1) @binding(0) var occlusion: texture_2d<f32>;
@group(1) @binding(1) var gbufferSamples: texture_multisampled_2d<f32>;
@group(1) @binding(2) var depthSamples: texture_depth_multisampled_2d;

@vertex
fn vs_fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_composite(
  @builtin(position) position: vec4f,
  @builtin(sample_index) sampleIndex: u32,
) -> @location(0) vec4f {
  let pixel = vec2i(position.xy);
  let depth = textureLoad(depthSamples, pixel, i32(sampleIndex));
  let g = textureLoad(gbufferSamples, pixel, i32(sampleIndex));
  let size = vec2i(textureDimensions(occlusion));
  var ao = textureLoad(occlusion, clamp(pixel, vec2i(0), size - 1), 0).r;
  let composited = depth > 0.0 && g.a > 0.5;
  let snowMask = select(0.0, g.b, composited);
  if (snowMask > 1e-5) {
    ao = 1.0;
  }
  // Debug view 6 (DebugView.ambientOcclusion): the AO alone, the sky magenta.
  if (frame.counts.z == 6u) {
    return select(vec4f(1.0, 0.0, 1.0, 0.0), vec4f(vec3f(ao), 0.0), depth > 0.0);
  }
  if (!composited) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  // The other debug views show their values, only darkened by the AO.
  if (frame.counts.z != 0u) {
    return vec4f(0.0, 0.0, 0.0, ao);
  }
  let ndc = vec4f(position.x * frame.screen.x * 2.0 - 1.0, 1.0 - position.y * frame.screen.y * 2.0, depth, 1.0);
  let world4 = frame.inverseViewProj * ndc;
  let world = world4.xyz / world4.w;
  let fog = fogAt(world);
  // What is left of the colour: AO, then fog over it.
  let keep = ao * (1.0 - fog.a);
  let snowSpecular = (g.a - 1.0) * snowMask;
  var sparkles = vec3f(0.0);
  if (snowMask > 1e-5) {
    sparkles = snowSparkles(world, sunShadow(world, octahedralDecode(g.xy))) * snowMask;
  }
  return vec4f(vec3f(snowSpecular * keep) + fog.rgb * fog.a + sparkles, keep);
}
