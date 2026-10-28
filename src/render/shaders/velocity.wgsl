// Motion vectors of moving draws for the temporal anti-aliasing (taa.ts). Appended to
// shadow.wgsl (its Draw, bone palette and morphs); its own bindings stay clear of shadow.wgsl's.
// Each pixel a moving draw shows gets the offset (last frame's uv - this frame's uv) of its
// surface; pixels it does not write are found again through the depth and the camera's move.
// ASCII only.

struct Velocity {
  // This frame's view-projection as drawn (with the TAA's jitter), and without the jitter.
  viewProj: mat4x4f,
  current: mat4x4f,
  // The last frame's view-projection without the jitter.
  previous: mat4x4f,
  // The same three of first person's own view (the player's arms: common.wgsl).
  firstPersonViewProj: mat4x4f,
  firstPersonCurrent: mat4x4f,
  firstPersonPrevious: mat4x4f,
};

@group(0) @binding(5) var<uniform> velocity: Velocity;
// The opaque scene's depth (sample 0, r32float): a draw writes only where it is what was drawn.
@group(0) @binding(6) var sceneDepth: texture_2d<f32>;
// The draws' world matrices of the last frame, by draw slot (flags.w bits 8-23).
@group(2) @binding(5) var<storage, read> previousWorld: array<mat4x4f>;

const DRAW_FIRST_PERSON_FLAG = 0x8000u;

struct VelocityOut {
  @builtin(position) position: vec4f,
  @location(0) current: vec4f,
  @location(1) previous: vec4f,
};

fn velocityVertex(local: vec3f) -> VelocityOut {
  let slot = (draw.flags.w >> 8u) & 0xffffu;
  let p = vec4f(local, 1.0);
  let now = draw.world * p;
  let before = previousWorld[slot] * p;
  var out: VelocityOut;
  if ((draw.flags.z & DRAW_FIRST_PERSON_FLAG) != 0u) {
    out.position = velocity.firstPersonViewProj * now;
    out.current = velocity.firstPersonCurrent * now;
    out.previous = velocity.firstPersonPrevious * before;
  } else {
    out.position = velocity.viewProj * now;
    out.current = velocity.current * now;
    out.previous = velocity.previous * before;
  }
  return out;
}

@vertex
fn vs_velocity(@location(0) position: vec3f) -> VelocityOut {
  return velocityVertex(position);
}

// Skinned draws: this frame's pose under both world matrices (the instance's own move; the
// limbs' move within it is not followed).
@vertex
fn vs_velocity_skinned(
  @location(0) position: vec3f,
  @location(6) weights: vec4f,
  @location(7) indices: vec4u,
  @builtin(vertex_index) vertex: u32,
) -> VelocityOut {
  return velocityVertex(skinned(morphed(position, vertex), weights, indices));
}

// Clip space to uv (0..1, y down).
fn clipUv(clip: vec4f) -> vec2f {
  let ndc = clip.xy / max(clip.w, 1e-6);
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

@fragment
fn fs_velocity(input: VelocityOut) -> @location(0) vec4f {
  // Only where this surface is the one the opaque pass kept (reversed Z; the resolved depth is
  // one sample of four, so a relative tolerance).
  let scene = textureLoad(sceneDepth, vec2i(input.position.xy), 0).r;
  let depth = input.position.z;
  if (abs(depth - scene) > scene * 0.01 + 1e-7) {
    discard;
  }
  return vec4f(clipUv(input.previous) - clipUv(input.current), 1.0, 1.0);
}
