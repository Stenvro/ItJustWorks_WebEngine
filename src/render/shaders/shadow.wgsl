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

// Skinned casters: the bone palette of the draw (skinning.wgsl).
@group(3) @binding(0) var<storage, read> bones: array<vec4f>;

// FaceGen head parts: the draw's active expression morphs (face-morphs.ts): a header
// (count, vertex count), then (morph index, weight) pairs; the offsets are half floats, two
// u32 per morph and vertex (x|y, z). Draws without morphs bind an empty region.
@group(3) @binding(1) var<storage, read> morphSlots: array<vec4f>;
@group(3) @binding(2) var<storage, read> morphOffsets: array<u32>;

// The vertex moved by the draw's active morphs (before skinning, in skin space).
fn morphed(position: vec3f, vertex: u32) -> vec3f {
  let header = morphSlots[0];
  let count = min(u32(header.x), 30u);
  let vertexCount = u32(header.y);
  var p = position;
  for (var k = 0u; k < count; k++) {
    let slots = morphSlots[1u + k / 2u];
    let pair = select(slots.xy, slots.zw, (k & 1u) == 1u);
    let at = (u32(pair.x) * vertexCount + vertex) * 2u;
    let xy = unpack2x16float(morphOffsets[at]);
    let z = unpack2x16float(morphOffsets[at + 1u]).x;
    p += vec3f(xy, z) * pair.y;
  }
  return p;
}

fn skinned(position: vec3f, weights: vec4f, indices: vec4u) -> vec3f {
  let p = vec4f(position, 1.0);
  var sum = vec3f(0.0);
  var total = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let weight = weights[k];
    if (weight > 0.0) {
      let bone = indices[k] * 3u;
      sum += vec3f(dot(bones[bone], p), dot(bones[bone + 1u], p), dot(bones[bone + 2u], p)) * weight;
      total += weight;
    }
  }
  if (total <= 0.0) {
    return vec3f(dot(bones[0], p), dot(bones[1], p), dot(bones[2], p));
  }
  return sum / total;
}

@vertex
fn vs_skinned(
  @location(0) position: vec3f,
  @location(6) weights: vec4f,
  @location(7) indices: vec4u,
  @builtin(vertex_index) vertex: u32,
) -> @builtin(position) vec4f {
  let moved = morphed(position, vertex);
  return cascade.viewProj * (draw.world * vec4f(skinned(moved, weights, indices), 1.0));
}

@vertex
fn vs_skinned_uv(
  @location(0) position: vec3f,
  @location(2) uv: vec2f,
  @location(6) weights: vec4f,
  @location(7) indices: vec4u,
  @builtin(vertex_index) vertex: u32,
) -> ShadowOut {
  var out: ShadowOut;
  let moved = morphed(position, vertex);
  out.position = cascade.viewProj * (draw.world * vec4f(skinned(moved, weights, indices), 1.0));
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
