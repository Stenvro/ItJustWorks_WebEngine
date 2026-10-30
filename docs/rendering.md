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

   **Focus shadows** (`focus-shadows.ts`): sharp sun shadow maps round the bodies near the
   player ([Display] iNumFocusShadow 4, fMaxFocusShadowMapDistance 450). Observed in the
   original: each frame it keys the actors whose 3D is loaded and shown by their squared
   distance to the player less the square of their bound's larger horizontal half extent (at
   least 1), keeps those below the distance squared, sorts them nearest first and hands out
   the focus maps in that order after the player's own body (when shown). Here the four maps
   are the quarters (1024² each) of one more layer of the sun's shadow map, rendered every
   frame (actors move), each an orthographic view along the cascades' light view, fitted round
   the bound of the body's casting parts plus 24 units, snapped to whole texels (about 0.2
   units a texel for a person, against 0.7 for the first cascade), reaching as far towards the
   sun as the cascades and 4000 units behind the body. A focus map holds every caster in its
   column (terrain too), so a receiver inside its square takes its shadow from it alone; the
   cascades fade in over the square's outer tenth and take over outside it. Its depth bias is
   two of its texels. TODO(M13): whether the engine's focus maps draw only their actor (and
   the cascades leave it out), and their resolution; the engine also checks a cell flag before
   it renders them, read as "exteriors" here.

   **Shadow lights** (`light-shadows.ts`), interiors and exteriors: lights whose LIGH carries
   Shadow Spotlight, Shadow Hemisphere or Shadow Omnidirectional (`cell-lighting.ts`
   lightShadow) cast shadows, four at once (no INI setting names a shadow-light count). Lights
   whose sphere misses the view frustum, or that stand in a room not seen, take no slot; of
   the rest the nearest to the camera hold the slots (the brighter at equal distance), each
   fading in and out over half a second as it enters or leaves the set. An omnidirectional
   light renders a cube (six 512² layers of the light-shadow map), a spot light one frustum
   round its cone, a hemisphere light one 150° frustum round its axis. A layer is rendered
   again only when its light moved a unit or one of its casters (parts within its radius)
   moved, appeared or went.

2. **Opaque pass:** the shell backdrop or the sky, terrain, tree LOD billboards, grass and the
   opaque parts of all scenes (LOD and cells), into the colour (unfogged) and a G-buffer
   (`gbuffer.ts`: normal, snow mask, snow specular). Every opaque pipeline writes the G-buffer,
   so a pixel holds its front surface's values (grass and distant trees write no snow). Parts
   and terrain quadrants outside the view frustum are skipped (bounding spheres).
3. **Screen-space passes and copies of the opaque scene:** the multisampled depth resolved
   (sample 0) into an `r32float` texture, the snow's subsurface scattering on the lit,
   unfogged image, the ambient occlusion, then the composite (below), then the resolved
   colour copied. The copies are bound in the frame group (`sceneColor`, `sceneDepth`).
4. **Water and blended pass:** water surfaces, then blended parts and particle systems of all
   scenes back to front (by bounding sphere centre).
5. **Refraction** (only with refraction shapes in view): the shapes into the refraction
   buffer, then the image-space refraction of the scene so far (below).
6. **Post-processing** (`post.ts`): the imagespace's eye adaptation, bloom, tone curve and
   grading into the canvas (see [formats/esm.md](formats/esm.md#imagespaces)), then its depth
   of field and the image-space modifiers' screen effects (below).

**Temporal anti-aliasing** ([Display] bUseTAA, `taa.ts`): the projection moves by a Halton
(2, 3) sub-pixel offset each frame and the HDR scene is blended with its history (90 %),
clamped to this frame's 3×3 neighbourhood, before the sun's effects and post-processing. The
history is found again per pixel by a **motion vector** where a moving draw shows (moving
instances and animated parts: `SceneRenderer.drawVelocity`, `shaders/velocity.wgsl`), else by
the pixel's depth and the camera's move, between the unjittered view-projections of both
frames (the history holds the steady image: through this frame's jittered matrix every still
pixel fetched its history a jitter step away, a sub-pixel resample each frame that blurred
the whole image). The history is read through a Catmull-Rom filter (five bilinear taps), so a
moving view does not soften it frame by frame. The velocity pass draws the moving opaque draws into
an `rgba16float` target (the uv offset to the last frame, and a written mark) under this
frame's and the last frame's world matrix (each scene keeps its moving draws' last matrices by
draw slot; a draw unseen in the last pass has not moved), with no depth attachment: a fragment
writes only where its depth matches the opaque pass's resolved depth (1 % relative tolerance:
that depth is one MSAA sample of four), so only the surface kept there. First-person draws use
first person's own view-projections, this frame's and the last. Skinned draws take this frame's
pose under both world matrices: the instance's move is followed, a limb's swing within it is
not (TODO(M13): the last frame's bone palettes). Opaque draws only; blended parts and particles
are reprojected by the depth behind them.

**Volumetric lighting** (`volumetric-volume.ts`, `shaders/volumetric.wgsl`,
bVolumetricLightingEnable): the weather's volumetric lighting (VOLI by time of day: intensity ×
[Display] fVolumetricLightingIntensity, the sun's colour mixed with its custom colour,
`world/volumetric-lighting.ts`) scattered through the original's froxel volume over the view
("Volumetric lighting" below). The phase function is the original's,
`(1 − g²) / (4π (1 − g cos))` with g = the phase scattering, mixed with 1 by the phase
contribution (`godRayPhase`; the phase contribution weighs the function, it is no strength).
With the vanilla values that weight stays between about 0.15 and 0.3: an even haze, a little
stronger towards the sun, cut into shafts by the shadows of the first two cascades (also
through openings in front of the camera, not only towards the sky). The light does not depend
on the sky's brightness.

**Not yet:** the engine's image-based lens flare of bright lights (bIBLFEnable,
ISIBLensFlare; vanilla SSE has no LENS records, so this is its only lens flare of lights other
than the sun): TODO(M13). Its shader is known (Community Shaders), but the values the engine
feeds it (the flare's ghosts and halo) are computed in the executable and documented nowhere.

**Encoding cost:** each draw is a handful of calls into the browser's WebGPU, and Helgen's
opening has some 4,400 draws a frame (its shadow cascades and opaque pass). The opaque and
shadow passes set a part's pipeline, material group and buffers only where they differ from
the draw before (consecutive draws are mostly one model's parts), and the per-draw uniforms
of animated draws go up in runs (an actor's parts lie side by side in its scene's buffer)
instead of one writeBuffer each.

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
shapes (skin tint, type 5) and its hair colour (CLFM) times 2 that of hair shapes (hair tint,
type 6: `hairTint`; the vanilla hair colours are all below 100 of 255, Albino White is 130, so
128 is the texture's own colour);
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
the opaque pass writes them into the G-buffer and the [composite](#composite) adds them;
blended snow parts add them in their own shader. The game's default settings:

- Rim: `0.3 · (1 − saturate(geometry normal · v))³ · (1 − saturate(n · v))²`
  (fSnowRimLightIntensity, fSnowGeometrySpecPower, fSnowNormalSpecPower) × the mask, added to
  the lit colour before fog (after the subsurface scattering).
- Sparkles: fixed bright points in world space, `step(0.85, noise²)` of 3D simplex noise at
  `0.07 × 6 × position` (fSparklesDensity, fSparklesSize, fSparklesSpecularPower 2), × lerp(sun
  shadow, 1, 0.25) (fShadowSparkleIntensity), fading out over 1000 units (fSparklesMaxDistance),
  × the mask, added after fog.
- Subsurface scattering (ISSnowSSS, `snow-sss.ts`, `shaders/snow-sss.wgsl`): after the opaque
  pass, on the lit, unfogged image before the composite (see [Composite](#composite)), where
  the G-buffer's snow mask is above zero, 11 taps along the screen at offsets ±0.08
  to ±2 × (0.078125, 0.13889) × fSnowSSSStrength (50) / distance, with per-channel weights
  (blue spreads farthest; each channel's weights sum to 1), each tap kept at the centre colour
  in proportion to its depth difference × 0.1 × fSnowSSSDepthDiff (0.5). With L the result's
  luminance (0.3, 0.59, 0.11): snow = lerp(lerp(fSnowSSSColor × fSnowSSSDarkColorIntensity,
  source, L), result, L), blended in by the mask: lit snow softens and dim snow darkens towards
  a cool tint. It is written into the multisampled colour target, which the composite then
  finishes. (iSnowSSSCurrentColor 2 picks an undocumented preset; the configured colour
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
scripts' (Image-space modifiers, below), a kill camera's shots' (cross-faded in over
fVATSImageSpaceTransitionTime: src/shell/killmove-camera.ts). Behind the tween and item menus
the game applies DOBJ IMID (ISMTween, a constant −0.15 brightness) while any of them is open, as
UIBlurManager counts them (src/shell/game-menus.ts).

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

## Composite

The engine finishes its opaque scene in this order (observed in the original): the
geometry pass writes the main colour, normals and, with bEnableImprovedSnow, two more targets
for the snow; then the ambient occlusion is computed (not yet applied); then ISSnowSSS runs on
the main colour (a plain copy when the improved snow or its scattering is off); then one
ISSAOComposite pass reads that result and writes the finished image. The composite's variant
follows bSAOEnable and whether there is fog (a sky with a fog, and bSAOApplyFog, on by
default): SAO, Fog or SAOFog; with neither, the image is only copied. Its constants carry the
fog, the sun's direction, the sparkle settings (fSparklesSize, fSparklesDensity,
fSparklesIntensity, fSparklesMaxDistance, fShadowSparkleIntensity, ...) and
bDeactivateAOOnSnow, so the fog and the sparkles are applied there, after the scattering.

What the shaders write is from Community Shaders 0.7.4 (behaviour only): the lighting,
landscape, grass and distant tree pixel shaders write the lit colour without fog and without
the snow's specular (the grass and DistantTree shaders have no distance fog; the lighting
shader leaves the snow's specular out of the colour and exports it as SnowParameters.x). The
snow's specular is kept out of the main colour so that ISSnowSSS scatters only the snow's
diffuse light. Here (`composite.ts`,
`shaders/composite.wgsl`), per sample of the multisampled colour (its own depth and G-buffer,
so silhouettes against the fog get no fringe): colour + snow specular × snow mask, × AO (1 on
snow, bDeactivateAOOnSnow; 1 without SAO), fog over it, + sparkles × snow mask. The sky and
surfaces their own shader finished (G-buffer a = 0: sky objects, effect shapes) are left
alone; blended parts, decals, water and particles fog themselves. Running the scattering on
the fogged image instead turned distant snow (snow patches on mountains, and grass and tree
LOD that took the snowy land's mask under them) near black in fog and dim weather: the
scattering darkens towards fSnowSSSColor by the luminance, and fogged pixels are dim. The menu
overlay has no composite: snow there lacks its rim light (menus have no fog). The composite
always runs here, also without SAO and fog, so the snow keeps its rim and sparkles (TODO(M13):
whether the engine's lighting shader adds them itself in that case, where its composite is a
plain copy, is not known; and bSAOApplyFog off is not followed).

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
4. Applied by the composite (above): colour × AO before the fog, none on snow
   (bDeactivateAOOnSnow) or the sky.

## Lighting shader

BSLightingShaderProperty (`shaders/lighting.wgsl`) follows the engine's lighting pixel shader
as Community Shaders' near-vanilla Lighting.hlsl (v0.7.4) reproduces it, with the material
constants of Nukem9's decompiled `BSLightingShader`:

1. Normal: tangent space, or model space stored **x, z, y** (MSN materials and LOD land).
   Specular mask: the normal map's alpha, or with model-space normals the specular map (texture
   set slot 7).
2. Lights (sun with its shadow, point lights fading as 1 − (d/r)²; a spot light only within
   its cone, below): diffuse `saturate(n·l)`;
   specular `pow(saturate(h·n), glossiness)` without an n·l test. Anisotropic (hair):
   `h·n` becomes 1 − |a·l − a·h| with a = normalize(0.5 n + vertex normal), times 0.7 l.z.
   With the unshadowed light colour: soft lighting (`SLSF2 0x2000000`, smoothstep of
   (rolloff + n·l) / (1 + rolloff) minus that of n·l; for point lights the engine passes the
   unnormalized light vector), rim lighting (`0x4000000`, (1 − n·v)^power · saturate(v·−l)),
   both times the rim / soft map (slot 2), and back lighting (`0x8000000`, saturate(−n·l)
   times the back light map, slot 7). Missing maps are black (the engine binds no texture).
   A texture a model names that no file holds draws the slot's default, as the engine does (its
   renderer keeps default black, white, grey and normal textures and per-slot defaults:
   BSShader_DefNormalMap, DefHeightMap, DefCubeMap, DefFacegenDetail, DefTexEffectMap, by
   CommonLibSSE's BSGraphics::State and the executable's strings). Vanilla meshes name a few
   textures the game never shipped (Windhelm's whicedecal01 and its normal map, Alduin's eyes'
   normal map): a missing texture named by a model of the game's own archives
   (`Vfs.isGameContent`, `TextureCache` failures' `gameLacks`) is logged as info; one a mod's or
   a loose model names, or a file that does not decode, as a warning; each once. TODO(M13): which
   default each shader slot takes for a missing file (ours: white diffuse, flat normal, black
   glow and cube map).
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
8. Ambient specular (Community Shaders' AMBIENT_SPECULAR): the directional ambient's specular
   colour × (1 − n·v)^fresnel power × the specular mask, on specular surfaces (not snow). The
   colour and power are DALC's (the weather's, blended by time of day; an interior's XCLL or
   lighting template), in the frame's ambient w components.
   Character light (CHARACTER_LIGHT; [Display] bCharacterLighting, fCharacterLightPrimary /
   SecondaryLightIntensity 0.75 / 0.3, ...LumScale 2, ...LumMax 0.75): on actors' skin (FaceGen
   and skin tint shapes) primary × saturate(n·v) + secondary × saturate((0.1644, −0.9864) ·
   n.yz in the actor's model space), times min(LumMax, LumScale × luminance). TODO(M13): the
   engine takes the luminance from a texture it binds (ours: the directional ambient's).
   Eyes (type 16, 3,320 vanilla shapes, `node tools/effect-audit.ts --shaders`) carry
   Eye_Environment_Mapping (SLSF1 `0x20000`), not Environment_Mapping, and reflect their cube
   map (slot 4, with the mask of slot 5: both bound by that flag, `material-slots.ts`) by their
   eye cube map scale. TODO(M13): the engine reflects about the shader's
   left / right eye reflection centres (by the vertex red); ours about the mesh normal.
9. LOD landscape noise (type 18): diffuse × 0.8333 (p (0.37 − noise) + noise) + 0.37 with
   `textures\terrain\noise.dds` at 3 × UV and p from the colour's brightness.
10. Leaf flutter (SLSF2 Tree_Anim, `leafShift` in common.wgsl, the engine's
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
   scatters it — and point lights, not the spot lights) by the lighting influence. The
   engine's spot lights are its shadow spotlights, which reach surfaces through their shadow
   maps; Community Shaders' effect shader leaves shadow-casting lights out of an effect's
   lights (TODO(M13): the engine's own list is unread). With them, the cobwebs hung beside
   Bleak Falls Barrow's sunbeams (lit effects with greyscale palettes: 56 web shapes among the
   1,170 lit effect shapes, `node tools/effect-audit.ts --lit`) were a white sheet over
   Arvel's door, and the dust in the entrance's shafts a white blob.
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

### Effect shaders on references

Effect shaders (EFSH) and art objects (ARTO) cover any reference, not only actors
(`src/shell/actor-effects.ts`): a script's EffectShader.Play or VisualEffect.Play (RFCT: its art
and shader) on an object covers its model's shapes, its particles come off its rigid shapes as its
model places them, its art stands at its origin. An enchanted item glows
(`src/gameplay/magic/enchantment-glow.ts`): its enchantment's costliest effect's Enchant Shader
and Enchant Art (MGEF DATA), on a weapon in the hand (third and first person; the particles off
the blade where its hand node holds it) and on weapons and armour lying in a loaded cell, exterior
or interior (hidden with them when taken), the ones the game made too: dropped, placed by a
script, an enchanted copy made at the enchanting table (a created form with its EITM; the shell's
world and interior viewers glow them as `CreatedObjects` shows them). 2,903 of 3,018 enchanted
vanilla weapons and 2,819 of 2,847 enchanted armours have a shader (`node tools/effect-audit.ts
--glow`). TODO(M13): worn armour shows none (as remembered of the game, unchecked).

### Per-object light lists

Observed in the original (behaviour only; `src/render/light-lists.ts`). A geometry is not
lit by every light near it: it keeps its own list of the lights that reach it, and when its
lighting pass is built the engine names, after the directional light, first the shadow lights
that touch it (those of the frame's shadow lights its active-light mask allows, skipping
effect-only geometry for lights not flagged to light it), then the other lights of its list
(culled and hidden lights left out), into an array of sixteen. The lighting technique's light
count then holds at most seven point lights (three bits: the count minus the directional
light, clamped to 7) and at most four shadow lights (three bits, clamped to 4): the shader
loops over that many and drops the rest. So an object among many candles is lit by seven of
them, the shadowed ones first.

How a geometry's own list is kept, observed in the original:

- **Who joins it.** When a geometry's lights are refreshed, the scene walks its active lights
  (or, in a room, the room's lights) in their order and adds each light that is not a shadow
  light, has no restricted node and whose sphere touches the geometry's bound (distance between
  the centres less the bound's radius under the light's radius). Shadow lights never join a
  geometry's list: they reach lighting geometry only through the frame's shadow lights.
- **The order.** A refresh moves each light it finds to the front part of the list, in the
  order found, and afterwards drops the lights it did not find again unless they are dynamic
  (those stay behind the found ones). So the list names lights in the order they joined the
  scene, never by strength: the eighth candle is left out however bright it is.
- **Land.** A light created from a reference flagged Doesn't Light Landscape (REFR `0x20000`;
  Doesn't Light Water is `0x100`) is not added to land geometry (the shader flags Landscape or
  No_LOD_Land_Blend).
- **Effects.** An effect shader's pass takes lights only with Effect_Lighting, into an array of
  five: the directional light (the sun, not its shadow light) and at most four of its list's
  lights; it never names shadow lights. Particle systems are effect geometry: they keep lists by
  their bound as any geometry does.

Here every lit draw has a slot in its scene's light-list buffer (`flags.w` bits 8–23 name it;
the shader type keeps bits 0–7, the distance fade bits 24–31): a count and seven indices into
the frame's lights, 16 bits each. A draw's list is chosen the first time it is drawn in a
frame (`SceneRenderer.#chooseLights`, by its bounding sphere and room), a particle system's as
it is drawn (by its particles' bound), and uploaded in one range per scene; the lighting and
effect shaders loop over it (`drawLightList`, `lightListIndex` in `common.wgsl`). A light is
in a list when its sphere touches the bound and it is not a portal-strict light of another room;
a lighting draw names the frame's shadow lights first (at most four, in the frame's order), then
the others in the order they joined the scene (`PointLight.order`: the world viewer numbers the
loaded cells' lights as the cells loaded, then magic's lights), seven in all; an effect draw
names no shadow light and four at most. Land takes every light of the frame except those that do
not light landscape (`landLightAt` in `frame.wgsl`; TODO(M13): land's own lists of seven per
quad); tree LOD and decals take every light of the frame. Grass takes no point lights: [Grass]
bGrassPointLighting is off by default.

### Rooms' lighting

A room marker's LNAM lighting template (XRMR flag `0x80`) takes the cell template's place, under
the cell's own XCLL values and inheritance flags, and its INAM image space (flag `0x40`) the
cell's, while the camera stands in that room (`lightingInRoom`, `src/shell/model-viewer.ts`).

### Spot lights

LIGH Shadow Spotlight (`0x400`): 39 vanilla lights, 153 references, nearly all sunbeams through
ceilings and windows. The cone is the base light's FOV (DATA, 90° in every vanilla light) plus
the reference's XLIG FOV offset (xEdit `FOV 90+/-`), along the reference's local X axis (the
Gamebryo spot light's axis: for 123 of the 153 references X is the axis pointing down the most);
an angle outside 0–180° (two references) leaves the light shining every way. A light's fade is
its FNAM plus the reference's XLIG fade offset (`Fade 1.35+/-`; 138 spot references have one,
from −3.7 to +74), its radius DATA's plus XRDS. The lighting shader and the frame's `lightAt`
light a point only within the cone, its edge softened over a tenth of the rest of the cosine
range (`lightCone` in `frame.wgsl`; TODO(M13): the engine's edge is its shadow map's frustum,
and what stands in the beam shadows it). `node tools/effect-audit.ts --spots`.

### Procedural lightning

Observed in the original (behaviour only; `src/render/lightning.ts`). The bolts of the
shock spells, their impacts and explosions and the shock runes and walls (37 controllers in 13
vanilla meshes, among them `Magic\LightningBolt01`–`04.nif`) are not in the files: a
**BSProceduralLightningController** on a node builds them at run time into that node's first
child, a BSTriShape with no vertices (culled in the file). Its settings (docs/formats/nif.md,
"Animation"): subdivisions, branches and their variation, length and its variation, width, a
branch's width multiplier, arc offset, whether the main bolt and the branches fade, whether the
arc offset is animated; and nine interpolators (generation, mutation, subdivision, branches,
branch variation, length, length variation, width, arc offset), in the vanilla meshes driven
by the model's sequences (the beams' graph plays `mIdle`, the impacts' and explosions' their
own); without an interpolator a setting keeps the controller's value, and without a
generation interpolator nothing is built.

- **Generation** (bool): when it turns on, the engine grows a tree of bolts (on a task, shown
  from the next frame): a main bolt of 2^subdivisions segments (it builds nothing for fewer
  than 1 or more than 12 subdivisions), with between branches − variation (at least 0) and
  branches + variation branches (uniformly), each of one subdivision less and with half the
  branches and half the variation for its own branches, and so on down. When it turns off the
  geometry goes; the next generation grows a new tree.
- **Laying out** (at a generation and whenever the **mutation** bool flips, either way): every
  bolt runs along the shape's +Y axis, `0.5^depth × length + 0.25^depth × r × length
variation` long (r uniform in [−1, 1), depth 0 for the main bolt, 1 for its branches…),
  `childWidthMultiplier^depth × width` wide. It strays from its line by a midpoint
  displacement in the X–Z plane: along a random direction, a tent over the whole bolt (most
  in the middle, nothing at the ends) of `0.5^depth × arc offset`, then the same on each half
  with half the amplitude, down to single segments; so both ends stay on the line. A branch
  starts at a random point of the first half of its parent's centre line and runs parallel to
  it (along +Y).
- **Arc offset between mutations** (with Animate Arc Offset): when its value changes, every
  point's X and Z are scaled by new / old (the bolts breathe out until the next mutation
  re-forms them; the vanilla arc tracks are sawtooths that drop at each mutation key).
- **Geometry:** per point of a bolt four vertices: its centre ± half the width along X and
  along Z; two crossed ribbons per segment (one across X, one across Z), not turned to the
  camera. U is 0 → 1 across a ribbon, V = point / segments along the bolt (the material's UV
  scale tiles it, its V offset controller scrolls it). Vertex colour white; alpha: a main
  bolt's first point 0, a branch's 1, every bolt's last point 0, the points between 1, or
  `1 − (k / segments)²` with the bolt's fade flag. The material is the empty shape's
  (BSEffectShaderProperty and NiAlphaProperty: in the bolts additive, greyscale-to-palette).

Here each controller becomes a particle system of its model (`ParticleSystemData.lightning`;
`buildModel` takes the empty shape out of the parts) run by a `LightningSimulation` instead of
a particle simulation: it samples the tracks like a particle system's (free ones on the
model's clock, managed ones on their sequence's), keeps its bolts in the shape's space and
writes two ribbon instances per segment into the particle buffer; `vs_ribbon`
(`shaders/particle.wgsl`) builds each quad from the segment, its fixed side vector (the shape's
X or Z axis in the world × half the width) and the alphas at both ends, shaded by
`fs_particle` (the effect shader). Random numbers are seeded per placement. Beams stretch the
shape (below and docs/gameplay.md, "A hand's cast"): the simulation scales its Y axis by
`LightningOptions.stretch` and its alpha by `opacity`.

**Beams** (BeamProjectile, observed in the original; `src/shell/magic-beams.ts`): the
beam's model hangs at the caster's magic node, along the aim, every frame while it lives.
When the beam meets something, its length is the distance from its origin to the hit; then
(and again whenever a lightning controller lays out new geometry, which tells the beam) every
geometry of the model gets its own local Y axis scaled to length / the `BeamEnd` node's Y
(512 in the vanilla bolts), keeping its X and Z: the bolts reach the hit with their zigzag
across unchanged, a long beam looks straighter than a short one. TODO(M13): only the procedural
lightning is stretched here; the meshed beams (Staff of Magnus, Auriel's Bow, the Labyrinthian
and Dawnguard beams) keep their own length.

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
Fire_Refraction (`0x10000`): observed in the original, it is read only when a refraction shape's
pass is built, where it picks the falloff variant of the pass that writes the refraction normals
(the utility shader's normal output). TODO(M13): that variant's term is not yet read from the
shader cache; ours draws such shapes as plain refraction. Fire_Refraction without Refraction
(about 50 shapes) builds no refraction pass and is drawn as a regular surface.

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

Dynamic decals (a hit's blood: `src/shell/combat-impacts.ts`) last `[Display]` fDecalLifetime
(30 s); at most `[Decals]` uMaxDecals (1000; the Medium preset 100) are kept, the oldest going
first (observed in the original: each is made with the lifetime, the count capped by the
setting; `expireDecals`). TODO(M13): whether one fades at its end or vanishes.

**Skinned decals** (`skinned-decal.ts`; blood on an actor, `combat-impacts.ts bodyDecal`). The
original walks the shapes in the decal's box: a hidden shape or one flagged no-decals is skipped
with what lies under it, a shape whose shader is itself a Decal takes none, an alpha-blended or
alpha-tested one only with `[Decals]` bAllowDecalsOnAlpha. A skinned shape gets a skinned decal,
made only while fewer than `[Decals]` uMaxSkinDecals (100) live, fewer than `[Display]`
iMaxSkinDecalsPerFrame (25) were made this frame and the actor carries fewer than `[Decals]`
uMaxSkinDecalPerActor (25; Skyrim_Default.ini sets 60): otherwise the new one is not made and
the older stay. No dynamic decal is made farther than `[Display]` fDecalLOD0 (800) from the
camera (observed in the original). Ours: the actor's skinned shapes are skinned on the CPU in
the pose of the hit, their triangles that overlap the box (a separating-axis test against the
unit cube) are copied with their bone weights and partitions (equipment that hides a body part
hides its blood), their texture coordinates projected across the box (u along its X, v down its
Z, in the decal's atlas quarter) and their tangent frames made again for those coordinates in the
files' convention (the stored tangent along +v, the bitangent along +u, measured on the vanilla
bodies); the shape is drawn with the lighting shader as a Decal and Dynamic_Decal (depth bias),
the texture set's textures, the decal's shininess and colour (on the vertex colours) and its
alpha mode, with the actor's pose. It lasts fDecalLifetime as the other dynamic decals. Where
no skinned shape lies in the box the decal is projected onto what does, following the nearest
node (TODO(M13): the original's geometry decals on rigid worn shapes).

## Weather

Which weather the sky shows, and how scripts, the console and conditions control it
(`src/world/sky-weather.ts`, `SkyWeather`; observed in the original). The game has one
sky state for its whole run, kept in the session (`GameSession.sky`): it outlives the
viewers, so a weather set indoors or by a quest is the one shown at the door. The viewers
run it once a frame (`WorldSky.frame` outside, `ModelViewer` indoors) and draw what it holds;
the scripts' bridge (`ScriptWorld`) and the console drive and read it.

**What it holds.** The _current_ weather and the _outgoing_ one it is changing from, the
_transition_ (0..1) between them, the _default_ weather (the regions' choice, or one a script
set without override), the _override_ (a weather held over the regions), the region the
current choice was made in, the player's weather region, the time the current weather
began (game hours), and the sky's _mode_.

**The player's weather region** is chosen as the player enters an exterior cell: of the
cell's regions (XCLR, in order) that belong to its worldspace (REGN WNAM) and have an area
(RPLD polygon) around the player, those with a weather tab (RDAT type 3) compete: one whose
tab is marked Override beats one that is not; otherwise the higher priority wins; on equal
terms the first stays. Indoors the region stays the one outside; an interior with a sky
region (XCCM) uses that one instead for as long as the player is in it.

**Each frame** (not in an interior without a sky, see the modes):

- _How long a weather lasts_ comes from the climate's volatility: `(255 − volatility) × 22 /
255 + 1` game hours (SkyrimClimate's 50: 18.69 h; 0: 23 h). The time since a weather came
  wraps at midnight (a weather that began at 23:00 is one hour old at midnight).
- An override that has lasted that long is let go, as if released.
- With an override, the override is the weather wanted. Otherwise the regions choose:
  - In the same region as last time (and nothing released): while the weather still has
    time, nothing changes in a region; without a region the default stands (or one picked
    from the climate's list becomes the default). Once its time is up a new one is picked
    from the region (else the climate) — again each frame until one differs from the
    current, so the weather changes as soon as its time is up.
  - In another region, or just after a release: the region's pick is wanted, but a weather
    the region also has may stay, the more likely the younger it is (a random number above
    the share of its life that has passed keeps it). Without a region, a current weather
    the climate also has may stay the same way (it becomes the default); else the default
    (or a climate pick) is wanted.
  - A pick is by chance: a random whole number below the sum of the chances (an entry's
    chance is its global's value if it names one) falls into one entry's share; entries of
    chance 0 never come. With nothing at all, DefaultWeather (`0x15E`).
- A wanted weather that differs from the current one begins only once no change is under
  way. It begins with a change from the current one — at once (no outgoing weather) after
  fast travel or when there is no sky.
- The transition is the game hours since the weather began over its change time:
  `transDelta × (fWeatherTransMax − fWeatherTransMin) + fWeatherTransMin` hours (0.01..0.25
  h; Trans Delta is WTHR DATA byte 3 / 255, 125 for most weathers: 0.128 h, about 23 real
  seconds at TimeScale 20). It runs on game time: it stands still in menus, and waiting or
  sleeping finishes it. Above 1 the change is over (the outgoing weather goes).
- Under the full sky the wind is the current weather's, blended with the outgoing one's
  through a change (GetWindSpeed); elsewhere it keeps its last value.

**Scripts and the console:**

- `Weather.SetActive(override, accelerate)` and the console's `sw <weather> [1]`: with
  override the weather becomes the override; without, it becomes the default and the region
  is forgotten (until the player enters the next cell, when the regions choose again). The
  weather comes through a change on the next frame (after one under way). _Accelerate_
  hurries a change under way: from the moment of the call its remaining part runs
  fWeatherTransAccel + 1 times faster (Skyrim.esm sets fWeatherTransAccel to 16). The console
  never hurries. With no weather at all yet, SetActive forces.
- `Weather.ForceActive(override)` and the console's `fw <weather> [1]`: the engine queues them
  for its next frame, then the weather is there at once (no change), as the override or the
  default, and the region is forgotten as with SetActive.
- `Weather.ReleaseOverride` and `rwo`: the override goes and the regions choose again at once
  (a young current weather the region has may stay).
- `GetCurrentWeather`, `GetOutgoingWeather`, `GetCurrentWeatherTransition` read the state.
- `Weather.FindWeather(class)` (0 pleasant, 1 cloudy, 2 rainy, 3 snow): of the region's list
  (the interior's sky region first), else the climate's, the weather of that class with the
  _lowest_ chance (the first of equals); a region without weathers finds none.
- `ts` (ToggleSky) turns the sky off (mode none: no dome, clouds, sky objects or rain) and
  back to the place's mode.

**Modes** (`Weather.GetSkyMode`): outside the full sky (3); a worldspace with its own
lighting template (WRLD LTMP) only the dome (2), or none of it as an interior (1) if it also
has No Sky. An interior has no sky (1) unless it has Show Sky (CELL DATA `0x80`: the dome, 2;
with Use Sky Lighting `0x100` the full sky, 3). Without a sky the weather stands still: no
change begins and one under way waits, while game time passes; out again, the hours count and
the change is over at once. Most town interiors have Show Sky (Breezehome, the Sleeping
Giant Inn, Dragonsreach), so their weather runs on with their sky region's list.

**Conditions:** `GetIsCurrentWeather` (a weather, or any of a form list's),
`GetCurrentWeatherPercent` (the transition), `GetWindSpeed`; `IsRaining` / `IsSnowing` hold
once the current weather of that class is past its precipitation fade-in (DATA byte 6) or
while the outgoing one of that class is short of its fade-out (byte 7), both × 0.999 as the
engine scales them; `IsPleasant` / `IsCloudy` are the share of the class: the transition if
the current weather has it plus the rest if the outgoing one has it.

Not read yet: a game-wide state flag the update consults (it lets the weather run in an
interior and keeps a change's start time; most likely the load or reset state); and where the
engine sets its fast-travel state (we set it for the map's fast travel). TODO(M13). Drawing
the dome in interiors with Show Sky (mode 2) and the sky objects in mode 2 worldspaces is
TODO(M13) in the renderer; the state and its weather are as the engine's there.

## Water

The water shader (`shaders/water.wgsl`; the WATR values it reads:
[formats/esm.md](formats/esm.md#water)) and the water's displacement field.

**Under water** the view takes the water type's own imagespace (WATR INAM: UnderwaterImageSpace,
Dawnguard's DLC1_UnderwaterImageSpace, the Soul Cairn's DLC01UnderLava01) in place of the
weather's or the cell's, the screen modifiers on top (`src/world/underwater.ts`).

**Which water.** A cell's water is its XCWT type, else its world's water (NAM2, from the
parent world when the world takes its water from it), at its XCLW height, else the world's
default; LOD water takes the world's NAM3; water meshes take their activator's WNAM, else
DefaultWater. The weather's water multiplier (its colour 14, by time of day and through
transitions) tints the water's body and reflection colour; interiors have none (white). On
the data: Riverwood's river is RiverWaterFlow at −250 (cells 2..6, −13..−10, with flow maps),
Lake Ilinalta RiverWaterFlow at 600 (cells −12..−1, −14..−12; a few cells DefaultWater), the
sea at Solitude the world's DefaultWater at Tamriel's −14000 (DefaultWaterFlowBlend where the
Karth meets it). All three share DefaultWater's colours: shallow 38,39,24, deep 5,14,18,
reflection 119,140,157, fog −10..150 at 0.7, fresnel 0.1, reflectivity 0.8.

**The shader's terms** (`water-color.ts` is its colour model, for tests). The original's
shader cache (`shadersfx\shaders011.fxp` in Skyrim - Shaders.bsa: DirectX 11 bytecode, its
techniques' names stripped) holds 400 water pixel shaders; their terms, observed in the
original:

- **Depth.** From the scene's depth behind the water: the distance the view ray goes through
  the water, and how far that point lies under the surface's plane. Each as a share of the fog's
  far distance (saturated) drives the depth properties: the ray's for the reflections and the
  refraction, the vertical one for the normals and the specular (`property × (share − 1) + 1`).
- **Normal.** The first noise layer around the up axis by its amplitude (`a₁(n₁ − up) + up`),
  the other two added by theirs, normalized, then flattened towards up by the normals' depth
  share. Rivers lay their flow-map normal over it by the flow's strength. Far away the full
  normal gives way to the first layer alone: `saturate((d − 8192) / (F − 8192))` with F the
  water's noise falloff (inferred: 0 in DefaultWater, so the detail fades over 8192 units)
  towards a floor the frame's constants hold (unread; ours 0). The ripple field's normal
  (`normalize(slope × dampener, 0.04)`) takes the waves over by its own z.
- **Refraction.** The surface point moved along the normal's xy by the refraction magnitude
  (world units) times the refraction's depth share, projected; if what lies there is above the
  water, the unmoved point. The body colour is shallow towards deep by the ray's depth share;
  the fog over the scene below is `1 − ((far − depth) / (far − near))^amount`.
- **Reflection.** The cube (below) along the view reflected about the normal flattened towards
  up by the reflectivity (inferred source of that constant), the screen-space reflection over
  it by its own alpha (and the detail), then the reflection colour taken over by that by the
  Reflection Magnitude (DefaultWater 0.42: 58 % reflection colour). The reflection lays over
  the refraction by Schlick's fresnel from the Fresnel Amount, times the reflections' depth
  share (far away it goes to 1).
- **Sun.** `pow(saturate(reflected view · sun), specular power) × specular magnitude` plus the
  sparkle `pow(saturate(normal · (−0.099, −0.099, 0.99)), sparkle power) × sparkle magnitude`
  (a fixed slant of the up axis, not the sun), times the sun's colour and the specular's depth
  share; then the air's fog.

The scene colours the shader samples (refraction, cube, screen-space reflection) are scaled by
one constant and the result by another (the original's HDR scaling; ours keeps linear colour
throughout). TODO(M13): which WATR value feeds which of the shader's constants is our reading of
xEdit's names against the terms (the engine's material setup is unread), as are the detail
floor and the flow normals (WATR NAM5, sampled on a staggered grid of the flow map by
per-geometry constants: ours moves the noise layers along the flow).

**Reflections** (`water-reflection.ts`). Every water technique in the cache samples a cube;
none samples a planar reflection texture. The cube holds what [Water] in the INI reflects, all
on by default: the sky (bReflectSky), land and its LOD (bReflectLODLand), tree LOD
(bReflectLODTrees), object LOD (bReflectLODObjects) and the references flagged Reflected By
Auto Water (REFR flag bit 28: 17 in the load order, 16 of them in exteriors; XPWR entries name
only refracting waters). Ours renders it from the camera mirrored under the nearest water's
plane (seen from there, the straight line through a water point continues as the reflected
view ray), five faces (none looks down) as layers of a 2D array with their matrices for the
lookup, 256 texels a side, what lies under the plane clipped (`frame.wgsl reflectionClipped`).
All faces are drawn when the plane changes, then one a frame. TODO(M13): the cube's size and
refresh (fCubeMapRefreshRate 0), several planes (uMaxExteriorWaterReflections 2, interiors 4,
fExteriorWaterReflectionThreshold 300), interiors (ours reflect the sky colours there) and
whether the reflection is fogged (ours leaves deferred lit objects unfogged).

**Displacement** (`water-displacement.ts`, `water-displacement-gpu.ts`,
`shaders/water-displacement.wgsl`): the surface's interactive ripples, as observed in the
original.

- A height field on a grid fWadingWaterQuadSize (2048) units across and
  fWadingWaterTextureRes (512) texels a side ([Water] in the INI; Skyrim_Default.ini sets
  neither), centred on the camera. The centre moves in whole 4-unit steps once the camera is
  more than 4 units from it, and the field moves with it, so ripples stay where they are.
- Every frame, each actor in the water (wading or swimming at the surface) stamps a ripple
  along its way since the last frame. A splash (an actor or a body entering or leaving the
  water) and a projectile (arrow or spell) passing through the surface stamp a small one
  (scale 0.01) at its point, with bUseBulletWaterDisplacements, within fWadingWaterQuadSize of
  the centre. bUseWaterDisplacements turns it all off.
- The field steps at a fixed 0.025 seconds, as many steps as the frame's time holds (ours: at
  most 8 a frame).
- Two layers, wading and rain, run side by side with four values each: force, velocity,
  falloff and starting size. The wading values are set every frame to 0.2, 1.7, 0.99 and 0.01;
  the rain values are 0.1, 0.6, 0.985 and 0.01 — the vanilla water types' rain simulator
  values. The water types' Displacement Simulator values do not drive the simulation.
- After 10 seconds without a ripple the simulation stops; the next ripple starts it from a
  still surface.

Our reading of the values (TODO(M13): the simulation's shaders are not readable): a ripple
pushes the surface down by its force along its way, with a soft round brush starting size ×
half the grid wide (10 units); a step is the damped wave equation `next = ((2 − v)·h +
(v / 4)·Σ neighbours − previous) · falloff` (stable for velocity v up to 2), heights kept
within ±0.5 (an actor standing still stamps every frame). Rain drops fall
at random over the grid, 4 a step at full rain (TODO(M13): the original's rain pattern). The
field's slopes bend the water's normals, times 2 per texel (TODO(M13): the original's scale)
and times the water type's Displacement Dampener (WATR 22: 0.98 for most water, 0 in the
horse troughs: no ripples there; TODO(M13): how the original's material uses it), fading out
at the grid's edge, and by the depth properties' share of the normals as the waves are.
Interiors run the same field (no sky there: the water frame carries the field alone).

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

## First person

The engine draws the first-person geometry (the arms, the weapon, a torch, an animation object
in the hands) through a camera of its own over the world: first person's field of view
(`[Display] fDefault1stPersonFOV`, the console's second `fov` value) and a near plane of its
own (`[Display] fNear1stPersonDistance`, 5 units), drawn into the nearest
`[Display] f1stPersonFarDepthRange` (0.01) of the depth range (observed in the original). Here
those instances carry `ModelInstance.firstPerson`; their draws get the
`DRAW_FIRST_PERSON` flag (a bit the NiAlphaProperty flags leave unused) and are never culled.
`objectVertex` (common.wgsl) projects them with `frame.firstPersonViewProj` (the player's view
with first person's projection, src/render/first-person-view.ts) and moves their reversed-Z
depth linearly into the band `[0.99, 1]`. The player's controller keeps the eye farther than the
world's near plane (`fNearDistance` 15) from any wall, and a wall at 15.15 units already has
depth 0.99: the arms never sink into a wall, and still hide their own far sides (the band is
linear in clip space, so it interpolates as depth does). The first-person instance's particle
systems (a spell in the hand, a torch's flame, an enchanted weapon's) are drawn the same way
(particle.wgsl). A bow's zoom, the dialogue zoom and the tween menu narrow the world's view
only. TODO(M13): the composite reads the arms' depth as about 15 units away (fog, ambient
occlusion).

## Cameras

The player camera has the engine's states (CommonLibSSE `PlayerCamera::CameraStates`;
src/shell/camera-states.ts), worked out each frame by precedence: a kill camera (VATS: the
killmove and ranged kill cameras, src/shell/killmove-camera.ts), the free camera, the tween
menu's, an animated camera (StartAnimatedCamera), bleedout, furniture, auto vanity, a dragon's
back, then first person, or third person, or a mount's. Riding a horse the third-person camera
takes `fOverShoulderHorse{PosX,AddY,PosZ}` (the engine's 0, -300, 0); on a dragon it is
always third person, zoomed between `fVanityModeMinDistFly` and `fVanityModeMaxDist` ×
`fVanityModeMaxDistFlyMult`.

The dragon's camera (DragonCameraState, observed in the original): its shoulder offsets are
`[Camera] fOverShoulderDragon{PosX,AddY,PosZ}` (0, -600, 0), with a weapon or spell drawn the
GMSTs `fOverShoulderRangedDragon{PosX,AddY,PosZ}` (0, -150, 90). Its heading is kept as the
player's turn about the dragon's heading, so the view turns with the dragon. Only a moving mount
that is horse-like (the ActorTypeHorse keyword, or a race that tilts front to back) holds the
view's heading in the world as it turns, at most `fDragonMaxAngleBeforeTurn` (90°) from its
heading; no vanilla dragon is. When the player has locked the dragon on a target, the view
looks from the player at that target instead; every change between the free view and a locked
one (a lock, a new target, the lock let go) eases over `fDragonCameraDollyTime` (0.75 s), the
heading and pitch each a straight blend from where the view was going. A locked target that
dies, is disabled or unloaded gives way to the next, none left lets the lock go.
`bDragonCameraTargetPlayer` (1) keeps the camera on the player; at 0 it hangs on the dragon while
nothing is locked. The lock itself (src/shell/dragon-target-lock.ts, observed in the original):
Jump locks, gathering the actors within `[Gameplay] fTargetLockXYRange` (7500) of the rider across
the ground (living, loaded and enabled, not the rider or their mount) nearest first by their
distance in space, and takes the first; with `bTargetLockIsToggle` (1) the next press lets go,
at 0 the lock holds while Jump does. Hotkey1 and Hotkey2 step back and on through that list
round its ends (in place of their favorites) while the lock holds. TODO(M13): the engine also
leaves out children, the unconscious and the essential who are down.

The kill cameras' shots play their camera models (meshes\cameras\*.nif, src/render/camera-model.ts):
an NiCamera under its root, the root's place in the shot's frame moved by its own
NiTransformController (keys, or an NiPathInterpolator path: base.nif, baseleft.nif) from the
shot's start, the field of view by the NiCamera's BSFrustumFOVController (its value the frustum's
right edge, the tangent of half the horizontal angle; the top edge keeps its ratio). The models'
root turns hold small turns about looking at the shot's target (their Max camera's -Z); the
camera looks at the target. TODO(M13): how the engine adds those turns, and the bone a shot's
location is measured from. The auto vanity camera starts after `fAutoVanityModeDelay` seconds
without a key, the mouse or movement (not in combat, a menu, a conversation or on a mount; never
with `bDisableAutoVanityMode`, at once with `bForceAutoVanityMode`) and circles the player
`fDefaultAutoVanityZoom` units away, `fAutoVanityIncrement` radians a 60th of a second; any
input ends it, back to the point of view it came from. The camera's shake
(src/shell/camera-shake.ts) comes from the graphs' CameraShake event and Game.ShakeCamera.

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

## Frame time

Most of the engine's game logic is `async` code over cached records: once its reads are cached,
a whole search (a quest's alias over the loaded area, the actors away asked where their
packages have them) runs in microtasks within one task, and the browser draws no frame until it
ends. Lines and quest updates were where that showed: as a scene's line set a stage, the quests
it started searched the loaded area's ~2,000 references, and the page stood still for up to 8 s
in the opening's cart. Measured in the browser (headless Chrome, a CPU profile and the
long-animation-frame entries over the cart ride from Ralof's first line, 90 s):

|        | worst frame | frames > 50 ms | > 100 ms | 95th / 99th percentile | non-frame work ≥ 30 ms |
| ------ | ----------- | -------------- | -------- | ---------------------- | ---------------------- |
| before | 8,013 ms    | 184            | 35       | 61 / 111 ms            | 38 stretches           |
| after  | 639 ms      | 78             | 5        | 39 / 56 ms             | 3 (at most 43 ms)      |

What changed, and why:

- **Lookups by reference** (`world-viewer.ts`): a reference's live placement, node, graph and
  whether it is loaded were found by searching every loaded cell's objects (Is3DLoaded built
  every cell's list of references for each call). Conditions ask them of every candidate
  (GetInCurrentLocation through the reference's placement): each cell's objects are now
  indexed by reference once per list.
- **Conditions** stop at the first failed AND, and who an alias holds and its factions are kept
  per reference (docs/scripting.md, "Conditions", "Quests").
- **Searches give way** after 4 ms of work (`PapyrusScheduler.giveWay`, the browser's next task
  through a message channel): a quest's alias search and the actors away's runs spread over a
  few frames instead of holding one.
- **Routes** (docs/ai.md, "Routes"): a door is queued again only by a cheaper way (17 → 3.5 ms
  a search); the compass's quest door and the actors away route on the main thread.
- **Actors away**: a worldspace's actors are found in its persistent cell once (200 ms each
  run before).

After `setstage MQ102 10` in Riverwood (a quest completed, an objective and its compass marker
shown, the player moved, the actors away asked again) the longest stretches outside the frame
went from 204 ms (actors away), 159, 149, 119 and 94 ms (routes) to 66 ms (the player's move)
and 36 ms; what is left above 50 ms is Ruffle starting the titles and fader menus' players
(AudioContext, WebGL shaders: ~100 ms each).

Voice lines are decoded in the audio worker (docs/audio.md) and subtitles and quest
notifications cost the HUD's Ruffle player a few ms (it runs ~100 ms a second for its three
players whatever they show); neither showed as a long task. Twice the first line of the opening
was followed by a frame of 600–870 ms with the main thread idle (no script, no long task): the
headless browser's GPU process presenting late, as it did every 3 s for a while in another run
(`DXGISwapChainImageBacking::Present` blocking 450 ms in a trace). It did not come back under a
trace: TODO(M13): check on the maintainer's GPU whether the first line's frame stalls there.

### Draw submission

The frame is bound by the main thread, not the GPU: in the QA scenes (headless Chrome, a CPU
profile over 20 s) the page is idle about 1 % of the time, and of the rest about a third is the
renderer handing draws to WebGPU. Each draw costs a few calls (pipeline, material, mesh, the
draw's uniforms by dynamic offset, bones), and the per-object light lists, the TAA's velocity
pass and the focus shadows each added a walk over the draws or more calls per draw. In
Riverwood at 13:00 (`tools/qa-run.ts riverwood`, 60 s) that took the page from about 100 fps to
about 90. What keeps it down (`scene-renderer.ts`):

- Dynamic offsets go to `setBindGroup` as a `Uint32Array` with a start and a length. Handed a
  new JS array per draw, the browser converts a sequence each time: `setBindGroup` was 10 % of
  the main thread, 6 % after.
- A scene keeps a bound round its draws (`GpuScene.bound`, worked out again only after one of
  them moved): every pass leaves a scene outside its view without testing its draws. The focus
  maps and the near cascades see few of the loaded cells.
- Shadow passes walk only a scene's casters (`GpuScene.shadowCasters`), ordered by pipeline,
  material and mesh so that instances of one model follow each other (a depth-only pass ends the
  same in any order), and rebind the material only for alpha-tested casters: the others never
  read it, and every caster's material group has the same layout.
- The focus maps sort their casters out in one walk over the draws, not one per map.
- The velocity pass draws only the moving draws that moved since the last frame: the motion of
  one that did not is the camera's, which the TAA finds again through the depth. First person's
  geometry has its own view and is always drawn. A skinned draw whose palette was rewritten is
  drawn too: each palette keeps its last frame's copy (written once per frame, before the new
  pose), and the velocity shader skins the vertex under both, so moving limbs show their motion.
- An animated draw's uniforms go up only when its matrix, its hidden state or its animated
  material changed (an actor standing still keeps its parts' matrices; its pose goes to the
  bone palette).
- The world map's relief overlay (six samples of two normal maps) is compiled into LOD land's
  pipelines only (`LOD_LAND`, an override constant of `lighting.wgsl`): a branch skipped at run
  time still sizes the registers of the whole shader, and every other lit pipeline (all the
  objects of the Whiterun exterior) now compiles without it. The water's reflection costs
  one 256² face a frame (sky, land, LOD, a few references) once all five are drawn.

## The lighting technique's flags and the fades (observed in the original)

The original picks a lighting shape's technique from its shader flags alone, the later ones
winning: Environment_Mapping (environment map), Glow_Map, Parallax, Facegen_Detail_Map,
FaceGen_RGB_Tint, Hair_Soft_Lighting (the hair technique: the actor's hair colour), Parallax
Occlusion, Landscape, the LOD flags, Multi_Layer_Parallax, Tree_Anim, Multi_Index_Snow with
Projected_UV, Eye_Environment_Mapping. Hair_Soft_Lighting is on all 11,070 hair tint shapes and on
nothing else. EnvMap_Light_Fade and Remappable_Textures are not read by it.

Shadows: Receive_Shadows, Assume_Shadowmask, Decal or Dynamic_Decal lets a shape take the screen
shadow mask (the sun's and the shadow lights' shadows). A shape drawn with alpha blending, or one
fading without the stipple, takes none of it unless it carries Assume_Shadowmask or a decal flag
(the actors' hair, eyes, skin and beards do). lighting.wgsl follows this; it looks the shadow maps
up at the blended surface where the original reads the opaque scene's mask (TODO(M13)).

Screendoor_Alpha_Fade: a shape fading out (its fade value under 1) is stippled when
bEnableStippleFade is on, unless it carries this flag; then it is drawn blended by its fade
alpha instead, without the shadow mask. The ten uses (the falling rocks of the rock hazard,
fxhavokrockhazard.nif) dither here (TODO(M13): draw them blended while they fade).

The sparkle technique (shader type 14, and the second pass of multi-index snow), as its pixel
shaders in the cache have it: the noise is the engine's projected normal detail map
(ProjectedNormalDetail.dds), its blue channel sampled at the UV times |x|^1.3, |x|^1.6 and |x|^1.9
of the Sparkle Parameters (x, y, z, w); `s = Σ min(|b|, 1)^y`; per light (the sun and each point
light) a sparkle is on where `s · z · saturate(r · L)^w ≥ 0.5` (r the view mirrored about the
normal), adding the light's `saturate(n · h)` to the specular. The technique's Snow variant has no
sparkle term, and every type 14 shape of the data (19, the ice of caves and Windhelm) carries the
Snow flag: they draw as snow.

Eyes (shader type 16): the vertex shader takes the eye's reflection centre from the material's
left and right centres by the vertex's eye data (0 left, 1 right: on all 578,856 eye vertices of
the data the nearer centre's), moves it as the vertex is moved (skinning included) and passes the
direction from it to the vertex; the pixel shader reflects the view about that direction for the
cube map and takes the directional ambient with it in place of the normal.

Object fade (object-fade.ts): a reference's fade distance is ten bound radii (fLODBoundRadiusMult),
capped at the loaded grid's edge less its radius and half a cell; its fade range runs from 0.6 of
that (fLODFadeOutPercent) to all of it, starting no nearer than 500 units (iFadeNodeMinNearDistance)
and ending no nearer than 1000. The camera's distance is divided by the reference kind's multiplier
(fLODFadeOutMult...) before it is compared, and a multiplier of 0 or less never fades. Over the
range the reference's fade value goes from 1 to 0 (not clamped). The value does not set the alpha
itself: a reference not shown fades in once the value is above fFadeInThreshold (0.7), by dt /
fFadeInTime (1.2 s) a frame, at most 0.1 a frame, and counts as shown once whole; a shown one fades
out once the value is below fFadeOutThreshold (0.3), by dt / fFadeOutTime (2 s), and is hidden at
0; a fade under way goes on in while the value stays above 0.3. A reference that was not in view
the frame before takes its end state at once. We dither by that alpha (stepFade). TODO(M13): the
original's own fades toward a target alpha (scripts', the camera's) and its per-camera distance
factor.

The shaders' own distance fades (shader-fades.ts): the geometry keeps that divided distance over
7200 as a value (a multiplier of 0 or less: a fifth of the distance); specular and the environment
map fade out as it goes from 0.09 to 0.1 (fSpecularLODFadeStart and End, fEnvmapLODFadeStart and
End), decals (Decal, Dynamic_Decal) from 0.05 to 0.06 (fDecalLODFade...; Skyrim_Default.ini sets
0.45 and 0.5), refraction from 0.025 to 0.03 (fRefractionLODFade...). No_Fade spares decals and
refraction these fades; it does not stop the object fade. The shaders take the value per draw from
the distance of its origin and its fade kind (flags.w bits 5-6) and the frame's scales; blended
decals fade their alpha, the others dissolve by the dither; refraction scales its mask.

LOD between levels: the original switches a terrain or object LOD block to its children (and back)
by showing and hiding the block nodes once the replacing blocks are loaded, without a fade; an
object LOD block is split while the camera's horizontal distance to its nearest point is within the
level's distance (fBlockLevel0Distance, fBlockLevel1Distance) times a camera factor (1 at the
default view, as far as read). Ours does the same (formats/lod.md). Tree LOD is taken to switch the
same way (not read).

## Volumetric lighting

The original scatters the sun's light through a froxel volume over the view, in compute passes
(observed in the original); ours does the same (`volumetric-volume.ts`, `volumetric-data.ts`,
`shaders/volumetric.wgsl`):

- The volume: [Display] iVolumetricLightingQuality picks Low 160 × 96 × 50, Medium (1, the
  default) 224 × 128 × 70, High 320 × 192 × 90 froxels (width, height, depth slices). A 32³ noise
  volume (iVolumetricLightingNoiseTexture*) holds the density noise; the original fills it on the
  GPU at load (its function unread: ours is a tileable two-octave value noise, TODO(M13)).
- The depth repartition: two 4096-entry tables, one of x to the range factor (VOLI NNAM; 40 in
  vanilla), one of x to 1 / the range factor (a second mode, (3^(x r) − 1) / (3^r − 1) and its
  inverse, exists for tests). The generate pass binds the second: a slice coordinate s (0..1)
  stands at clip depth s^(1/r) of the camera's projection (D3D's 0 at the near plane, 1 at the
  far one; the cascades' split distances are handed to the shader as clip depths of the same
  projection), and the composite finds a pixel's slice by its clip depth to the power r. With the
  near plane of 15 ([Display] fNearDistance) and r = 40 half the slices lie within some 900
  units and the last reach tens of thousands. Ours computes the same powers in the shader (the
  table's 4096 steps are finer than the slices) and keeps the original's near plane for the
  slices whatever our camera's is.
- Generate (32 × 32 groups over the width and height, a group per slice): each froxel's density
  and light, from the sun's direction, the camera's view-projection and its inverse, the first
  two shadow cascades' matrices and their split depths (with the cascade count and whether
  shadows are cast at all), the noise scaled by 1 / the density size and offset by its drift plus
  the camera's place, the phase contribution and scattering, the density contribution, and the
  frame index modulo 8 (a jitter through the slice). The noise drifts each frame by the frame time
  × the density size × the wind's direction × the wind speed (against the wind's x, with its y),
  and falls by the falling speed × the frame time × the density size, each times a random share
  of 0..1. Ours: the light is the share of the sun the cascades let through (lit beyond the
  second) times the phase function; the density is 1 mixed with the noise (mean 1) by the
  density contribution. TODO(M13): the generate shader's exact terms are unread.
- Temporal accumulation (bVolumetricLightingEnableTemporalAccumulation): each froxel keeps 0.75
  of the last frame's (fVolumetricLightingTemporalAccumulationFactor); ours reads the last
  frame's froxel at the same place in the world (its uv and slice under the last camera).
- Raymarch: slice by slice from the camera, each slice adding the light it scatters towards the
  eye to what the slices before gathered (the original runs a dispatch per slice with two
  textures in turn; ours one pass per column). Ours scatters by Beer's law, the density over an
  air depth of 8000 units (TODO(M13): the original's coefficient).
- Then the blur (horizontal and vertical passes within each slice; ours a five-tap binomial
  kernel, TODO(M13)) and the composite, which reads the volume at a pixel's place and its depth
  through the inverse table, times the intensity (VOLI CNAM × fVolumetricLightingIntensity) and
  the colour (the sun's mixed with the custom colour), added to the scene. Interiors have none
  (bVolumetricLightingDisableInterior).

Lag bones (lag-bone.ts): each update the bone covers linear velocity × dt of the way to where its
parent would put it (at its rest translation), the part beyond the maximum distance at once; it
keeps its last world rotation and turns back toward its rest rotation by linear rotation × dt.
Skeletons (ActorPose) trail in world space when placed (ActorPose.space: the actor's instance
world), so the actor's own walk and turns swing a tail. Other models with lag bones (the scan of
the meshes: spells' hand effects and projectiles, shouts, torches, a few creatures' effect
models) keep them in their animation (ModelAnimation.lagBones) and the scene renderer keeps a
`ModelLagBones` per placed instance (by its world matrix): each frame the lag nodes trail that
instance's motion in world space, and the parts and particle emitters under them follow, so a
swung torch's flame and a moving hand's spell trail. Rigid worn pieces hung on a skeleton node
(the knuckles, the Akaviri sword: 4 files) do not yet (TODO(M13)).

Measured cost (headless Chrome, 1280 × 720, Whiterun by day, Medium: GPU timestamps): generate
0.07 ms, raymarch 0.03 ms, the blur 0.05 ms, the composite 0.015 ms. To keep it there the passes
keep their bind groups between frames (made again only when the shadow map or depth texture
changes), the two blur directions run in one pass through workgroup memory (the same sums
without writing and reading the volume between them), and where the GPU filters 32-bit floats
(float32-filterable) the composite reads the volume with one trilinear sample instead of eight
loads. `engineDev.renderer.sunEffects.volume.profile = true` fills its `timings` (ms per pass).
