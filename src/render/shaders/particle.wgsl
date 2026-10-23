// Particles: quads facing the camera (or stretched along their velocity), and the ribbon
// segments of strip particles, built from the instance data the simulation writes
// (particle-sim.ts) and shaded like BSEffectShaderProperty (effect.wgsl). ASCII only.

struct ParticleIn {
  @builtin(vertex_index) vertex: u32,
  // World position (xyz) and half size (w).
  @location(0) positionSize: vec4f,
  @location(1) color: vec4f,
  // Atlas frame: u, v, width, height.
  @location(2) rect: vec4f,
  // Velocity (quads turn along it if non-zero) or segment vector (xyz); rotation (w).
  @location(3) axisRotation: vec4f,
};

struct ParticleOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
};

const CORNERS = array<vec2f, 6>(
  vec2f(-1.0, -1.0),
  vec2f(1.0, -1.0),
  vec2f(1.0, 1.0),
  vec2f(-1.0, -1.0),
  vec2f(1.0, 1.0),
  vec2f(-1.0, 1.0),
);

fn particleOut(world: vec3f, uv: vec2f, color: vec4f) -> ParticleOut {
  var out: ParticleOut;
  out.position = frame.viewProj * vec4f(world, 1.0);
  out.worldPos = world;
  out.uv = uv;
  out.color = color;
  return out;
}

@vertex
fn vs_particle(in: ParticleIn) -> ParticleOut {
  let corner = CORNERS[in.vertex];
  let center = in.positionSize.xyz;
  let size = in.positionSize.w;
  var right = frame.cameraRight.xyz;
  var up = frame.cameraUp.xyz;
  let forward = normalize(center - frame.cameraPos.xyz);
  let axis = in.axisRotation.xyz;
  let along = axis - forward * dot(axis, forward);
  if (length(along) > 1e-3) {
    // Velocity orientation: the quad's up follows the velocity as seen from the camera.
    up = normalize(along);
    right = normalize(cross(forward, up));
  } else {
    let c = cos(in.axisRotation.w);
    let s = sin(in.axisRotation.w);
    let turned = right * c + up * s;
    up = up * c - right * s;
    right = turned;
  }
  // Aspect ratio: height over width.
  let world = center + right * (corner.x * size) + up * (corner.y * size * draw.params.x);
  let uv = in.rect.xy + vec2f(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5) * in.rect.zw;
  return particleOut(world, uv, in.color);
}

@vertex
fn vs_strip(in: ParticleIn) -> ParticleOut {
  let corner = CORNERS[in.vertex];
  let start = in.positionSize.xyz;
  let segment = in.axisRotation.xyz;
  // Along the segment (0 at its start, 1 at its end) and across it, facing the camera.
  let t = corner.y * 0.5 + 0.5;
  let p = start + segment * t;
  let toCamera = normalize(frame.cameraPos.xyz - p);
  var side = cross(segment, toCamera);
  if (length(side) < 1e-5) {
    side = frame.cameraRight.xyz;
  }
  let world = p + normalize(side) * (corner.x * in.positionSize.w);
  let uv = in.rect.xy + vec2f(corner.x * 0.5 + 0.5, t) * in.rect.zw;
  return particleOut(world, uv, in.color);
}

// A ribbon of procedural lightning (lightning.ts): one segment of a bolt, across a fixed side
// (the bolt's X or Z axis, not turned to the camera), its opacity from one end to the other.
// positionSize: start (xyz), opacity at the start (w); color: colour (rgb), opacity at the end
// (a); rect: v at the start and the end, side (xy); axisRotation: segment (xyz), side (z).
@vertex
fn vs_ribbon(in: ParticleIn) -> ParticleOut {
  let corner = CORNERS[in.vertex];
  let t = corner.y * 0.5 + 0.5;
  let side = vec3f(in.rect.z, in.rect.w, in.axisRotation.w);
  let world = in.positionSize.xyz + in.axisRotation.xyz * t + side * corner.x;
  let uv = vec2f(corner.x * 0.5 + 0.5, mix(in.rect.x, in.rect.y, t));
  let alpha = mix(in.positionSize.w, in.color.a, t);
  return particleOut(world, uv, vec4f(in.color.rgb, alpha));
}

@fragment
fn fs_particle(in: ParticleOut) -> @location(0) vec4f {
  let uv = in.uv * draw.uvTransform.zw + draw.uvTransform.xy;
  let source = textureSample(diffuseMap, linearSampler, uv);
  let toCamera = normalize(frame.cameraPos.xyz - in.worldPos);
  // The particle's colour (BSPSysSimpleColorModifier or the emitter's) acts as the vertex
  // colour.
  return effectShade(source, in.color, toCamera, in.worldPos, in.position);
}
