// Screen blood (src/render/screen-blood.ts): each splatter a turned quad over the finished image,
// its shape from the alpha texture, its colour from the colour texture; the flares added on top.

@group(0) @binding(0) var bloodSampler: sampler;
@group(0) @binding(1) var shapeTexture: texture_2d<f32>;
@group(0) @binding(2) var colorTexture: texture_2d<f32>;
@group(0) @binding(3) var flareTexture: texture_2d<f32>;

struct SplatIn {
  @builtin(vertex_index) vertex: u32,
  // Middle (ndc) and half size (ndc).
  @location(0) center: vec2f,
  @location(1) half: vec2f,
  // Rotation (radians), alpha.
  @location(2) params: vec2f,
}

struct SplatOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) alpha: f32,
}

@vertex
fn vs_splat(input: SplatIn) -> SplatOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let corner = corners[input.vertex];
  let c = cos(input.params.x);
  let s = sin(input.params.x);
  let turned = vec2f(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  var out: SplatOut;
  out.position = vec4f(input.center + turned * input.half, 0.0, 1.0);
  out.uv = corner * vec2f(0.5, -0.5) + vec2f(0.5);
  out.alpha = input.params.y;
  return out;
}

@fragment
fn fs_splat(input: SplatOut) -> @location(0) vec4f {
  let shape = textureSample(shapeTexture, bloodSampler, input.uv);
  let color = textureSample(colorTexture, bloodSampler, input.uv);
  return vec4f(color.rgb, shape.r * shape.a * input.alpha);
}

@fragment
fn fs_flare(input: SplatOut) -> @location(0) vec4f {
  let flare = textureSample(flareTexture, bloodSampler, input.uv);
  return vec4f(flare.rgb * flare.a * input.alpha, 1.0);
}
