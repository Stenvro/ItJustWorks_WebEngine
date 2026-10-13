// The skinned vertex stage of object shaders: every vertex blends up to four bone matrices
// of its draw's bone palette (bone-palette.ts: three rows of an affine matrix per bone, skin
// space to model space) by its weights, then goes on like any other vertex (common.wgsl).
// FaceGen head parts first move by their expression morphs. Appended after common.wgsl.
// ASCII only.

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

struct SkinIn {
  @location(6) weights: vec4f,
  @location(7) indices: vec4u,
};

// The weighted blend of the vertex's bones, as a 4x4 matrix (column-major).
fn skinMatrix(skin: SkinIn) -> mat4x4f {
  var total = 0.0;
  var r0 = vec4f(0.0);
  var r1 = vec4f(0.0);
  var r2 = vec4f(0.0);
  for (var k = 0u; k < 4u; k++) {
    let weight = skin.weights[k];
    if (weight > 0.0) {
      let bone = skin.indices[k] * 3u;
      r0 += bones[bone] * weight;
      r1 += bones[bone + 1u] * weight;
      r2 += bones[bone + 2u] * weight;
      total += weight;
    }
  }
  if (total <= 0.0) {
    r0 = bones[0];
    r1 = bones[1];
    r2 = bones[2];
    total = 1.0;
  }
  r0 /= total;
  r1 /= total;
  r2 /= total;
  return mat4x4f(
    vec4f(r0.x, r1.x, r2.x, 0.0),
    vec4f(r0.y, r1.y, r2.y, 0.0),
    vec4f(r0.z, r1.z, r2.z, 0.0),
    vec4f(r0.w, r1.w, r2.w, 1.0),
  );
}

@vertex
fn vs_skinned(in: VertexIn, skin: SkinIn, @builtin(vertex_index) vertex: u32) -> VertexOut {
  let model = skinMatrix(skin);
  let rotation = worldRotation() * mat3x3f(model[0].xyz, model[1].xyz, model[2].xyz);
  let position = morphed(in.position, vertex);
  var out = objectVertex(in, draw.world * (model * vec4f(position, 1.0)), rotation);
  // Model-space normal maps (FaceGen heads) are in skin space: the fragment turns them with
  // the vertex's bones, passed as its frame.
  if ((draw.flags.x & 0x1000u) != 0u) {
    out.tangent = rotation[0];
    out.bitangent = rotation[1];
    out.normal = rotation[2];
  }
  return out;
}
