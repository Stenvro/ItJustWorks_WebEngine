// Shadow-map depth of objects and terrain as the sun sees them (one cascade per pass).
// Alpha-tested parts (leaves, fences) cut out their holes. ASCII only.

struct Cascade {
  viewProj: mat4x4f,
};

// Same layout as the object shaders' Draw (common.wgsl).
struct Draw {
  world: mat4x4f,
  uvTransform: vec4f,
  emissive: vec4f,
  specular: vec4f,
  params: vec4f,
  extra: vec4f,
  flags: vec4u,
};

@group(0) @binding(0) var<uniform> cascade: Cascade;
@group(1) @binding(0) var<uniform> draw: Draw;
@group(2) @binding(0) var linearSampler: sampler;
@group(2) @binding(1) var diffuseMap: texture_2d<f32>;

struct ShadowOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_object(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return cascade.viewProj * (draw.world * vec4f(position, 1.0));
}

@vertex
fn vs_object_uv(@location(0) position: vec3f, @location(2) uv: vec2f) -> ShadowOut {
  var out: ShadowOut;
  out.position = cascade.viewProj * (draw.world * vec4f(position, 1.0));
  out.uv = uv * draw.uvTransform.zw + draw.uvTransform.xy;
  return out;
}

// NiAlphaProperty alpha test, as in common.wgsl.
@fragment
fn fs_alpha_test(input: ShadowOut) {
  let alpha = textureSample(diffuseMap, linearSampler, input.uv).a * draw.params.y;
  let flags = draw.flags.z;
  let threshold = draw.params.z;
  var passes = true;
  switch ((flags >> 10u) & 7u) {
    case 1u: { passes = alpha < threshold; }
    case 2u: { passes = alpha == threshold; }
    case 3u: { passes = alpha <= threshold; }
    case 4u: { passes = alpha > threshold; }
    case 5u: { passes = alpha != threshold; }
    case 6u: { passes = alpha >= threshold; }
    case 7u: { passes = false; }
    default: {}
  }
  if (!passes) {
    discard;
  }
}

// Terrain vertices are already in world space.
@vertex
fn vs_terrain(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return cascade.viewProj * vec4f(position, 1.0);
}
