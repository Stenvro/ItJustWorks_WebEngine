// M0-pijplijncheck: fullscreen-driehoek met een licht bewegend verloop.
// TODO(M4): vervangen door de echte hemel (WTHR/CLMT, sky-meshes en weer).

struct Frame {
  time: f32,
};

@group(0) @binding(0) var<uniform> frame: Frame;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  // Drie hoeken die samen het hele scherm bedekken.
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: VertexOut;
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let horizon = vec3f(0.62, 0.66, 0.70);
  let zenith = vec3f(0.16, 0.23, 0.34);
  let shimmer = 0.015 * sin(frame.time * 0.4 + in.uv.x * 4.0);
  let color = mix(horizon, zenith, smoothstep(0.0, 1.0, in.uv.y)) + shimmer;
  return vec4f(color, 1.0);
}
