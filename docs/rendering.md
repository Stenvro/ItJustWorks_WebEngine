# Rendering

How a frame is put together (`src/render/renderer.ts`). Everything is drawn in HDR
(`rgba16float`) with 4× MSAA and reversed-Z depth (near = 1, far = 0, infinite far plane).

1. **Sun shadow map** (exteriors): 4 cascades, 2048² each (`shadow-cascades.ts`). The view
   up to 8000 units (fShadowDistance, Ultra) is cut at 700/1800/4000/8000; each slice gets an
   orthographic view from the sun around its bounding sphere, snapped to whole texels (no
   shimmer), reaching 20000 units towards the sun for casters. The sun moves with the clock
   and its shadows with it (SSE's bDisableShadowJumps: no jumps, fSunUpdateThreshold and
   fSunShadowUpdateTime unused): the light's view turns about the camera's place rounded to
   4096 units, so its texel grid slides over the scene by only the turn times the distance
   from there (turning about the world's origin, it slid nearly a texel a frame in Whiterun
   at TimeScale 20 and every shadow edge flickered). Cascades 1–2 update every
   frame, 3 every second and 4 every fourth frame; the shader samples each with the matrix it
   was rendered with. Casters: terrain and parts with `Cast_Shadows` (SLSF1 `0x200`), alpha
   tested where their NiAlphaProperty tests; not LOD; objects smaller than 3 texels of a
   cascade are left out. Receivers (`Receive_Shadows`, SLSF1 `0x100`, and terrain) take 3×3
   PCF with a normal offset of 1.5 texels; the last cascade fades out over its last tenth.
2. **Opaque pass:** the shell backdrop or the sky, terrain, tree LOD billboards and the opaque
   parts of all scenes (LOD and cells), into the colour and a G-buffer (`gbuffer.ts`: normal,
   snow mask). Parts and terrain quadrants outside the view frustum are skipped (bounding
   spheres).
3. **Screen-space passes and copies of the opaque scene:** the multisampled depth resolved
   (sample 0) into an `r32float` texture, the ambient occlusion (below) applied to the
   colour, the resolved colour copied, then the snow's subsurface scattering. The copies are
   bound in the frame group (`sceneColor`, `sceneDepth`).
4. **Water and blended pass:** water surfaces, then blended parts and particle systems of all
   scenes back to front (by bounding sphere centre).
5. **Refraction** (only with refraction shapes in view): the shapes into the refraction
   buffer, then the image-space refraction of the scene so far (below).
6. **Post-processing** (`post.ts`): the imagespace's eye adaptation, bloom, tone curve and
   grading into the canvas (see [formats/esm.md](formats/esm.md#imagespaces)), then its depth
   of field and the image-space modifiers' screen effects (below).

**Not yet:** the engine's volumetric lighting (bVolumetricLightingEnable: per-weather VOLI
records, froxel shaders ISVolumetricLighting*) and its image-based lens flare of the sun and
bright lights (bIBLFEnable, ISIBLensFlare; vanilla SSE has no LENS records, so this is its
only lens flare): TODO(M13). Their shaders are known (Community Shaders), but the values the
engine feeds them (the froxel depth distribution and its range factor, intensity and colour,
wind, the flare's ghosts and halo) are computed in the executable and documented nowhere;
they need reverse engineering, not guesses. Anti-aliasing is 4×
MSAA instead of the engine's TAA (bUseTAA).

**Frame uniforms** (`shaders/frame.wgsl`, group 0 of every world shader): camera, sun
direction and colour (times the imagespace's sunlight scale), directional ambient, fog,
point lights (storage buffer), time, the LOD mask of loaded cells (7×7 bits, see
[formats/lod.md](formats/lod.md)), the shadow cascades, the screen size and near plane, the
camera's right and up axes, the shadow map and its comparison sampler, the scene copies and a
clamping sampler. The terrain shader samples 21 textures (8 diffuse, 8 normal maps, the LOD
block texture and noise, the shadow map and the scene copies), more than WebGPU's default of
16, so the device asks for the adapter's limit (up to 32).

## Skinning

Skinned parts (`ModelPart.skin`, `skinning.ts`) keep their vertices as stored, with four
half-float weights and four bone indices each, and are drawn by the `vs_skinned` vertex
stage (`shaders/skinning.wgsl`; shadows: `shadow.wgsl`). Each placed skinned part has a bone
palette in its scene's storage buffer (`bone-palette.ts`): per bone the three rows of
`bone world × bind`, 256-byte aligned, bound as group 3 at a dynamic offset (the binding
covers 256 bones, as many as a byte can name). A vertex blends the rows by its weights
(normalised; a vertex without weights follows bone 0) and then goes on like any other
vertex, placed by its instance. Palettes start in the rest pose (the file's own bones) and
follow the bones' animated matrices every frame for models whose controllers move them; an
actor's skeleton poses them (below). Rays (decal placement) skin the vertices on the CPU
in the rest pose. 3056 vanilla meshes outside actors have skinned parts (books, banners,
flags, clothes, sacks, some plants).

**Actors** (`ModelInstance.pose`, `tints`, `partitionVisible`): an actor's palettes follow its
skeleton's pose (animation.md, Actors); its skin tone (NPC QNAM) replaces the tint of skin
shapes (skin tint, type 5) and its hair colour (CLFM) that of hair shapes (hair tint, type 6);
partitions its equipment hides are left out of the draw (only the visible index ranges are
drawn, also into the shadow map). Model-space normal maps of skinned shapes (FaceGen heads)
turn with the vertex's bones: the vertex stage passes the blended rotation as the vertex's
frame (`DRAW_SKINNED`). **FaceGen heads** (type 4) put the actor's face tint (slot 6) over the
head: `tint = 2·t·b − 2·t·b²`, `(b² + tint) · detail` with `detail = 3.984375 · (d + (1/255, 0,
1/255))` from the detail map (slot 3, a 64 grey default leaves the face as it is), the
engine's FACEGEN formula (Community Shaders' reconstruction of the SSE shader).

**Face morphs** (`face-morphs.ts`, `ModelInstance.face`): a head part's expression TRI
(phonemes, blinks, looks, moods; 44 morphs of ~1000 vertices for a head) is packed once per
TRI file into a storage buffer of half-float offsets (two u32 per morph and vertex: x|y, z),
shared by every head that uses it (the FaceGen shapes keep the TRI's vertex order). A head
part's draw gets a 256-byte region in its scene's bone buffer: count and vertex count, then
up to 30 (morph index, weight) pairs, rewritten when the face's weights change. Group 3 binds
the palette (binding 0), the region (binding 1, a second dynamic offset; other draws bind an
empty one) and the TRI's offsets (binding 2); `vs_skinned` adds the weighted offsets to the
position (by `vertex_index`) before skinning, in the shadow pass too. The game morphs each
actor's BSDynamicTriShape positions on the CPU instead; on the GPU the head stays one shared
model.

## Landscape

`shaders/terrain.wgsl`, as the vanilla landscape shader (Community Shaders' Lighting.hlsl,
LANDSCAPE and LOD_LAND_BLEND) does it:

1. Up to 8 textures blended by the vertex weights, × the vertex colour; their normal maps
   blended the same way. Gloss: the normal maps' alpha (mean 0.12 over the vanilla landscape
   maps), exponent: the blend of the land textures' SNAM.
2. Snow: a quadrant with a snow texture (LTEX INAM `0x1`) adds to every layer whose diffuse
   alpha is above zero its normal map sampled 4 times larger (1 / iLandscapeMultiNormalTilingFactor),
   combined by reoriented normal mapping. Snow mask = Σ snow flag × weight × diffuse alpha
   (bEnableSnowMask). Where the mask is above zero the specular gives way to the snow rim
   light and sparkles (below).
3. LOD blend: `1 − saturate(0.000375601 × (9625.6 − distance))` from the centre of the camera's
   cell (no blend within 6963 units, full at 9626: the outer ring of the 5 × 5 loaded cells)
   turns the land into the level-4 LOD terrain block's texture (`textures\terrain\<world>\
<world>.4.x.y.dds`, mapped by world position) × `0.8333 (p (0.37 − noise) + noise) + 0.37`
   (`textures\terrain\noise.dds` at 3 × the block UV, p from the LOD colour's brightness),
   flattens the normal and drops the gloss, so the loaded land meets the distant LOD without a
   seam. (The engine's UV factor 1/96 for the blend texture is applied to land UVs whose range
   is not documented; the level-4 block by world position is used here.)
4. The vanilla landscape shader has no parallax.

## Snow

The engine's "improved snow" (bEnableImprovedSnow, `shaders/snow.wgsl`): snow surfaces write
a rim highlight and a mask into a snow buffer that its ambient-occlusion composite adds. Here
each shader adds them directly, with the game's default settings:

- Rim: `0.3 · (1 − saturate(geometry normal · v))³ · (1 − saturate(n · v))²`
  (fSnowRimLightIntensity, fSnowGeometrySpecPower, fSnowNormalSpecPower) × the mask, added to
  the lit colour before fog.
- Sparkles: fixed bright points in world space, `step(0.85, noise²)` of 3D simplex noise at
  `0.07 × 6 × position` (fSparklesDensity, fSparklesSize, fSparklesSpecularPower 2), × lerp(sun
  shadow, 1, 0.25) (fShadowSparkleIntensity), fading out over 1000 units (fSparklesMaxDistance),
  × the mask, added after fog.
- Subsurface scattering (ISSnowSSS, `snow-sss.ts`, `shaders/snow-sss.wgsl`): after the opaque
  pass, where the G-buffer's snow mask is above zero, 11 taps along the screen at offsets ±0.08
  to ±2 × (0.078125, 0.13889) × fSnowSSSStrength (50) / distance, with per-channel weights
  (blue spreads farthest; each channel's weights sum to 1), each tap kept at the centre colour
  in proportion to its depth difference × 0.1 × fSnowSSSDepthDiff (0.5). With L the result's
  luminance (0.3, 0.59, 0.11): snow = lerp(lerp(fSnowSSSColor × fSnowSSSDarkColorIntensity,
  source, L), result, L), blended in by the mask: lit snow softens and dim snow darkens towards
  a cool tint. It is written into the multisampled colour target, which the blended pass goes
  on with. (iSnowSSSCurrentColor 2 picks an undocumented preset; the configured colour
  (0, 0, 0.08) and intensity 0.1 are used.)

## Depth of field

The imagespace's depth of field (IMGS DNAM), as the engine's ISDepthOfField shader does it for
weathers ("distant" blur, `shaders/dof.wgsl`), on the graded image: a copy at half the size is
blurred (Gaussian, 1 + blur radius pixels; TODO(M13): the engine's taps per radius), then each
pixel turns into it by `saturate((distance − focus distance) / range) × strength`, the
distance from the opaque scene's depth. Where the sky is not blurred ("no sky"), a sky pixel
is blurred only beside geometry: by the average depth 3 pixels around it and at half strength
for the share of sky there, so mountain silhouettes soften. The engine's dynamic depth of
field (bDynamicDOF, fDynamicDOF*: near and far blur around an automatic focus, the average
depth at the centre, changing after fDDOFFocusDelay over fDDOFFocusDuration; ISDepthOfField's
autofocus path) is not part of plain play: imagespace modifiers switch it on (IMAD DNAM
"DoF - Use Target" and the flags Mode Front/Back, the near and far sides), and the game plays
those for spells and other effects: a magic effect's IMAD while it lasts on the player, an
explosion's on the player within its radius, a hazard's while the player is near it,
scripts' (Image-space modifiers, below; the kill cameras' shots' modifiers: TODO(M13),
src/shell/killmove-camera.ts). Behind the tween and item menus the game applies
DOBJ IMID (ISMTween, a constant −0.15 brightness) while any of them is open, as UIBlurManager
counts them (src/shell/game-menus.ts).

A modifier's own depth of field (below) goes through the same pass with its mode: front
blurs what is nearer than the focus distance, back what is farther (ISDepthOfField without
DISTANT), each by `saturate(|distance − focus| / range) × strength`.

## Image-space modifiers

Image-space modifiers (IMAD, layout in [formats/esm.md](formats/esm.md#image-space-modifiers))
change the imagespace for a while: spells, explosions, scripts (Papyrus `ImageSpaceModifier`)
and the engine (ISMTween behind the menus, LowHealthImod). The pieces:

- `src/world/image-space-modifier.ts`: parsing and a modifier's values at a point of its
  timeline (`evaluateModifier`, `modifierKeyTime`).
- `src/world/image-space-modifiers.ts` (`ImageSpaceModifiers`): the active ones, as the
  engine's ImageSpaceManager keeps them, and the imagespace they make of a base one
  (`modify`).
- `src/shell/screen-modifiers.ts` (`ScreenModifiers`, `GameSession.imageSpaceModifiers`):
  applies them by form id (loading the records, requests in order), advances them in real
  time and lays them over the weather's imagespace (`WorldSky.frame`, so the directional
  light gets their sunlight scale too) and the cell's (`ModelViewer`). Scripts reach it
  through `ScriptWorld.imageSpace`; the shell calls `apply(formId, strength)`,
  `remove(formId)`, `crossFade(formId, seconds)`, `removeCrossFade(seconds)` and
  `popTo(from, to, strength)` itself.

Timelines: an animatable modifier plays its keys over its duration once and ends (the stack
can loop one, `ApplyOptions.loop`, but no caller asks it to: the effects that last use
modifiers that are not animatable; TODO(M13): whether the engine loops one for any caller);
one that is not animatable, or has no
duration, stays at its keys at time 0 until removed (Creation Kit: the duration is then
ignored). Papyrus: `Apply(strength)` shows a modifier (again from its start), `Remove()`
takes it off at once, `ApplyCrossFade(seconds)` puts it on the cross-fade chain and fades
from the chain's last modifier to it, the global `RemoveCrossFade(seconds)` fades the chain's
last modifier out and the one before back in (TODO(M13): check that it comes back), `PopTo
(other, strength)` takes it off and shows the other at once (on the chain in its place).

Combining, each modifier at weight w = strength × cross-fade (strength is not clamped):

- HDR and cinematic values: `value × Π (1 + (mult − 1) w) + Σ add × w` (Creation Kit:
  "multiply and add"; TODO(M13): the order of several modifiers).
- Tint and fade colour: the average of the colours weighted by alpha × w, the highest alpha
  × w as the amount (Creation Kit, for the tint; the fade likewise). The base imagespace's
  tint takes part with its amount (TODO(M13)).
- Blur radius, double vision and motion blur: the highest (Creation Kit, for blur and double
  vision). Radial blur: the strongest modifier's, its strength × w.
- Depth of field: the strongest modifier's replaces the imagespace's (TODO(M13): how the game
  mixes them). "Use target" (IMAD DNAM: radial blur centre and focus on the modifier's
  target) takes the target its caller gives: an explosion's point, a magic effect's actor
  (`ApplyOptions.target`); without one the record's centre and distance.

The screen effects (`post.ts`, `shaders/screen-effects.wgsl`) run after the depth of field,
each from the image so far into the next (two full-size half-float images, made the first
time a modifier needs them), the last into the canvas. Without modifiers the post-processing
is as before (the fade is 0 and no effect pass runs).

- Fade colour: in the HDR shader's grading, last (ISHDR `Fade`).
- Blur: a copy at half size blurred with 1 + radius pixels; the image turns into it by
  min(radius, 1) (TODO(M13): the game's ISBlur taps per radius).
- Double vision (ISDoubleVision): the average of two copies shifted apart by the strength
  (texture coordinates), turning into the blurred copy towards the edges when a blur runs.
  The shift sways with time (the Creation Kit: it "animates automatically"; TODO(M13): the
  game's sway).
- Radial blur (ISRadialBlur): 2 × 8 + 1 samples along the line to the centre, spaced by
  `0.5 × (c(d, start, ramp up) − c(d, down start, ramp down))` with
  `c(d, s, r) = strength (1 − 1 / (r max(d − s, 0) + 1))` at distance d from the centre
  (TODO(M13): the game's step count per quality).
- Motion blur: the previous frame's result kept by s / (1 + s) per 60th of a second
  (TODO(M13): calibrate).

## Ambient occlusion

The engine's SAO (bSAOEnable, `sao.ts`, `shaders/sao.wgsl`) is McGuire, Mara and Luebke's
Scalable Ambient Obscurance (HPG 2012): the passes Community Shaders keeps (ISSAOCameraZ,
ISSAOMinify, ISSAOBlur, ISSAOComposite) are the paper's reference code. After the opaque pass
and the depth resolve:

1. Camera-space Z from the resolved depth (near / depth; no geometry = 300000), and 5 more mips,
   each pixel taking one of the 2 × 2 below on a rotated grid.
2. Raw AO: 11 taps on a 7-turn spiral within fSAORadius 250 (in pixels: 250 × half the screen
   height × the projection's y scale / Z), a per-pixel random rotation, wider taps from coarser
   mips; each occludes by `(r² − |v|²)³ · max((v·n − fSAOBias 2.5) / (0.01 + |v|²), 0)`, the
   sum divided by r⁶ and AO = `max(0, 1 − sum · fSAOIntensity 15 · 5 / 11)`. The normal comes from
   the G-buffer (bSAONormalMap), else from the depth's derivatives. The depth key is packed
   into two channels for the blur. This pass is not in the sources; it is the paper's code
   with the game's values (TODO(M13): fSAOExpFactor 0.11 has no known role, compare with the
   original).
3. Blur along x, then y: 7 taps 2 pixels apart, the Gaussian weights + 0.3 (fSAOValueDiffFactor),
   cut where the depth keys differ (`1 − 2000 |Δkey|`).
4. Composite into the multisampled colour before the blended pass: colour × AO under the fog
   (`src + dst · AO` with src = fog colour · fog · (1 − AO)), none on snow (bDeactivateAOOnSnow)
   or the sky.

## Lighting shader

BSLightingShaderProperty (`shaders/lighting.wgsl`) follows the engine's lighting pixel shader
as Community Shaders' near-vanilla Lighting.hlsl (v0.7.4) reproduces it, with the material
constants of Nukem9's decompiled `BSLightingShader`:

1. Normal: tangent space, or model space stored **x, z, y** (MSN materials and LOD land).
   Specular mask: the normal map's alpha, or with model-space normals the specular map (texture
   set slot 7).
2. Lights (sun with its shadow, point lights fading as 1 − (d/r)²): diffuse `saturate(n·l)`;
   specular `pow(saturate(h·n), glossiness)` without an n·l test. Anisotropic (hair):
   `h·n` becomes 1 − |a·l − a·h| with a = normalize(0.5 n + vertex normal), times 0.7 l.z.
   With the unshadowed light colour: soft lighting (`SLSF2 0x2000000`, smoothstep of
   (rolloff + n·l) / (1 + rolloff) minus that of n·l; for point lights the engine passes the
   unnormalized light vector), rim lighting (`0x4000000`, (1 − n·v)^power · saturate(v·−l)),
   both times the rim / soft map (slot 2), and back lighting (`0x8000000`, saturate(−n·l)
   times the back light map, slot 7). Missing maps are black (the engine binds no texture).
3. Colour: (directional ambient + emit + lights) × diffuse, then × vertex colours (hair: the
   tint by the vertex green, `(g · (tint − 1) + 1)`; skin tint: the facegen RGB tint formula).
   Emit is the emissive colour with Own_Emit, or the emissive colour × the glow map (type 2
   with SLSF2 Glow_Map): so glow is coloured by the diffuse texture.
4. Multi-layer parallax (type 11): the inner layer (slot 6) seen through the surface, offset by
   (thickness × layer alpha / 1024) along the view reflected about the scaled normal map, blended
   by saturate(n·v) × (1 − diffuse alpha); it has the environment map too.
5. Environment map: the cube map in the reflection, times the environment mask (else the
   specular mask) × the scale, **times the diffuse light** (dark where the surface is dark).
6. Specular: lights × specular mask × specular colour × strength.
7. Directional materials (snow, ash, ice on statics and object LOD) and their multi-index snow
   pass: see [formats/esm.md](formats/esm.md#directional-materials). Objects counted as snow
   (STAT flag or SLSF2 `0x10000000`) get the improved snow of `shaders/snow.wgsl` instead of
   their specular: the rim light before fog and the sparkles after it, times the snow mask
   (the engine's SnowParameters.y): the projected material's blend weight, 1 in the
   multi-index snow pass, else the diffuse alpha. The mask goes into the G-buffer for the
   snow's subsurface scattering (see [Snow](#snow)).
8. LOD landscape noise (type 18): diffuse × 0.8333 (p (0.37 − noise) + noise) + 0.37 with
   `textures\terrain\noise.dds` at 3 × UV and p from the colour's brightness.
9. Leaf flutter (SLSF2 Tree_Anim, `leafShift` in common.wgsl, the engine's
   GetTreeShiftVector): a vertex moves along its normal by
   `(e(0.1 t) + 0.1 e(0.25 t)) · amplitude · vertex alpha`, e = a smoothed triangle wave of
   `t · frequency · wind` plus the sum of the vertex's coordinates, t = 6 × seconds. Leaf
   amplitude and frequency come from the TREE record (1 and 1 without one; without a leaf
   animation root the timer stands still); the amplitude fades out between 3600 and 4600 units
   from the camera (fLeafAnimDampenDistStart / End); wind = the weather's wind speed (0..1).
   The vertex alpha is the leaf weight, not transparency.

Parallax (type 3, 11 vanilla shapes in Markarth): the height map (slot 3) shifts the texture
coordinates by (height × 0.08 − 0.04) along the x and y of the **model-space** view direction,
as the vanilla pixel shader does (aers' Skyrim-SE-Shader-Tools decompile; a correct version
would use the tangent-space direction; the bug is kept). Community Shaders 0.7.4 leaves this
out (it replaces parallax with its own), so that source is not used here.

## Effects and particles

BSEffectShaderProperty (`shaders/effect.wgsl`, also used for particles by
`shaders/particle.wgsl`) follows the engine's effect pixel shader (as documented by the
Community Shaders sources):

1. Colour = source texture × base colour × vertex colour (particles: the particle colour);
   alpha = texture alpha (1 with greyscale-to-palette alpha) × base and vertex alpha.
2. Falloff (SLSF1 `0x40`): opacity from start to stop opacity between the falloff angles
   (cosines) by how directly the surface faces the camera.
3. Soft effect (SLSF1 `0x40000000`, blended only): alpha fades over the soft falloff depth in
   front of the opaque scene (from `sceneDepth`), so smoke and glows do not cut into walls.
4. Material alpha (and its animated "alpha transparency").
5. Greyscale palette (SLSF1 `0x20` alpha, `0x10` colour): alpha = palette alpha at (texture
   alpha, alpha so far); colour = palette at (texture green, base × vertex red). Fire uses
   both: the particle colour fading from grey to black walks down the flame palette (white
   hot → orange → transparent red) while the alpha fade shrinks the flame. Palettes are
   lookup tables: sampled clamped (their rows must not wrap) and at their full size, as their
   smaller mips blend the opaque rows into the clear first ones (GradFlame01: rows 0–1 are
   clear), so an effect faded to alpha 0, like an unlit fire's flames, vanishes.
6. Colour × base colour scale; Effect_Lighting (SLSF2 `0x40000000`): blended towards colour
   × scene light (directional ambient, the sun at half strength even from behind — smoke
   scatters it — and point lights) by the lighting influence.
7. Alpha test, then fog: additive effects (destination factor ONE) fade out, multiplicative
   ones (destination SRC_COLOR or source DEST_COLOR: the engine's MULTBLEND) fade to white by
   1.5 × the fog, others blend to the fog colour.

Draw uniforms of effects: base colour (emissive slot), base colour scale (params.w), lighting
influence and soft depth (specular slot). Texture clamp mode picks the sampler (bit 0 wraps U,
bit 1 wraps V).

**Particles** (`scene-renderer.ts`, `particle-sim.ts`): every placed particle system has its
own simulation; each frame the systems near the camera or in view update, and their particles
go into one instance buffer (16 floats each: position, half size, colour, atlas frame,
velocity or strip segment, rotation). One draw per system: six vertices per instance build a
quad facing the camera (the frame's camera axes, turned by the particle's rotation) or turned
along the velocity (aspect flag `0x1`, height scaled by the aspect ratio), or a ribbon segment
facing the camera for strip particles. Blended particles test but never write depth (their
quads overlap unsorted within a system).

**Refraction** (SLSF1 `0x8000` on the lighting shader: heat haze over fires and torches,
magic barriers, mist; about 360 vanilla shapes, strength 0.05–1): the engine draws these shapes only
into a refraction buffer and an image-space pass shifts the finished scene by it
(`ISRefraction` in the Community Shaders sources), so what is blended behind a barrier (its
own glow, fire, particles) bends along with the opaque scene. Here (`refraction.ts`): after the
blended pass the shapes write the buffer (`shaders/refraction.wgsl`, rgba16float, cleared to
0.5, 0.5, 0, 0): the normal map's xy, the strength (animated by controllers), the mask (diffuse
alpha × material alpha, × vertex alpha with Vertex_Alpha or Vertex_Colors); depth-tested, no
depth writes, back to front, where the mask is 0 they leave the buffer as it is. Then the
composite (`shaders/refraction-composite.wgsl`) reads a copy of the scene: offset 0.1 ×
strength × (normal − 0.5), x mirrored; past 0.15 and 0.85 of the screen the shifted
coordinate moves at 0.78 of the rate (blended in by the strength); the mask is read where the
shifted coordinate lands, so nothing in front of a shape is pulled into it; the result is
the scene lerped to the shifted scene by that mask. Their UV controllers scroll the noise.
Fire_Refraction (`0x10000`) without Refraction (about
50 shapes) is drawn as a regular surface: what it changes in the engine is not documented
(TODO(M13)).

## Weapon blood

A blade that struck flesh shows blood, as the engine's BSTempEffectWeaponBlood does. The
blood is in the weapon models themselves (`node tools/held-weapon-info.ts`; 2698 of 3309 WEAP
world models, 2800 first-person ones): hidden shapes (NiAVObject flag 0x1) over the blade
whose shader has SLSF1 Decal and Dynamic_Decal (`0x0C000000`; no other hidden shape has
Dynamic_Decal), in pairs under names that vary (BloodLighting / BloodEffects, EdgeBlood01 /
EdgeBlood, WarAxeBloodLighting / WarAxeBloodFX, ...):

- an **effect** shape with SLSF2 Weapon_Blood (`0x20000`) over `textures\blood\BloodEdge01.dds`
  (blades) or `BloodHitDecals01.dds` (maces and hammers), multiplied over the blade (alpha
  flags `0x5243`: source ZERO, destination SRC_COLOR, alpha test greater than 0). The texture
  is not a colour: its green is the blood's mask and its blue how thick it is. The engine's
  BLOOD technique (Community Shaders' `Effect.hlsl`): alpha = green; above = saturate(green −
  AlphaTestRef.x); mul = blue × vertex alpha, × above / AlphaTestRef.y where above is less
  than AlphaTestRef.y; colour = saturate((2, 1, 1) − mul) × (1 − mul × AlphaTestRef.z). So
  the blade keeps its colour where there is no blood and turns dark red where it is thick.
  Here the draw's `layer` slot (unused by effects) carries AlphaTestRef: x the cutoff, y the
  soft edge (fWeaponBloodFalloffThreshold, 0.07), z 0 (TODO(M13): what the engine puts
  there).
- a **lighting** shape over the same texture's `Add` version (black, its alpha the wet parts)
  with `BloodEdge01_n.dds`, the eye cube map at 0.25 and glossiness 500, drawn additively
  (alpha flags `0x520d`: SRC_ALPHA, ONE): the wet sheen.

`buildModel` keeps these shapes (`ModelPart.weaponBlood`); the scene draws them only on an
instance that carries a weapon's blood (`ModelInstance.weaponBlood`: the weapons combat hangs
on actors and on the first-person arms, src/shell/actor-weapons.ts), and leaves them out of
overlays and of the parts decals land on. A melee hit whose impact leaves a blood decal (the
weapon's impact data set against the target's flesh: DecalBloodBladeHit, DecalBloodDraugrHit;
not bone, metal or a punch) bloodies the weapon of the hand that struck
(src/gameplay/combat/weapon-blood.ts): fresh for fWeaponBloodLifetime (10 s), the cutoff then
rising from 0 to 1 over fWeaponBloodFadeDuration (60 s), so the thin blood goes first and the
thick drops last, the sheen's alpha falling with it; another hit makes it fresh again. The
third- and first-person models of the same weapons share it; other weapons come clean.
TODO(M13): how the engine drives AlphaTestRef and the sheen's alpha from its blend amount over
time is not documented; this is the plain reading of the three settings.

## Decals

Placed decals (`decals.ts`, `shaders/decal.wgsl`; records in
[formats/esm.md](formats/esm.md#decals)) are drawn first in the blended pass as screen-space
projections: the back faces of each decal's box (unit cube times its placement: X width, Y
projection, Z height) cover its area even with the camera inside; for every pixel the opaque
surface behind it comes from the scene depth copy (`inverseViewProj` of the frame), and where
that point lies inside the box the decal's texture is drawn on it, lit like the surface: its
normal from the depth's screen derivatives, turned by the decal's normal map in the decal's
frame, with ambient, sun, shadows and point lights, then fog. Surfaces running along the
projection fade out (no smearing down walls). Alpha testing discards below 0.5; blending uses
the texture's alpha. One instanced draw per texture set; decals out of view are skipped.

## Precipitation

Rain and snow (`precipitation.ts`, `shaders/precipitation.wgsl`), as the engine's particle
shader does it: a box of the SPGD's size around the camera holds density × 1024 particles
(at most 65536). Each particle has a fixed place in an endless lattice that falls with the
gravity velocity and drifts with the weather's wind (rain 15%, snow 50% of it); the copy
inside the box around the camera is drawn, fading near the box's faces where particles wrap.
Rain is a streak along the fall (as long as its size plus a frame's fall at 30 fps), snow a
camera-facing quad that turns and circles its fall line (centre offset min..max). Each
particle shows one random frame of the texture's atlas, lit by the ambient light from above
and half the sunlight, faded where it nears the opaque scene, fogged.

**Occlusion** (no rain under roofs): the scene's shadow casters and the terrain rendered from
straight above around the camera (orthographic, ±8192 units in height) into layer 4 of the
shadow map — redrawn when the camera moves a quarter of the map or every 120 frames. A
particle below anything in that map is hidden. Snow quads reach the SPGD size in world units
from their centre (the engine offsets the corners in clip space by size × the projection
scale, CS Particle.hlsl ENVCUBE); rain drops are scaled × 50 to match the texture's thin line:
TODO(M13) calibrate rain against the original.

## Memory

The session keeps the models and textures it loads (`game-session.ts`, `texture-cache.ts`)
and counts their GPU bytes (vertex and index buffers; all mips of every texture); the status
bar shows the total against the budget (`MEMORY_BUDGET`, 2 GiB). Scenes and grass fields hold
the models they draw, models hold the textures they bind. While cells stream in and out the
world viewer trims the session four times a second: over budget, the least recently used
models that nothing draws are freed (they let go of their textures), then the textures no
model holds, down to 85% of the budget. Anything used in the last 10 seconds stays (a cell
may be about to place it), as do models attached to others as add-ons and textures never
held by a model (terrain, sky, water, decals, precipitation: few and shared). Freed models and
textures load again when a cell needs them.
