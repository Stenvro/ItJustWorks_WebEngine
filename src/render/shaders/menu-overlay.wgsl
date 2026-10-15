// The menus' 3D (a book, an inspected item, a lock) over the finished image: the overlay was
// drawn into a cleared, transparent HDR target; its coverage is the share of samples it drew
// depth into (or its blended alpha). The colour is shown as rendered (no eye adaptation or
// grading, which belong to the world behind it), with the player's gamma, premultiplied over
// the image. The local map (fs_local_map) is laid over it as the game's ISLocalMap makes its
// picture (adapted from Community Shaders' ISLocalMap.hlsl, MIT, Copyright (c) 2022 Ilya
// Perapechka; see THIRD_PARTY_NOTICES.md), on its frame's black field. ASCII only.

struct Overlay {
  // x: 1 / the player's gamma (fGamma), y: 1 hides the world (black where nothing is drawn);
  // the local map's: z its frame's fade, w the pixels between its edge filter's samples.
  param: vec4f,
  // The local map's picture and its frame's black field (canvas pixels: x0, y0, x1, y1).
  picture: vec4f,
  field: vec4f,
  // Its fog of war: canvas pixels to the seen raster's 0..1 (u: a, b, c, 1 when there is
  // fog; v: d, e, f).
  fogU: vec4f,
  fogV: vec4f,
};

@group(0) @binding(0) var<uniform> overlay: Overlay;
@group(0) @binding(1) var color: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_multisampled_2d;
@group(0) @binding(3) var fog: texture_2d<f32>;
@group(0) @binding(4) var fogSampler: sampler;

@vertex
fn vs_fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_composite(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let texel = vec2i(position.xy);
  let samples = textureNumSamples(depth);
  var drawn = 0.0;
  for (var i = 0u; i < samples; i++) {
    // Reversed Z: cleared to 0 (far).
    if (textureLoad(depth, texel, i) > 0.0) {
      drawn += 1.0;
    }
  }
  let resolved = textureLoad(color, texel, 0);
  let coverage = select(clamp(max(drawn / f32(samples), resolved.a), 0.0, 1.0), 1.0, overlay.param.y > 0.5);
  if (coverage <= 0.0) {
    discard;
  }
  // Opaque: the colour as drawn over black.
  let divisor = select(coverage, 1.0, overlay.param.y > 0.5);
  let shown = clamp(max(resolved.rgb, vec3f(0.0)) / divisor, vec3f(0.0), vec3f(1.0));
  return vec4f(pow(shown, vec3f(overlay.param.x)) * coverage, coverage);
}

/** The drawn image at a pixel, inside the picture (its sides repeated). */
fn localMapTexel(pixel: vec2i) -> vec3f {
  let low = vec2i(overlay.picture.xy);
  let high = vec2i(overlay.picture.zw) - 1;
  return clamp(textureLoad(color, clamp(pixel, low, high), 0).rgb, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_local_map(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = position.xy;
  let field = overlay.field;
  if (p.x < field.x || p.y < field.y || p.x >= field.z || p.y >= field.w) {
    discard;
  }
  let fade = overlay.param.z;
  // The frame's black field, at the 80% of its clip.
  let fieldAlpha = 0.8 * fade;
  let picture = overlay.picture;
  if (p.x < picture.x || p.y < picture.y || p.x >= picture.z || p.y >= picture.w) {
    return vec4f(0.0, 0.0, 0.0, fieldAlpha);
  }
  // ISLocalMap: edges (a Sobel filter over the neighbours) and luminance make the picture.
  let texel = vec2i(p);
  let step = i32(overlay.param.w);
  let weight = vec3f(0.5, 0.25, 1.0);
  var lr = vec3f(0.0);
  var bt = vec3f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) {
        continue;
      }
      let around = localMapTexel(texel + vec2i(i, j) * step);
      let centerMul = select(1.0, 2.0, i == 0 || j == 0);
      lr += -f32(i) * centerMul * weight * around;
      bt += -f32(j) * centerMul * weight * around;
    }
  }
  let center = localMapTexel(texel);
  let luminance = dot(center, vec3f(0.3, 0.59, 0.11));
  // The fog over what the player has not seen (the game's alpha channel: LOCALMAP_FOGOFWAR).
  var unseen = 0.0;
  if (overlay.fogU.w > 0.5) {
    let fogUv = vec2f(
      dot(overlay.fogU.xyz, vec3f(p, 1.0)),
      dot(overlay.fogV.xyz, vec3f(p, 1.0)),
    );
    let inside = all(fogUv >= vec2f(0.0)) && all(fogUv <= vec2f(1.0));
    unseen = select(1.0, 1.0 - textureSampleLevel(fog, fogSampler, fogUv, 0.0).r, inside);
  }
  let opacity = (dot(4.0 * (lr * lr + bt * bt), vec3f(1.75)) + luminance) * (1.0 - unseen);
  let uv = (p - picture.xy) / max(picture.zw - picture.xy, vec2f(1.0));
  let sides = vec2f(1.0) - pow(2.0 * abs(uv - 0.5), vec2f(5.0));
  let alpha = clamp(opacity * sides.x * sides.y, 0.0, 1.0) * fade;
  let grey = pow(clamp(1.04 * luminance, 0.0, 1.0), overlay.param.x);
  return vec4f(vec3f(grey * alpha), 1.0 - (1.0 - alpha) * (1.0 - fieldAlpha));
}
