// The engine's "improved snow" (bEnableImprovedSnow): surfaces that are snow (landscape textures
// flagged as snow, statics considered snow, projected snow) get a rim highlight instead of
// their specular, and static sparkles. The engine writes both into a snow buffer and adds
// them in its ambient-occlusion composite pass (Community Shaders ISSAOComposite.hlsl and
// Lighting.hlsl GetSnowSpecularColor); here each shader adds them itself: the rim before fog,
// the sparkles after it. INI values are the game's defaults (BethINI database).
// Appended after frame.wgsl. ASCII only.

// fSnowRimLightIntensity, fSnowGeometrySpecPower, fSnowNormalSpecPower (bEnableSnowRimLighting).
const SNOW_RIM_INTENSITY = 0.3;
const SNOW_GEOMETRY_SPEC_POWER = 3.0;
const SNOW_NORMAL_SPEC_POWER = 2.0;
// fSparklesIntensity, fSparklesSpecularPower, fSparklesDensity, fSparklesSize,
// fSparklesMaxDistance, fShadowSparkleIntensity, fSnowSparklesColorR/G/B (bToggleSparkles).
const SPARKLES_INTENSITY = 1.0;
const SPARKLES_SPECULAR_POWER = 2.0;
const SPARKLES_DENSITY = 0.85;
const SPARKLES_SIZE = 6.0;
const SPARKLES_MAX_DISTANCE = 1000.0;
const SPARKLES_SHADOW_INTENSITY = 0.25;
const SPARKLES_COLOR = vec3f(1.0, 1.0, 1.0);

// Rim highlight of snow: brighter where the surface and its normal map turn away from the
// camera. Added (times the snow mask) to the lit colour.
fn snowRimSpecular(geometryNormal: vec3f, n: vec3f, toCamera: vec3f) -> f32 {
  let normalFactor = 1.0 - clamp(dot(n, toCamera), 0.0, 1.0);
  let geometryFactor = 1.0 - clamp(dot(geometryNormal, toCamera), 0.0, 1.0);
  return SNOW_RIM_INTENSITY * pow(geometryFactor, SNOW_GEOMETRY_SPEC_POWER) *
    pow(normalFactor, SNOW_NORMAL_SPEC_POWER);
}

fn snowMod289(x: vec4f) -> vec4f {
  return x - floor(x / 289.0) * 289.0;
}

fn snowPermute(x: vec4f) -> vec4f {
  return snowMod289((x * 34.0 + 1.0) * x);
}

// 3D simplex noise in -1..1 (Ashima Arts / Gustavson, as the engine's composite shader uses).
fn snowSimplexNoise(v: vec3f) -> f32 {
  var i = floor(v + dot(v, vec3f(1.0 / 3.0)));
  let x0 = v - i + dot(i, vec3f(1.0 / 6.0));
  let g = step(x0.yzx, x0.xyz);
  let l = 1.0 - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);
  let x1 = x0 - i1 + 1.0 / 6.0;
  let x2 = x0 - i2 + 1.0 / 3.0;
  let x3 = x0 - 0.5;
  i = i - floor(i / 289.0) * 289.0;
  let p = snowPermute(
    snowPermute(snowPermute(i.z + vec4f(0.0, i1.z, i2.z, 1.0)) + i.y + vec4f(0.0, i1.y, i2.y, 1.0)) +
      i.x + vec4f(0.0, i1.x, i2.x, 1.0),
  );
  let n = 7.0;
  let j = p - floor(p / (n * n)) * (n * n);
  let xs = floor(j / n);
  let ys = j - floor(j / n) * n;
  let x = xs * (2.0 / n) + (1.0 / (2.0 * n) - 1.0);
  let y = ys * (2.0 / n) + (1.0 / (2.0 * n) - 1.0);
  let h = 1.0 - abs(x) - abs(y);
  let b0 = vec4f(x.xy, y.xy);
  let b1 = vec4f(x.zw, y.zw);
  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(h, vec4f(0.0));
  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;
  var p0 = vec3f(a0.xy, h.x);
  var p1 = vec3f(a0.zw, h.y);
  var p2 = vec3f(a1.xy, h.z);
  var p3 = vec3f(a1.zw, h.w);
  let norm = 1.79284291400159 - 0.85373472095314 *
    vec4f(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  let m = max(0.6 - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
  let m4 = m * m * m * m;
  return 42.0 * dot(m4, vec4f(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// Sparkles on snow: fixed bright points in world space (a threshold on 3D noise), dimmer in
// the sun's shadow and fading out with distance. Added (times the snow mask) after fog.
fn snowSparkles(worldPos: vec3f, sunShadow: f32) -> vec3f {
  let noise = 0.5 * (snowSimplexNoise(0.07 * SPARKLES_SIZE * worldPos) + 1.0);
  let specular = pow(clamp(noise, 0.0, 1.0), SPARKLES_SPECULAR_POWER);
  let distance = length(worldPos - frame.cameraPos.xyz);
  let attenuation = 1.0 - smoothstep(0.0, 1.0, distance / SPARKLES_MAX_DISTANCE);
  let shadowing = mix(sunShadow, 1.0, SPARKLES_SHADOW_INTENSITY);
  let sparkle = SPARKLES_INTENSITY * specular * step(SPARKLES_DENSITY, specular) * shadowing *
    attenuation;
  return SPARKLES_COLOR * sparkle;
}
