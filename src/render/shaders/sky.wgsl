// The sky: the atmosphere dome, stars, sun, moons and cloud layers from the game's sky
// meshes, drawn as directions (w = 0) so that only the camera's rotation applies; the
// reversed-Z projection puts them on the far plane. ASCII only.

struct SkyColors {
  horizon: vec4f,
  lower: vec4f,
  upper: vec4f,
};

struct SkyDraw {
  // Tint (rgb) and opacity (a).
  color: vec4f,
  // x: weight of texture A over texture B, zw: texture offset (cloud scrolling).
  params: vec4f,
  // Billboards: direction (xyz) and half size as the tangent of the half angle (w).
  billboard: vec4f,
  // Rotation of the mesh (the star sphere).
  rotation: mat4x4f,
};

@group(1) @binding(0) var<uniform> sky: SkyColors;
@group(1) @binding(1) var<uniform> draw: SkyDraw;
@group(2) @binding(0) var skySampler: sampler;
@group(2) @binding(1) var textureA: texture_2d<f32>;
@group(2) @binding(2) var textureB: texture_2d<f32>;

struct MeshIn {
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
};

struct SkyOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

fn directionToClip(direction: vec3f) -> vec4f {
  return frame.viewProj * vec4f(direction, 0.0);
}

@vertex
fn vs_mesh(input: MeshIn) -> SkyOut {
  var out: SkyOut;
  out.clip = directionToClip((draw.rotation * vec4f(input.position, 0.0)).xyz);
  out.uv = input.uv + draw.params.zw;
  out.color = input.color;
  return out;
}

@vertex
fn vs_billboard(@builtin(vertex_index) index: u32) -> SkyOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let corner = corners[index];
  let d = normalize(draw.billboard.xyz);
  var right = cross(d, vec3f(0.0, 0.0, 1.0));
  if (length(right) < 1e-4) {
    right = vec3f(1.0, 0.0, 0.0);
  }
  right = normalize(right);
  let up = cross(right, d);
  var out: SkyOut;
  out.clip = directionToClip(d + (right * corner.x + up * corner.y) * draw.billboard.w);
  out.uv = vec2f(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  out.color = vec4f(1.0);
  return out;
}

// Atmosphere: the vertex colour weights the horizon (r), lower sky (g) and upper sky (b).
@fragment
fn fs_atmosphere(input: SkyOut) -> @location(0) vec4f {
  let c = sky.horizon.rgb * input.color.r + sky.lower.rgb * input.color.g + sky.upper.rgb * input.color.b;
  return vec4f(c, input.color.a);
}

fn texel(uv: vec2f) -> vec4f {
  let a = textureSample(textureA, skySampler, uv);
  let b = textureSample(textureB, skySampler, uv);
  return mix(b, a, draw.params.x);
}

// Stars, clouds and moons: texture times tint; the vertex alpha fades cloud edges.
@fragment
fn fs_textured(input: SkyOut) -> @location(0) vec4f {
  let t = texel(input.uv);
  return vec4f(t.rgb * draw.color.rgb, t.a * draw.color.a * input.color.a);
}

// The dark side of a moon hides the stars behind it: the sky's colour in the moon's shape.
@fragment
fn fs_mask(input: SkyOut) -> @location(0) vec4f {
  let t = texel(input.uv);
  return vec4f(draw.color.rgb, t.a * draw.color.a);
}

// Sun and sun glare: added to the sky (premultiplied by the texture's alpha).
@fragment
fn fs_additive(input: SkyOut) -> @location(0) vec4f {
  let t = texel(input.uv);
  return vec4f(t.rgb * t.a * draw.color.rgb * draw.color.a, 0.0);
}
