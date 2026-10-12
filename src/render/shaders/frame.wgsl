// Per-frame data shared by every world shader (objects, terrain, water): camera, the
// directional light, directional ambient, fog and point lights. Prepended to each shader
// module in TypeScript. ASCII only.

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
  // Point light count, fog enabled, debug view, unused.
  counts: vec4u,
  // Time in seconds, unused.
  time: vec4f,
};

struct PointLight {
  position: vec3f,
  radius: f32,
  color: vec3f,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> pointLights: array<PointLight>;

fn safeNormalize(v: vec3f) -> vec3f {
  let len = length(v);
  return select(vec3f(0.0, 0.0, 1.0), v / len, len > 1e-6);
}

// Ambient light for a world-space normal, blended from the six directional ambient colours.
fn directionalAmbient(n: vec3f) -> vec3f {
  let w = n * n;
  let x = select(frame.ambient[1].rgb, frame.ambient[0].rgb, n.x >= 0.0);
  let y = select(frame.ambient[3].rgb, frame.ambient[2].rgb, n.y >= 0.0);
  let z = select(frame.ambient[5].rgb, frame.ambient[4].rgb, n.z >= 0.0);
  return x * w.x + y * w.y + z * w.z;
}

struct Lighting {
  diffuse: vec3f,
  specular: vec3f,
};

// Ambient, the directional light and point lights (brightness falls off as 1 - d^2/r^2).
// TODO(M4): shadows, the engine's per-object light limit.
fn lightAt(n: vec3f, worldPos: vec3f, toCamera: vec3f, glossiness: f32, specular: bool) -> Lighting {
  var result: Lighting;
  let toSun = frame.sunDir.xyz;
  let sunNDotL = max(dot(n, toSun), 0.0);
  result.diffuse = directionalAmbient(n) + frame.sunColor.rgb * sunNDotL;
  result.specular = vec3f(0.0);
  if (specular && sunNDotL > 0.0) {
    let halfway = safeNormalize(toSun + toCamera);
    result.specular += frame.sunColor.rgb * pow(max(dot(n, halfway), 0.0), glossiness);
  }
  for (var i = 0u; i < frame.counts.x; i++) {
    let light = pointLights[i];
    let offset = light.position - worldPos;
    let distanceSquared = dot(offset, offset);
    let radiusSquared = light.radius * light.radius;
    if (distanceSquared >= radiusSquared) {
      continue;
    }
    let toLight = offset * inverseSqrt(max(distanceSquared, 1e-4));
    let attenuation = 1.0 - distanceSquared / radiusSquared;
    let nDotL = max(dot(n, toLight), 0.0);
    result.diffuse += light.color * nDotL * attenuation;
    if (specular && nDotL > 0.0) {
      let halfway = safeNormalize(toLight + toCamera);
      result.specular += light.color * pow(max(dot(n, halfway), 0.0), glossiness) * attenuation;
    }
  }
  return result;
}

// Fog: blends from the near to the far colour with distance.
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
