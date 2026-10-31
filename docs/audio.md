# Audio

How the game's sounds play in the browser (`src/audio/`). Files: [formats/audio.md](formats/audio.md);
records: [formats/esm.md](formats/esm.md#sounds), [music](formats/esm.md#music) and
[default objects](formats/esm.md#default-objects).

## Loading

Sound files are read through the VFS on the main thread and decoded in the audio worker
(`src/workers/audio-worker.ts`): WAV directly, xWMA (music, voices) with ffmpeg.wasm, which
loads on the first xWMA file (~0.5 s with the main theme). A descriptor's file is found as the
engine finds it (its name, else the other extension). Decoded files are kept as Web Audio
buffers up to 256 MB, least recently used first out (a playing sound keeps its buffer).

Browsers start audio only after a user gesture: the first click or key resumes the audio
context.

### Voice files that do not exist

A response's voice file is `Sound\Voice\<plugin>\<voice type>\<file>.fuz` under the plugin that
defines the info (its form id's master: a mod's override of a vanilla line keeps Skyrim.esm's
file). Where no file holds it the line is said silently, as the engine says it (observed in the
original): it lasts its text's length in characters times fAIDefaultSpeechMult (0.15 s in
Skyrim.esm), with no least time, where a voiced line lasts its file and then
fGameplayVoiceFilePadding (0.5 s); its subtitle shows meanwhile (`silentLineSeconds`, in the
world, the dialogue menu and scenes alike). The game has no files for its creatures' dialogue
(CreatureDialogueWolf, ...Chicken, ...Draugr: no `cr*voice` folder exists) nor for some bards'
instrumental lines in some voices (BardSongsInstrumental in FemaleYoungEager), so those are silent
in the game too. A missing file is logged once (`WorldLines.voiceFile`): as info where the line is
the game's own (its plugin one the game loads by itself), as a warning where a mod's line lacks
it.

### Output override and response sounds

An info's Audio Output Override (INFO ONAM, 1963 infos) plays its lines through that output
model instead of the default 3D dialogue model (DOBJ DOP2): the dragons', Alduin's and
Paarthurnax's lines carry 10 000 units (SOMDialogue3D10000*), the Greybeards' shouts and the
bards their own reach, some lines are 2D (SOMDialogue2D). A line said in the player's head
(Say's abSpeakInPlayersHead) stays 2D. A response whose voice file does not exist but which
names a sound of its own (TRDT, 157 responses: the giants' and draugr's combat vocals, a goat's
bleat, the bards' instrumental flutes) plays that sound at the speaker's head, the line lasting
the sound's file (`Actors.saySound`). TODO(M13): whether the original also plays a response's
sound beside an existing voice file (no vanilla response has both).

## The graph

- **Categories** (SNCT): one gain per category, connected as the categories' tree to the
  master: a category plays at its own volume × its parents' (`_AudioCategoryMaster` 0.9 ×
  SFX 0.9 × ...) × the user's slider for categories that have one (the journal's Audio settings; the
  slider's default is UNAM).
- **A sound** (`sound-instance.ts`): a buffer source at the descriptor's pitch (frequency
  shift ± a random variation, percent), a gain for its static attenuation and a random cut of
  up to its dB variance, a gain for the output model's distance curve, then a 3D panner (HRTF;
  output models that use HRTF) or fixed speaker levels (output models with defined speaker
  output: the mono / stereo-left / stereo-right rows onto the output's speakers, see "Surround
  output"), into its category. Its output model's reverb send goes to the reverb bus (at its
  category's volume).
- **The master** (observed in the original): the audio starts at `[Audio] fDefaultMasterVolume`
  and the game's start sets the audio menu's `[AudioMenu] fAudioMasterVolume` (SkyrimPrefs.ini)
  over every category; `bEnableAudio=0` makes no sound at all (no sound starts). The journal's
  master slider is the master category's user volume, on top of it.
- **Streaming** (observed in the original): a file larger than `[Audio] uStreamingThreshold`
  (4 MB) streams from the disk on each play instead of being kept; here it is decoded for the
  play and not kept in the decoded-buffer cache. Music always streams (`music-output.ts`).
- **Distance:** the panner only pans; the volume follows the output model's curve
  ([esm.md](formats/esm.md#sounds)), smoothed over 50 ms. Output models without distance
  attenuation play at full volume wherever they play.
- **Looping** (descriptor LNAM): loop plays the file's loop region (WAV `smpl`, else the whole
  file) until stopped; envelope fast and slow also play the part before the loop once (attack)
  and, when stopped, the part after it (release): fast jumps there at once, slow finishes the
  loop's pass first. Sounds stopped because their cell unloads stop at once.
- **The listener** is at the camera, facing along it, Z up.

### Surround output

A defined speaker output model (SOPM ONAM) gives each input channel (mono, or stereo left and
right) a level of 0–100 per speaker in the 7.1 order: front left, front right, centre, LFE,
rear left, rear right, side left, side right; the original hands that matrix to XAudio2 for the
device's speakers. Here (`speakers.ts`, `AudioEngine.layout`) the output takes as many channels
as the device: 8 (7.1, each level on its speaker), 6 (5.1: Web Audio's L R C LFE SL SR, the rear
and side levels together on the surround pair) or 2 (stereo: the centre at −3 dB on both, the
rear and side levels on their side, the LFE dropped). With more than two channels the
destination is discrete: the channels reach the device as they are; HRTF sounds stay on the
front pair. TODO(M13): how the original folds rear and side levels onto a device without those
speakers is not known.

### 3D update and Doppler

Observed in the original: each placed sound's 3D update asks
X3DAudio for its speaker matrix, its direct-path and reverb low-pass coefficients, its reverb
level and its Doppler factor. The matrix sets the voice's output, the reverb level scales its
reverb send, and the direct-path coefficient becomes a low-pass filter on its output
(cutoff = coefficient × sample rate / 6); the Doppler factor sets nothing: no pitch changes with
speed, so here none is applied. Open: the distance low-pass and the reverb level by distance
(X3DAudio's default curves: the low-pass from 1 down to 0.75, the reverb from 1 down to 0
across the curve's distance; which distance the original scales the curves by is not known).

### Rumble

Observed in the original (`rumble.ts`): a sound whose output model allows rumble (SOPM NAM1
flag 0x2: only the player's own first- and third-person models, DOBJ POPM and P3OM) sends its
signal into two buses, one per gamepad motor, at its descriptor's rumble send (SNDR LNAM byte
3: the low four bits the small motor's share in fifteenths, the high four the big motor's;
TODO(M13): which half is which motor is inferred from the data). Each bus meters its loudest
sample of every audio pass; once a frame each peak is raised to
`fAudioRumbleSmallExponent` (0.4) / `fAudioRumbleBigExponent` (0.5), both lowered by
`fAudioRumblePowerAttackAdj` (0.15, at least 0.01) while the player power attacks; below its
dead zone a motor stops (a big motor below its dead zone silences the small one, as the original
does), else it is lerped between its LerpMin and LerpMax. The shell drives the gamepad's
dual-rumble effect with the result (with the Vibration setting on), a frame's strengths held
0.1 s. The player's sounds reach those models once they play through POPM and P3OM.

## Mixing rules

Observed in the original (the settings are `[Audio]` INI settings, `src/world/ini-settings.ts`):

- **Menu mode** (`AudioEngine.setInMenu`, rules in `category-rules.ts`): a menu that pauses the
  game holds the categories the default objects name, with their whole branch of the tree: the
  fading one (DOBJ PDMC, AudioCategoryPausedDuringMenuFade: ambience, magic, the world's effects)
  fades out over fMenuModeFadeOutTime and back in over fMenuModeFadeInTime (3 and 1 s in
  Skyrim_Default.ini; 0.5 compiled in), the immediate one (PIMC, AudioCategoryPausedDuringMenu:
  the voices) at once. Their sounds hold their place (playback rate 0 once faded out) and go on
  from there as the menu closes; sounds that start meanwhile wait. The loading screen
  (`setLoading`) also holds PDLC (AudioCategoryPausedDuringMenuLoad: the effects and the
  interface); the skills menu (`setStatsMenu`) mutes SMSC (AudioCategoryAMBr). Every other
  category plays on: music, and the interface in menus.
- **Slow Time** (`SoundSystem.setTimeMultiplier`): the world's clock slows only the sounds of
  the time-sensitive category (DOBJ TSSC, AudioCategoryNPCKillMove) and its branch, pitch and
  pace together; the rest keep theirs.
- **Dialogue ducking** (`SoundSystem.duckForDialogue`): once the dialogue menu has named its
  speaker, the non-dialogue voices (DOBJ NDSC, AudioCategoryNonVOC) and the effects that fade
  during dialogue (SFDC, AudioCategorySFXFadeDuringDialogue) go down by fNonDialogVoiceDucking
  (9 dB) over fNonDialogVoiceDuckingFadeOut (1.5 s); as the menu closes they come back over
  fNonDialogVoiceDuckingFadeIn (1 s).
- **Speech highlighting** (`SoundSystem`, every frame): while a spoken line plays within
  fMaxHighlightRadius (250) of the listener (or at the listener: a line in the player's head),
  every other spoken line is fNonHighlightSpeechAtten (12 dB) quieter, each change in a straight
  line over fHighlightSpeechOverlap (0.5 s): in an inn the one talking to the player is heard
  over the rest. (iHighlightSpeechOverlap, 500, is not read by the engine.)

## Placed sounds

The loaded cells' sound markers (SOUN) and the looping sounds of activators, moveable
statics, talking activators, lights (torches crackle) and doors (CellSoundEmitter) play while
the listener is within their output model's maximum distance (and stop 10 % beyond it, so
they do not flicker at the edge); those without distance attenuation play while their cell is
loaded. Doors and containers play their open and close sounds when used; load doors their
open sound as the player goes through.

References the game creates after the cells loaded (PlaceAtMe, an explosion's placed object:
`created-objects.ts`) sound the same way: their base's looping sound joins the sound system's
emitters (the 'created' group, while enabled); a sound marker of a one-shot descriptor (the
explosion's placed sound marker) plays once where it appears.

## Acoustic spaces

Interiors have one (cell XCAS); in exteriors placed acoustic spaces (ASPC references) take
effect inside their box. The space in effect gives the reverb (REVB) and its ambience loop
(SNDR, 2D); switching spaces fades the old loop out and the new one in (`[Audio]`
fASFadeOutTime 8 s, fASFadeInTime 3 s). In interiors the space's region (RDAT) gives the
region sounds (below); the Creation Kit offers that field for interiors only. The
reverb is a convolver with an impulse response built from the I3DL2 parameters (decay, HF
decay ratio at the HF reference, room and room HF level, reflections and reverb level and
delay; `reverb.ts`). As I3DL2 defines them, the Reflections and Reverb levels are energies
relative to the direct sound: each part of the response is scaled so that the sum of its squared
samples is that level, however long the decay (the Palace of the Kings' IntRoomStoneLargeReverb,
2.9 s, was otherwise 22 dB louder than the dry sound). XAudio2's own algorithm is not
documented, so this is an approximation
(TODO(M13): compare with the game). Spaces without reverb (DefaultReverb, −100 dB) have none.
Observed in the original: a change of acoustic space moves to the new space's reverb over
`[Audio]` fReverbTransitionTime (0.5 s); here two reverbs crossfade, the old one fading out as
the new one fades in (`AudioEngine.setReverb`).

## Ambience

`ambience.ts`, updated every frame with the surroundings the viewers give
(`SoundSystem.setAmbience`): the regions of the camera's cell (XCLR; indoors the acoustic
space's region), the weather and the one being left during a change, the game hour, indoors
or not, and the last lightning flash.

- **Region sounds** (REGN RDAT type 7, RDSA): each entry names the weather classifications it
  plays in (WTHR DATA flags pleasant, cloudy, rainy, snow; indoors all). Looping entries
  (vanilla: all chance 1) play 2D while the region holds and their conditions hold, fading in
  over `[Audio] fRegionLoopFadeInTime` (6 s) and out over fRegionLoopFadeOutTime (8 s).
  Observed in the original: the region sounds are updated every half second, the entries in
  their regions' order; an entry of chance 1 is a loop (kept while it fits; faded out over
  fRegionLoopFadeOutTime once it does not, or over 0.3 s when the regions have no sounds at
  all), any other a one-shot (vanilla: chance 0.01–0.1) started with half its chance each
  update, so its chance a second. At most uRegionSoundsAllowedPerUpdate (1) sounds start an
  update, loops and one-shots together (a region's second loop starts half a second after its
  first). A one-shot plays east or west of the listener by fRegionRandomSoundPlacementBase
  (100) to fRegionSoundPlacementRandomOffset (650) units, north or south by
  fRegionRandomSoundPlacementBase, and fRegionSoundPlacementZOffset (256) up. A pine forest
  gives a wind bed, cicadas in the morning and a bird call or gust every few seconds; a fort
  interior creaks.
- **Weather sounds** (WTHR SNAM): looping ones (rain, wind) play 2D at the weather's share of
  a change (the old weather's at the rest), so rain fades in as the clouds come. Thunder
  (type 3) follows each lightning flash after 0.5–3 s (inferred: TODO(M13)); a weather's other
  single sounds (gusts in a snowstorm, distant thunder in overcast rain, which has no
  lightning) come at random with a 4 % chance a second (WTHR has no chance of its own; the
  median of the region one-shots'; checked each half-second update at 2 %; TODO(M13)).
- **Conditions** (`sound-conditions.ts`) of ambient sounds use GetCurrentTime (308 uses),
  GetIsCurrentWeather (96), IsInInterior (38), IsRaining and GetGlobalValue (one each: the
  distant catapults of SkyrimOvercastWar while CWDistantCatapultsAMB is 1). Globals have the
  running game's values (what scripts set, the clock's), their starting value (FLTV) before
  its scripts run. The music tracks' add GetCombatTargetHasKeyword (the boss tracks while the
  player fights a dragon: the player's combat target's keywords, read as it changes). A sound
  played by a reference (an actor's SoundPlay events, its spells' and blows' sounds, a script's
  Sound.Play) has its conditions run on it by the running game's evaluator (the draugr's
  taunts are a draugr's, the bow's zoom the player's with Eagle Eye); without one, on the
  player (docs/scripting.md, "Conditions").

## Music

`music.ts` decides what plays, `music-output.ts` plays it. Music types are in play: the
location's and those game events add (combat: the default object BTMS, MUSCombat, or
MUSCombatBoss against an actor with the location reference type Boss, as `combat-music.ts`
decides, observed in the original: weighed every fCombatMusicUpdateTime; a fight against
the player starts it when the player's strength over the strength of its fighters the player
detects is below fCombatMusicPlayerTargetedThreatRatio (Skyrim.esm 1, the engine's own 2), a
fight not against the player when one of its fighters is within
fCombatMusicNearCombatInnerRadius, the player detects one of them and their strength passes the
player's × fCombatMusicPlayerNearStrengthMult; playing, a fight against the player or within
fCombatMusicNearCombatOuterRadius keeps it, the odds not weighed again; it ends
fCombatMusicStopTime after the last fight with its finale. Strength (the engine's, also its
GetThreatRatio's): damage × health / (1 − the armour's reduction, at most 0.99), so a lone
wolf does not start it for a new player but a pack does; `src/shell/actor-combat.ts` feeds it; its
conditions' GetCombatTargetHasKeyword asking the player's foes, the boss music against dragons;
discoveries, quest moments
and the rest through Papyrus MusicType.Add / Remove, from the script runtime). The location's is the cell's
XCMO; indoors else the default object DFMS; outdoors else the music of the camera cell's
regions in effect (RDMO; the same priority and override rule as region sounds), the
worldspace's ZNAM, then DFMS. Tamriel's ZNAM is `_NONE`, so the regions give its music:
Riverwood's pine forest plays MUSExploreForestPine.

- **Which type plays:** the most important in play (lowest priority number; the latest added
  of equals). One flagged Doesn't Queue is dropped when it cannot play at once.
- **Ducking:** a more important type flagged Ducks Current Track (combat, discoveries) plays
  over the current one, which goes on at its Ducking dB lower (combat 100 dB: silent;
  MUSDiscoveryGeneric 3 dB) and comes back up once the ducking music has ended — combat after
  its finale. The fade takes the ducking type's Fade Duration (combat 9 s), else `[Audio]`
  fMusicDuckingSeconds / fMusicUnDuckingSeconds (6 and 8 s in Skyrim_Default.ini).
- **Other changes:** the current music leaves first, then the new type starts. A track with
  cue points (combat) plays on to its next one and crossfades into its finale
  (fMusicFinaleCrossFadeTimeIn 3 s, fMusicFinaleCrossFadeTimeOut 6 s); else it fades out over
  the arriving type's Fade Duration (the Creation Kit: how long another type fades for it),
  else the leaving one's. An abrupt transition starts the new type at once while the old one
  fades. Which fade applies where is inferred from the Creation Kit's descriptions:
  TODO(M13): compare with the game.
- **Tracks:** in order (Maintain Track Order) or shuffled per pass; those whose conditions do
  not hold are skipped (day and night pieces, weathers); after the list a type plays on only
  if it cycles, and Plays One Selection ends it after one track. Silent tracks are pauses
  (the exploration types alternate music and 10–30 s silences). A palette plays its layers at
  once, each layer's pieces one after another at random, for its duration, then fades out.
  Single tracks loop between LNAM's points as often as it says (the Sovngarde chant).
- **Playing:** each type has a bus (a gain ducking turns down) into the music category
  (default object MDSC: AudioCategoryMUS, 0.7 × the master). Files stream through `<audio>`
  elements ([formats/audio.md](formats/audio.md#xwma)), as the engine streams files above
  `[Audio]` uStreamingThreshold (4 MB); the next file of each sequence is
  decoded while the current one plays, and decoded files are kept up to 192 MB, the least
  recently used ones that are not playing going first. Music follows the audio clock and
  waits while audio is suspended (before the first click).

## Impacts

Simulated objects that hit something sound (`impacts.ts`): the physics reports contacts from
each body's contact force events, keeping those where the two sides approached at
`[Audio]` fMinSoundVel (60 units per second) or faster along the contact, measured before the
step — resting and pushing contacts press hard but approach at nearly nothing. The moving
object's material (MATT) names an impact data set (HNAM → IPDS; else its nearest parent's),
which names an impact (IPCT) for the material hit (else for that material's nearest parent);
it plays the impact's light sound (SNAM), or from fCollisionSoundHeavyThreshold (160) its
heavy one (NAM1, else the light one), at the body. One body sounds at most every
iCollisionSoundTimeDelta (150 ms). The landscape's material is that of the land texture
showing most where it was hit (LTEX MNAM; of the quadrant's base and layers at the nearest
point, the largest share of the blend), else the default object DLMT (MaterialDirt). Objects
settling as their cell loads (the warm start, `[HAVOK]` fWarmStartMaxTime)
make no sound until they first come to rest. A plate dropped in Breezehome plays
PHYMaterialCeramicLSD, a basket PHYBasketL/H, a sword PHYMaterialBlade2HandH.

## Footsteps

Actors' animations raise events their footsteps answer (`actor-sounds.ts`): the footstep
set of what an actor wears on its feet (ARMA SNDD; else of any piece it wears with one:
creatures' skins) lists footsteps by gait, each with a tag (FootLeft, FootRight, FootScuffLeft,
FootSprintRight, FootFront, JumpUp, JumpDown, a wolf's NPCWolfHowl) and an impact data set. An
event the set has a footstep for in the actor's gait (else in the walking one) plays that set's
impact for the ground under the actor's feet (a ray down from 32 units above them, leaving out
the player's own capsule: the shape's material, or the land texture's) at the feet; feet under
a water surface (a water activator's volume, the cell's water) step in that water instead: its
type's material (WATR TNAM: MaterialWaterPuddle for the 5 puddle and ankle-deep interior
types, whose impacts are FSTWaterPuddleImpact), else Water, the material of the water volumes'
collision (FSTWaterWalk / Run / Sprint impacts). The engine's exact rule (how deep) is not
documented: TODO(M13). The gait (`footstepGait`): sneaking, sprinting, running or walking, the
player's by their movement, an NPC's by its controller's motion (the movers': sneaking, the
gait its AI asks for while it moves) or, beyond the high process, the gait its AI asks for. The player in iron boots running across the Abandoned Shack's floor plays
FSTWoodRunArmorHeavyLSD / RSD. Animations' **SoundPlay.`<descriptor>`** events play that sound
descriptor (by editor id) at the actor; **NPCSoundPlay.`<descriptor>`** only for actors other
than the player.

An actor wearing no footstep set of its own steps with the default one (DOBJ DFTS,
DefaultFootstepSet).

## Creature sounds

Actors' creature sounds (NPC_ CSDT type, CSDI descriptor, CSDC chance; CSCR: another NPC_ whose
sounds it has instead) are read with the NPC_ its traits come from (`ActorLook.creatureSounds`;
TODO(M13): that they follow the traits template is inferred). Skyrim's types start at Idle (0)
and run Aware, Attack, Hit, Death, Weapon, Movement Loop (6), Conscious Loop (7), Auxiliary 1–8,
Jump, PlayRandom/Loop; the data agrees (MudcrabIdle 0, the dwarven spheres' and spiders' and the
carriage's movement loops 6, every breathing and conscious loop 7). `src/shell/creature-sounds.ts`
plays the conscious loop at the creature's head while it is alive and conscious (a dragon's or
horse's breathing, a draugr's groan, a gargoyle's growl) and the movement loop while it also
moves (faster than 20 units a second); both stop as it dies, falls unconscious or leaves the
stage. TODO(M13): the one-shot types (only the mudcrab names one, Idle) and what the chance
gates are not played: when the original plays them is not known.

## Other engine sounds

- **Spells drawn and put away:** each hand's spell's main effect's Sheathe/Draw sound (MGEF
  SNDD type 0) plays as the hands are drawn and sheathed, beside the weapon's equip and unequip
  sounds (`ActorCombat`).
- **Corpses:** searching a body plays its race's open loot sound (RACE ONAM) as its inventory
  opens and its close loot sound (LNAM) as it closes, at the body.
- **Activators:** an activator's activation sound (ACTI VNAM: a fish caught, a pressure plate,
  a portal) plays at it as the player activates it.
- **Effect shaders:** a shader's ambient sound (EFSH DATA: a burning body, a frost cloak, an
  enchanted blade's unsheathe) plays at the body it covers while it shows.
- **Wards:** a ward that holds plays the default object WASN (when Ward Absorb gives magicka
  back) or WDSN, one that breaks WBSN, at its caster (TODO(M13): which of absorb and deflect is
  which is inferred from their names).
- **Harvest:** a plant that gives nothing this season plays the default object HVFS
  (ITMGenericIngredientUpFailSD) instead of its harvest sound.
- **Death:** the player's death adds the death music (DOBJ DTMS, MUSSpecialDeath). Observed in
  the original: a dying actor says its Death line only within `fDeathSoundMaxDistance` (1000) of
  the player (the player's own always).
- **Telekinesis:** taking hold of an object plays DOBJ TKGS (MAGAlterationTelekinesisGrabSD),
  throwing it TKTS (…ThrowSD), at the player.
- **Activation refused:** a lock the player cannot open (one that needs its key, no lockpicks,
  a lock while pursued) plays the No-Activation Sound (DOBJ NASD, UIActivateFail) beside its
  message. TODO(M13): the other activations the original refuses with it are not known.
- **Hard landing** (observed in the original): a fall that hurts the player plays
  FSTLandHardHeavy when its damage is above `[Audio] fHardLandingDamageThreshold` (500), else
  FSTLandHardLight (by editor id, 2D).
- **Kill camera** (observed in the original): as its slow-motion playback starts, the descriptor
  `[Audio] sDeathCameraEffect` names (MAGShoutSlowTimeActiveLP) plays at the listener; it stops
  as the camera ends.
- **Spoken lines** (observed in the original): a line with lip-sync data starts its sound
  `fSpeechDelay` (0) seconds plus its lead-in after the line begins; a line whose voice file is
  there but fails to play lasts `fSubtitleSpeechDelay` (1.5 s); the lip file's head pitch, roll
  and yaw are multiplied by `[Audio] fDialogueHead{Pitch,Roll,Yaw}Exaggeration` (2) as it is
  read. `fDialogSpeechDelaySeconds` and `fLowPerfCombatantVoiceDistance` are never read.
- **The player's action** (GetPlayerAction: a lock picked or a pick broken) holds for
  `fActorAlertSoundTimer` (5 s), the action timer the original starts as an action is set.

## Water

Each water type's open sound (WATR SNAM: AMBWaterRiverLPSD for rivers and lakes, 2D loops for
cave pools and Blackreach, Apocrypha's sea) loops while such water is near (`water-audio.ts`).
Following the `[Audio]` settings, a grid of uWaterAudioAxisSamplePoints² (8 × 8) points
around the listener, reaching uWaterAudioAmbientAttenuation (2200) units each way, is checked
for water four times a second: a water activator's surface (ACTI WNAM, within its bounds: their
top for flat water; water running down a slope or stairs, as Whiterun's streams, lies
somewhere between the bounds' bottom and top and is taken at the height nearest the listener),
else the cell's water where it lies above the landscape (indoors: everywhere in the cell). The
uWaterAudioSamplePointsToUse (8) nearest water points place each type's loop: towards their
centre (weighted by nearness) at the nearest one's distance, so it follows the shore without
jumping; it fades in over fWaterAudioFadeInSeconds (3 s) and out over fWaterAudioFadeOutSeconds
(5 s). How the engine combines the points is not documented: TODO(M13).

**Under water** (the camera in water: below the surface of a water activator's volume or of
the cell's water, see [physics.md](physics.md#water-volumes)): the categories that mute when
submerged (SNCT FNAM 0x1) fall silent and the default object UWLS (AMBUnderwater2DLPM)
loops. Whiterun's streams have no volume: walking past them (out of Breezehome) is not under
water, as their bounds' top, 1500 units above the street, once made it.
