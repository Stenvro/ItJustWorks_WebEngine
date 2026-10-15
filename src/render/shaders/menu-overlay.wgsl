// The menus' 3D (a book, an inspected item, a lock) over the finished image: the overlay was
// drawn into a cleared, transparent HDR target; its coverage is the share of samples it drew
// depth into (or its blended alpha). The colour is shown as rendered (no eye adaptation or
// grading, which belong to the world behind it), with the player's gamma, premultiplied over
// the image. ASCII only.

struct Overlay {
  // x: 1 / the player's gamma (fGamma).
  param: vec4f,
};

@group(0) @binding(0) var<uniform> overlay: Overlay;
@group(0) @binding(1) var color: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_multisampled_2d;

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
  let coverage = clamp(max(drawn / f32(samples), resolved.a), 0.0, 1.0);
  if (coverage <= 0.0) {
    discard;
  }
  let shown = clamp(max(resolved.rgb, vec3f(0.0)) / coverage, vec3f(0.0), vec3f(1.0));
  return vec4f(pow(shown, vec3f(overlay.param.x)) * coverage, coverage);
}
