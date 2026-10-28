// Grass: one grass mesh drawn many times (instances placed per cell), swaying with the wind,
// shrinking away at the fade distance, lit with the ground's normal; fogged by the composite
// (as the engine's grass shader leaves its fog to ISSAOComposite). Prepended with frame.wgsl.
// ASCII only.

struct GrassDraw {
  // x: seconds per sway (wave period), y: wind strength, z: fade start, w: fade range.
  wave: vec4f,
  // x: alpha test threshold (0..1, or -1: none), y: vertex lighting (1) or ground normal (0).
  params: vec4f,
};

@group(1) @binding(0) var<uniform> grass: GrassDraw;
@group(2) @binding(0) var linearSampler: sampler;
@group(2) @binding(1) var diffuseMap: texture_2d<f32>;

struct GrassIn {
  @location(0) position: vec3f,
  @location(2) uv: vec2f,
  @location(3) normal: vec4f,
  @location(5) color: vec4f,
  // Instance: position (xyz) and rotation (w).
  @location(6) placement: vec4f,
  // Instance: scale across, scale up, shade, unused.
  @location(7) look: vec4f,
  // Instance: ground normal.
  @location(8) ground: vec4f,
};

struct GrassOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) uv: vec2f,
  @location(2) normal: vec3f,
  @location(3) color: vec3f,
};

@vertex
fn vs_grass(input: GrassIn) -> GrassOut {
  let base = input.placement.xyz;
  let distance = length(base - frame.cameraPos.xyz);
  let fade = 1.0 - clamp((distance - grass.wave.z) / max(grass.wave.w, 1.0), 0.0, 1.0);
  let c = cos(input.placement.w);
  let s = sin(input.placement.w);
  var local = vec3f(
    (input.position.x * c - input.position.y * s) * input.look.x,
    (input.position.x * s + input.position.y * c) * input.look.x,
    input.position.z * input.look.y,
  ) * fade;
  // Sway: the higher a vertex, the further it moves, in waves across the field.
  let phase = (base.x + base.y) * 0.002;
  let period = max(grass.wave.x, 1.0);
  let wind = 0.3 + frame.time.y;
  let sway = sin(frame.time.x * 6.2831853 / period * 60.0 + phase) * grass.wave.y * wind;
  local += vec3f(sway, sway * 0.5, 0.0) * max(local.z, 0.0) * 0.08;
  // Fit to slope: tilt the plant's up axis to the ground normal.
  let up = safeNormalize(input.ground.xyz);
  var right = cross(vec3f(0.0, 1.0, 0.0), up);
  right = select(vec3f(1.0, 0.0, 0.0), normalize(right), length(right) > 1e-4);
  let forward = cross(up, right);
  let world = base + right * local.x + forward * local.y + up * local.z;
  var out: GrassOut;
  out.position = frame.viewProj * vec4f(world, 1.0);
  out.worldPos = world;
  out.uv = input.uv;
  let vertexNormal = safeNormalize(input.normal.xyz * 2.0 - 1.0);
  out.normal = select(up, vertexNormal, grass.params.y > 0.5);
  out.color = input.color.rgb * input.look.z;
  return out;
}

// The colour (unfogged: the composite fogs it) and the G-buffer.
struct GrassPixel {
  @location(0) color: vec4f,
  @location(1) gbuffer: vec4f,
};

@fragment
fn fs_grass(input: GrassOut) -> GrassPixel {
  let texel = textureSample(diffuseMap, linearSampler, input.uv);
  let toCamera = safeNormalize(frame.cameraPos.xyz - input.worldPos);
  // The engine's grass writes the normal of its triangle (from the position's derivatives)
  // and no snow: what lies under a plant is not seen there.
  var face = safeNormalize(cross(dpdx(input.worldPos), dpdy(input.worldPos)));
  face = select(face, -face, dot(face, toCamera) < 0.0);
  if (grass.params.x >= 0.0 && texel.a < grass.params.x) {
    discard;
  }
  let shadow = sunShadow(input.worldPos, input.normal);
  // No point lights on grass: [Grass] bGrassPointLighting, off by default.
  let light = sunLightAt(input.normal, toCamera, 1.0, false, shadow);
  return GrassPixel(vec4f(texel.rgb * input.color * light.diffuse, 1.0), gbufferValue(face, 0.0, 0.0));
}
