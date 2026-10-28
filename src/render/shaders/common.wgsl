// Object shaders (lighting and effect): per-draw data, materials and the vertex stage.
// Prepended to each object shader after frame.wgsl. ASCII only.

struct Draw {
  world: mat4x4f,
  // UV offset (xy) and scale (zw).
  uvTransform: vec4f,
  // Lighting: emissive colour * multiple. Effect: base colour * scale (rgba).
  emissive: vec4f,
  // Specular colour (rgb) and strength (a).
  specular: vec4f,
  // Glossiness, material alpha, alpha test threshold (0..1), environment map scale.
  params: vec4f,
  // Lighting: skin/hair tint. Effect: falloff start/stop angle (cos), start/stop opacity.
  extra: vec4f,
  // Shader flags 1 and 2, NiAlphaProperty flags (plus DRAW_* bits above them), shader type.
  flags: vec4u,
  // Lighting: soft light rolloff, rim light power, 1 when the environment map has a mask.
  effect: vec4f,
  // Multi-layer parallax: inner layer thickness, refraction scale, inner layer U and V scale.
  layer: vec4f,
  // Directional material: ProjectedUVParams (noise falloff, unused, noise UV scale, threshold).
  projected: vec4f,
  // Single pass: the material's colour. Multi-pass: normal dampener, material UV scale.
  projectedColor: vec4f,
  // The world direction a surface faces to get the material; multi-pass: cos(max angle) in w.
  projectedDirection: vec4f,
  // Sparkle snow (multi-index snow pass) parameters.
  sparkle: vec4f,
};

@group(1) @binding(0) var<uniform> draw: Draw;
// The scene's per-object light lists (light-lists.ts): per draw slot a count and up to seven
// indices into pointLights, 16 bits each (the count first). A draw's slot is in flags.w bits
// 8-23; 0xffff names no list (every light of the frame).
@group(1) @binding(1) var<storage, read> drawLights: array<vec4u>;

struct LightList {
  all: bool,
  count: u32,
  words: vec4u,
};

// The lights of this draw: its own list (the engine's lights of the geometry: shadow lights
// first, at most seven), or every light of the frame.
fn drawLightList() -> LightList {
  let slot = (draw.flags.w >> 8u) & 0xffffu;
  if (slot == 0xffffu) {
    return LightList(true, frame.counts.x, vec4u(0u));
  }
  let words = drawLights[slot];
  return LightList(false, words.x & 0xffffu, words);
}

// The i-th light of a list, as an index into pointLights.
fn lightListIndex(list: LightList, i: u32) -> u32 {
  if (list.all) {
    return i;
  }
  let half = i + 1u;
  let word = list.words[half >> 1u];
  return select(word >> 16u, word & 0xffffu, (half & 1u) == 0u);
}
@group(2) @binding(0) var linearSampler: sampler;
// Lighting: diffuse. Effect: source texture.
@group(2) @binding(1) var diffuseMap: texture_2d<f32>;
@group(2) @binding(2) var normalMap: texture_2d<f32>;
// Lighting: glow map, or the rim / soft light map (slot 2). Effect: greyscale palette.
@group(2) @binding(3) var glowMap: texture_2d<f32>;
@group(2) @binding(4) var envMap: texture_cube<f32>;
@group(2) @binding(5) var envMask: texture_2d<f32>;
// Lighting: back light map, or the specular map of model-space normal materials (slot 7).
@group(2) @binding(6) var backLightMap: texture_2d<f32>;
// Lighting: multi-layer parallax inner layer (slot 6); LOD landscape: the terrain noise.
@group(2) @binding(7) var layerMap: texture_2d<f32>;
// The engine's directional material textures: diffuse, normal map (sparkle noise), noise.
@group(2) @binding(8) var projectedDiffuse: texture_2d<f32>;
@group(2) @binding(9) var projectedNormal: texture_2d<f32>;
@group(2) @binding(10) var projectedNoise: texture_2d<f32>;
// FaceGen heads: the detail map (slot 3).
@group(2) @binding(11) var detailMap: texture_2d<f32>;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) bitangentX: f32,
  @location(2) uv: vec2f,
  // xyz = normal (0..1 encodes -1..1), w = bitangent Y
  @location(3) normal: vec4f,
  // xyz = tangent, w = bitangent Z
  @location(4) tangent: vec4f,
  @location(5) color: vec4f,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) uv: vec2f,
  @location(2) normal: vec3f,
  @location(3) tangent: vec3f,
  @location(4) bitangent: vec3f,
  @location(5) color: vec4f,
};

// Distance fade (object-fade.ts): how far the draw's reference has faded out (0..255 in the top
// byte of flags.w); a 4x4 ordered dither drops that share of its pixels, so it dissolves.
fn fadeDiscarded(pixel: vec2f) -> bool {
  let level = draw.flags.w >> 24u;
  if (level == 0u) {
    return false;
  }
  var bayer = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
  let p = vec2u(pixel) & vec2u(3u);
  return (f32(bayer[p.y * 4u + p.x]) + 0.5) / 16.0 < f32(level) / 255.0;
}

// Directional materials: coordinates across the direction surfaces face to get the material
// (the engine's TexCoord0.zw; single pass faces up, giving world y and -x).
fn projectedCoordinates(worldPos: vec3f) -> vec2f {
  let up = safeNormalize(draw.projectedDirection.xyz);
  let reference = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(up.x) > 0.99);
  let across = safeNormalize(cross(up, reference));
  return vec2f(dot(worldPos, across), dot(worldPos, cross(up, across)));
}

// Leaf flutter (SLSF2 Tree_Anim, the engine's GetTreeShiftVector): vertices move along their
// normal by a pair of smoothed triangle waves of the leaf frequency, the wind and time, offset
// by the vertex position, times the leaf amplitude and the vertex alpha. The amplitude fades
// out between fLeafAnimDampenDistStart and -End (3600 and 4600 units from the camera).
const DRAW_TREE_ANIM = 0x400000u;
// The part is skinned (skinning.wgsl): its model-space normals turn with its bones.
const DRAW_SKINNED = 0x800000u;
// The player's first-person geometry (its arms and what they hold): drawn through
// frame.firstPersonViewProj, its depth moved into the band nearest the eye (reversed Z: from
// FIRST_PERSON_DEPTH to 1) that the world, kept beyond the near plane, never reaches. The
// engine draws first person in a pass of its own over the world; the band does the same in one
// pass: the arms and weapon never sink into a wall, and still hide their own far sides.
const DRAW_FIRST_PERSON = 0x8000u;
const FIRST_PERSON_DEPTH = 0.98;
const LEAF_DAMPEN_START = 3600.0;
const LEAF_DAMPEN_END = 4600.0;

fn leafShift(position: vec3f, alpha: f32) -> f32 {
  // draw.projected: leaf amplitude, leaf frequency, 1 while the leaf node's timer runs.
  let amplitude = draw.projected.x;
  let distance = length(frame.cameraPos.xyz - draw.world[3].xyz);
  let limit = max((1.0 - (distance - LEAF_DAMPEN_START) / (LEAF_DAMPEN_END - LEAF_DAMPEN_START)) * amplitude, 0.0);
  let timer = frame.time.x * 6.0 * draw.projected.z;
  let phase = draw.projected.y * frame.time.y * timer;
  let t = vec2f(0.1, 0.25) * phase + dot(position, vec3f(1.0));
  let triangle = abs(-1.0 + 2.0 * fract(0.5 + t));
  let eased = triangle * triangle * (3.0 - 2.0 * triangle);
  return (eased.x + 0.1 * eased.y) * (min(amplitude, limit) * alpha);
}

fn worldRotation() -> mat3x3f {
  return mat3x3f(draw.world[0].xyz, draw.world[1].xyz, draw.world[2].xyz);
}

@vertex
fn vs_main(in: VertexIn) -> VertexOut {
  var position = in.position;
  if ((draw.flags.z & DRAW_TREE_ANIM) != 0u) {
    position += (in.normal.xyz * 2.0 - 1.0) * leafShift(in.position, in.color.a);
  }
  return objectVertex(in, draw.world * vec4f(position, 1.0), worldRotation());
}

// A vertex at its world position, its normal frame turned by `rotation` (model to world).
fn objectVertex(in: VertexIn, world: vec4f, rotation: mat3x3f) -> VertexOut {
  var out: VertexOut;
  if ((draw.flags.z & DRAW_FIRST_PERSON) != 0u) {
    let clip = frame.firstPersonViewProj * world;
    out.position = vec4f(
      clip.xy,
      FIRST_PERSON_DEPTH * clip.w + (1.0 - FIRST_PERSON_DEPTH) * clip.z,
      clip.w,
    );
  } else {
    out.position = frame.viewProj * world;
  }
  out.worldPos = world.xyz;
  out.uv = in.uv * draw.uvTransform.zw + draw.uvTransform.xy;
  out.normal = safeNormalize(rotation * (in.normal.xyz * 2.0 - 1.0));
  out.tangent = safeNormalize(rotation * (in.tangent.xyz * 2.0 - 1.0));
  out.bitangent = safeNormalize(
    rotation * vec3f(in.bitangentX, in.normal.w * 2.0 - 1.0, in.tangent.w * 2.0 - 1.0),
  );
  out.color = in.color;
  return out;
}

// NiAlphaProperty alpha test (bit 9 enables, bits 10-12 select the comparison).
fn alphaTestPasses(alpha: f32) -> bool {
  let flags = draw.flags.z;
  if ((flags & 0x200u) == 0u) {
    return true;
  }
  let threshold = draw.params.z;
  switch ((flags >> 10u) & 7u) {
    case 0u: { return true; }
    case 1u: { return alpha < threshold; }
    case 2u: { return alpha == threshold; }
    case 3u: { return alpha <= threshold; }
    case 4u: { return alpha > threshold; }
    case 5u: { return alpha != threshold; }
    case 6u: { return alpha >= threshold; }
    default: { return false; }
  }
}
