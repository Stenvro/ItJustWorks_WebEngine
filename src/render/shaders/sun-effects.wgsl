// The sun's lens flare over the HDR scene (sun-effects.ts): the flare's sprites, added along the
// sun's screen line, faded by how much of the sun the scene covers (the depth around it, read
// in the vertex shader). The volumetric lighting is volumetric.wgsl.

@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(3) var depth: texture_2d<f32>;

struct Sprite {
  // Centre (uv), half size (uv).
  place: vec4f,
  // Colour (rgb) and opacity.
  color: vec4f,
  // Rotation (radians), shrinks when covered (0/1), the sun's uv.
  params: vec4f,
};

@group(0) @binding(5) var<uniform> sprite: Sprite;
@group(0) @binding(4) var spriteTexture: texture_2d<f32>;

struct SpriteOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

/** How much of the sun is seen: the share of sky in a small grid of depth texels around it. */
fn sunVisibility(sun: vec2f) -> f32 {
  let size = vec2f(textureDimensions(depth));
  var seen = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let uv = sun + vec2f(f32(x), f32(y)) * vec2f(0.004 / (size.x / size.y), 0.004);
      if (all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
        let d = textureLoad(depth, vec2i(uv * size), 0).r;
        seen += select(0.0, 1.0, d <= 0.0);
      }
    }
  }
  return seen / 25.0;
}

@vertex
fn vs_sprite(@builtin(vertex_index) index: u32) -> SpriteOut {
  let corner = vec2f(f32(index & 1u), f32((index >> 1u) & 1u)) * 2.0 - 1.0;
  let visible = sunVisibility(sprite.params.zw);
  let scale = select(1.0, visible, sprite.params.y > 0.5);
  let c = cos(sprite.params.x);
  let s = sin(sprite.params.x);
  let local = corner * sprite.place.zw * scale;
  let turned = vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
  let uv = sprite.place.xy + turned;
  var out: SpriteOut;
  out.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.uv = corner * 0.5 + 0.5;
  out.color = vec4f(sprite.color.rgb, sprite.color.a * visible);
  return out;
}

@fragment
fn fs_sprite(in: SpriteOut) -> @location(0) vec4f {
  let texel = textureSampleLevel(spriteTexture, linearSampler, in.uv, 0.0);
  return vec4f(texel.rgb * texel.a * in.color.rgb * in.color.a, 1.0);
}
