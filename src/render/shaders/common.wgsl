// Shared declarations for the object shaders (lighting and effect). Prepended to each
// shader module in TypeScript. ASCII only.

struct Frame {
  viewProj: mat4x4f,
  cameraPos: vec4f,
  // Direction towards the directional light (normalized) and its colour.
  sunDir: vec4f,
  sunColor: vec4f,
  // Directional ambient: light arriving from +X, -X, +Y, -Y, +Z, -Z.
  ambient: array<vec4f, 6>,
  fogNearColor: vec4f,
  fogFarColor: vec4f,
  // Fog near, far, power, max.
  fogParams: vec4f,
  // Point light count, fog enabled.
  counts: vec4u,
  _pad: vec4f,
};

struct PointLight {
  position: vec3f,
  radius: f32,
  color: vec3f,
  _pad: f32,
};

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
  // Shader flags 1 and 2, NiAlphaProperty flags, shader type.
  flags: vec4u,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> pointLights: array<PointLight>;
@group(1) @binding(0) var<uniform> draw: Draw;
@group(2) @binding(0) var linearSampler: sampler;
// Lighting: diffuse. Effect: source texture.
@group(2) @binding(1) var diffuseMap: texture_2d<f32>;
@group(2) @binding(2) var normalMap: texture_2d<f32>;
// Lighting: glow map. Effect: greyscale palette.
@group(2) @binding(3) var glowMap: texture_2d<f32>;
@group(2) @binding(4) var envMap: texture_cube<f32>;
@group(2) @binding(5) var envMask: texture_2d<f32>;

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

fn worldRotation() -> mat3x3f {
  return mat3x3f(draw.world[0].xyz, draw.world[1].xyz, draw.world[2].xyz);
}

fn safeNormalize(v: vec3f) -> vec3f {
  let len = length(v);
  return select(vec3f(0.0, 0.0, 1.0), v / len, len > 1e-6);
}

@vertex
fn vs_main(in: VertexIn) -> VertexOut {
  let world = draw.world * vec4f(in.position, 1.0);
  let rotation = worldRotation();
  var out: VertexOut;
  out.position = frame.viewProj * world;
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

// Ambient light for a world-space normal, blended from the six directional ambient colours.
fn directionalAmbient(n: vec3f) -> vec3f {
  let w = n * n;
  let x = select(frame.ambient[1].rgb, frame.ambient[0].rgb, n.x >= 0.0);
  let y = select(frame.ambient[3].rgb, frame.ambient[2].rgb, n.y >= 0.0);
  let z = select(frame.ambient[5].rgb, frame.ambient[4].rgb, n.z >= 0.0);
  return x * w.x + y * w.y + z * w.z;
}

// Cell fog: blends from the near to the far colour with distance.
fn applyFog(color: vec3f, worldPos: vec3f) -> vec3f {
  if (frame.counts.y == 0u) {
    return color;
  }
  let distance = length(worldPos - frame.cameraPos.xyz);
  let near = frame.fogParams.x;
  let far = max(frame.fogParams.y, near + 1.0);
  let t = clamp((distance - near) / (far - near), 0.0, 1.0);
  let amount = min(pow(t, max(frame.fogParams.z, 0.01)), select(1.0, frame.fogParams.w, frame.fogParams.w > 0.0));
  let fogColor = mix(frame.fogNearColor.rgb, frame.fogFarColor.rgb, t);
  return mix(color, fogColor, amount);
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
