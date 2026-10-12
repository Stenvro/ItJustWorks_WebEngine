// Grass: one grass mesh drawn many times (instances placed per cell), swaying with the wind,
// shrinking away at the fade distance, lit with the ground's normal. Prepended with
// frame.wgsl. ASCII only.

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

@fragment
fn fs_grass(input: GrassOut) -> @location(0) vec4f {
  let texel = textureSample(diffuseMap, linearSampler, input.uv);
  if (grass.params.x >= 0.0 && texel.a < grass.params.x) {
    discard;
  }
  let toCamera = safeNormalize(frame.cameraPos.xyz - input.worldPos);
  let shadow = sunShadow(input.worldPos, input.normal);
  let light = lightAt(input.normal, input.worldPos, toCamera, 1.0, false, shadow);
  let color = texel.rgb * input.color * light.diffuse;
  return vec4f(applyFog(color, input.worldPos), 1.0);
}
