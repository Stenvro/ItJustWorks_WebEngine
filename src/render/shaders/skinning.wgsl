// The skinned vertex stage of object shaders: every vertex blends up to four bone matrices
// of its draw's bone palette (bone-palette.ts: three rows of an affine matrix per bone, skin
// space to model space) by its weights, then goes on like any other vertex (common.wgsl).
// Appended after common.wgsl. ASCII only.

@group(3) @binding(0) var<storage, read> bones: array<vec4f>;

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
fn vs_skinned(in: VertexIn, skin: SkinIn) -> VertexOut {
  let model = skinMatrix(skin);
  let rotation = worldRotation() * mat3x3f(model[0].xyz, model[1].xyz, model[2].xyz);
  var out = objectVertex(in, draw.world * (model * vec4f(in.position, 1.0)), rotation);
  // Model-space normal maps (FaceGen heads) are in skin space: the fragment turns them with
  // the vertex's bones, passed as its frame.
  if ((draw.flags.x & 0x1000u) != 0u) {
    out.tangent = rotation[0];
    out.bitangent = rotation[1];
    out.normal = rotation[2];
  }
  return out;
}
