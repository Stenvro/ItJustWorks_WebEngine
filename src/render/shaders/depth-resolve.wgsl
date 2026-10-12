// Copies the multisampled depth buffer (first sample) into a single-sample float texture
// that the water shader can read. ASCII only.

@group(0) @binding(0) var depth: texture_depth_multisampled_2d;

@vertex
fn vs_fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_resolve(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(depth, vec2i(position.xy), 0), 0.0, 0.0, 0.0);
}
