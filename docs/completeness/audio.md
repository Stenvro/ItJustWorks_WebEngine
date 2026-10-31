# Audio: completeness checklist

"100" for audio: every sound the original plays (Skyrim.esm, Update, the three DLCs and the
Creation Club files of the install) plays when the original plays it, where it plays it, at the
level, pitch, reach and reverb the original gives it; the music the original chooses plays as
it plays it; every spoken line is heard as the original says it. Notes: [audio.md](../audio.md),
[formats/audio.md](../formats/audio.md).

How it is measured: `node tools/audio-inventory.ts` sweeps the load order: every subrecord of
the audio records (SNDR, SOUN, SOPM, SNCT, ASPC, REVB, MUSC, MUST, IPCT, IPDS, FSTP, FSTS), every
field of every other record that names an audio form (found by resolving the form ids in each
field, so no sound field is missed), the values that choose behaviour (descriptor types,
looping, rumble, output model types and speaker maps, category, music type and region flags,
track types, weather sound types, creature sound types, magic effect sound types), the
condition functions of descriptors and tracks, the default objects that name audio forms, the
sound files, the engine's `[Audio]` INI settings and the audio game settings, and the Papyrus
audio natives. `--markdown` prints the tables below; `--open` only what is open. The status
tables live in the tool, kept by hand against `src/audio`, `src/world` and the shell; settings,
default objects and natives count as done when our code names them, unless the tool's table
says otherwise. Rows marked n/a play nothing (data for other systems, values no record uses
for a form, SKSE's natives, the original's thread and cache tuning).

## Counts (2026-10-31, round 2)

| Part                                 | Items | Done | Open | n/a |
| ------------------------------------ | ----: | ---: | ---: | --: |
| Audio records' subrecords            |    56 |   44 |    0 |  12 |
| Sound fields of records              |    81 |   78 |    1 |   2 |
| Descriptor types and values          |     6 |    5 |    1 |   0 |
| Output models (SOPM)                 |    11 |    6 |    5 |   0 |
| Categories, music, regions, weathers |    25 |   25 |    0 |   0 |
| Creature and magic effect sounds     |     9 |    9 |    0 |   0 |
| Condition functions (SNDR, MUST)     |    12 |   12 |    0 |   0 |
| Default objects naming audio forms   |    46 |   41 |    4 |   1 |
| `[Audio]` INI settings               |    56 |   30 |   18 |   8 |
| Audio game settings                  |    26 |   18 |    6 |   2 |
| Papyrus audio natives                |    21 |   12 |    0 |   9 |
| Sound files                          |     6 |    6 |    0 |   0 |
| Behaviour items (below)              |    44 |   30 |   13 |   1 |
| All                                  |   399 |  316 |   48 |  35 |

Round 1 built: creatures' conscious and movement loops (NPC_ CSDT 7 and 6: the dragons', horses'
and draugr's breathing, the dwarven machines' hum), the infos' Audio Output Override (1963
lines through their own output model: dragons and Paarthurnax heard at 10000 units, the
Greybeards' shouts, 2D lines), the responses' own sounds (TRDT: the giants' and draugr's combat
vocals, the bards' flutes), the spells' Sheathe/Draw sounds (908 effects), the races' corpse
loot sounds, the activators' activation sounds, the effect shaders' ambient sounds (a burning
body, a cloak), the wards' absorb, deflect and break sounds, the harvest-failed sound, the
default footstep set, the death music, and, observed in the original, the reverb's crossfade
over fReverbTransitionTime and the region sounds' half-second update (one-shots at half their
chance each update, at most uRegionSoundsAllowedPerUpdate starts an update for loops and
one-shots together, their placement, the 0.3 s fade when the regions have no sounds).

Round 2 built, observed in the original: Alternate Sound For (SNDR SNAM, 247 descriptors): a
sound whose file is not in memory yet plays another of its files that is, else a file of its
alternate (the player's footsteps on any ground fall back to the dirt ones, the item sounds to
ITMGenericUpLoFi) while its own loads; combat music's group threat ratio (a fight not against
the player counts once it is even: its targets' strength over its own between
fCombatMusicGroupThreatRatioMin and Max, decided fCombatMusicGroupThreatRatioTimer after it
forms; fCombatMusicPlayerCombatStrengthCap is never read). Built from the data with the rule
inferred (TODO(M13) in the code): the location's music (LCTN NAM1, after the cell's), the
level-up music (LUMS), the world map's loop (MMSD), the player's output models (POPM in first
person, P3OM in third) and the interface's (IOPM), the bound weapons' idle loop (WEAP UNAM),
the crossbows' 2D attack sound for the player's shot (WEAP XNAM), and the mudcrab's idle sound
(CSDT 0) with its ambient idles.

## Behaviour checklist

What a sweep of the data cannot see: the engine's own rules around the records.

| #   | Item                                                                               | Status | Where / why                                                                           |
| --- | ---------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| 1   | Categories as a tree, each a gain under its parent, the user's sliders             | done   | audio-engine.ts                                                                       |
| 2   | Master volume settings (fDefaultMasterVolume, AudioMenu fAudioMasterVolume)        | open   | not read; the journal's master slider is ours                                         |
| 3   | 3D placement: HRTF for HRTF models, fixed speaker levels for the others            | done   | sound-instance.ts                                                                     |
| 4   | Distance attenuation by the output model's curve, min and max distance             | done   | attenuation.ts                                                                        |
| 5   | Static attenuation, dB variance, frequency shift and variance per play             | done   | sound-instance.ts                                                                     |
| 6   | Looping: loop region, envelope fast and slow (attack, loop, release)               | done   | sound-instance.ts                                                                     |
| 7   | Occlusion and obstruction                                                          | n/a    | the original has none: no record, flag or setting names them                          |
| 8   | Doppler                                                                            | open   | not applied; whether the original's 3D calculation shifts pitch by speed is not known |
| 9   | Menu pause categories (fade, immediate, loading screen), the skills menu's mute    | done   | category-rules.ts                                                                     |
| 10  | Slow Time's time-sensitive category                                                | done   | sound-system setTimeMultiplier                                                        |
| 11  | Dialogue ducking of non-dialogue voices and effects                                | done   | sound-system duckForDialogue                                                          |
| 12  | Speech highlighting                                                                | done   | sound-system                                                                          |
| 13  | Under water: categories muted, the underwater loop                                 | done   | sound-system                                                                          |
| 14  | Reverb by acoustic space (interior cell, exterior boxes, the map's)                | done   | sound-system, reverb.ts                                                               |
| 15  | Reverb crossfade over fReverbTransitionTime                                        | done   | audio-engine setReverb (observed in the original)                                     |
| 16  | Reverb sound (XAudio2's I3DL2 reverb)                                              | open   | an impulse response built from the parameters: an approximation (TODO(M13))           |
| 17  | Acoustic space ambience loops (fASFadeInTime, fASFadeOutTime)                      | done   | sound-system                                                                          |
| 18  | Region sounds: half-second update, chances, start limit, placement, fades          | done   | ambience.ts (observed in the original)                                                |
| 19  | Weather loops and thunder after flashes                                            | done   | ambience.ts                                                                           |
| 20  | Thunder's delay after a flash, the weather one-shots' chance                       | open   | inferred (0.5–3 s; 4 % a second): TODO(M13)                                           |
| 21  | Music: priority, queueing, ducking, cue points and finales, palettes, silences     | done   | music.ts                                                                              |
| 22  | Music: which fade applies to which change                                          | open   | inferred from the Creation Kit's descriptions (TODO(M13))                             |
| 23  | Combat music: start, keep, stop rules                                              | done   | combat-music.ts                                                                       |
| 24  | Combat music: a second group's threat ratio, the strength cap                      | done   | combat-music.ts (observed in the original; the cap is never read)                     |
| 25  | Location music: cell, regions, worldspace, default; the location's (LCTN NAM1)     | done   | sound-system #locationMusic (the location's place inferred: TODO(M13))                |
| 26  | Special music: dungeon cleared, death                                              | done   | location-clearing.ts, player-death.ts                                                 |
| 27  | Special music: level up and success (LUMS, SCMS)                                   | open   | level up done (progression-engine); when the success music (SCMS) plays: not known    |
| 28  | Spoken lines: voice files, lip sync, silent lines' length, padding                 | done   | sound-system voiceLine, world-lines.ts, actors.ts                                     |
| 29  | Spoken lines through the info's output model, or the response's own sound          | done   | sound-system voiceLine, actors saySound                                               |
| 30  | Head motion of lip sync scaled by fDialogueHead*Exaggeration                       | open   | not read                                                                              |
| 31  | Speech delays (fDialogSpeechDelaySeconds, fSubtitleSpeechDelay, fSpeechDelay)      | open   | not read                                                                              |
| 32  | Impacts, footsteps (with the default set), splashes, water ambience                | done   | impacts.ts, actor-sounds.ts, water-audio.ts                                           |
| 33  | Creature loops (conscious, movement)                                               | done   | creature-sounds.ts                                                                    |
| 34  | Creature one-shots (idle, aware, attack, hit, death)                               | done   | creature-sounds.ts: the idle with an ambient idle (inferred: TODO(M13)); no other     |
| 35  | Placed sound markers and looping objects                                           | done   | cell-loader, sound-system emitters                                                    |
| 36  | Sound markers placed at run time (PlaceAtMe, an explosion's placed object)         | open   | emitters come from cell loads only                                                    |
| 37  | Spell draw sounds, corpse loot, activators, effect shaders, wards, harvest fail    | done   | actor-combat, actors.ts, play-session, actor-effects, casting-engine, harvest-engine  |
| 38  | Telekinesis grab and throw sounds, activation refused (TKGS, TKTS, NASD)           | open   | not played                                                                            |
| 39  | The player's own output models (POPM first person, P3OM third), the interface's    | done   | sound-system playerView, playInterface (per-object models observed; TODO(M13))        |
| 40  | Kill camera sound (sDeathCameraEffect), hard landing (fHardLandingDamageThreshold) | open   | not played                                                                            |
| 41  | Surround output (rear, side, LFE speakers of defined speaker models)               | open   | the output is stereo; rear and side fold to their side                                |
| 42  | Sound-driven gamepad rumble (SNDR rumble send, SOPM Allows Rumble, fAudioRumble*)  | open   | not built                                                                             |
| 43  | Streaming and the decoded-buffer budget                                            | done   | music streams (music-output.ts), effects in a 256 MB cache                            |
| 44  | Bink videos' sound                                                                 | done   | bink-video.ts                                                                         |

The next biggest open items: surround output (rear, side and LFE speakers), sound-driven
rumble, sound markers placed at run time, telekinesis and activation-refused sounds, the
lip-sync head exaggeration and the speech delays, when the success music (SCMS) plays, the
reverb's own sound (an approximation of XAudio2's), thunder's delay and the weather one-shots'
chance, and which music fade applies to which change.

## The data sweep

### Records: ASPC (52)

| Item | Uses | Status | Where / why |
| ---- | ---: | ------ | ----------- |
| BNAM |   41 | done   | read        |
| RDAT |   38 | done   | read        |
| SNAM |   41 | done   | read        |

### Records: FSTP (191)

| Item | Uses | Status | Where / why |
| ---- | ---: | ------ | ----------- |
| ANAM |  191 | done   | read        |
| DATA |  191 | done   | read        |

### Records: FSTS (52)

| Item | Uses | Status | Where / why                           |
| ---- | ---: | ------ | ------------------------------------- |
| DATA |   52 | done   | read                                  |
| XCNT |   52 | done   | the gait counts (footstep-records.ts) |

### Records: IPCT (663)

| Item | Uses | Status | Where / why                                                                         |
| ---- | ---: | ------ | ----------------------------------------------------------------------------------- |
| DATA |  663 | done   | impact-records.ts: duration, orientation, radius (decals); sound level is detection |
| DNAM |   96 | n/a    | texture set (rendering)                                                             |
| DODT |  613 | n/a    | decal data (rendering)                                                              |
| ENAM |    7 | n/a    | secondary texture set (rendering)                                                   |
| MODL |  341 | n/a    | its model (rendering)                                                               |
| MODT |  219 | n/a    | texture hashes                                                                      |
| NAM1 |  298 | done   | read                                                                                |
| NAM2 |   32 | n/a    | hazard (gameplay)                                                                   |
| SNAM |  650 | done   | read                                                                                |

### Records: IPDS (313)

| Item | Uses | Status | Where / why |
| ---- | ---: | ------ | ----------- |
| PNAM |  312 | done   | read        |

### Records: MUSC (64)

| Item | Uses | Status | Where / why |
| ---- | ---: | ------ | ----------- |
| FNAM |   64 | done   | read        |
| PNAM |   64 | done   | read        |
| TNAM |   64 | done   | read        |
| WNAM |   64 | done   | read        |

### Records: MUST (309)

| Item | Uses | Status | Where / why                           |
| ---- | ---: | ------ | ------------------------------------- |
| ANAM |  283 | done   | read                                  |
| BNAM |   19 | done   | read                                  |
| CITC |   62 | n/a    | the condition count                   |
| CNAM |  309 | done   | read                                  |
| CTDA |   62 | done   | conditions: see "Condition functions" |
| DNAM |   21 | done   | read                                  |
| FLTV |   26 | done   | read                                  |
| FNAM |   19 | done   | read                                  |
| LNAM |    1 | done   | read                                  |
| SNAM |   21 | done   | read                                  |

### Records: REVB (11)

| Item | Uses | Status | Where / why |
| ---- | ---: | ------ | ----------- |
| DATA |   11 | done   | read        |

### Records: SNCT (18)

| Item | Uses | Status | Where / why                                       |
| ---- | ---: | ------ | ------------------------------------------------- |
| FNAM |   18 | done   | read                                              |
| FULL |   18 | done   | the settings slider name (journal Audio settings) |
| PNAM |   17 | done   | read                                              |
| UNAM |    4 | done   | read                                              |
| VNAM |   18 | done   | read                                              |

### Records: SNDR (3186)

| Item | Uses | Status | Where / why                                                                                |
| ---- | ---: | ------ | ------------------------------------------------------------------------------------------ |
| ANAM | 3186 | done   | read                                                                                       |
| BNAM | 3186 | done   | read                                                                                       |
| CNAM | 3186 | done   | descriptor type: see "Descriptor types" below                                              |
| CTDA |  240 | done   | conditions: see "Condition functions"                                                      |
| FNAM |   63 | done   | older form versions: the looping flag (sound-records.ts)                                   |
| GNAM | 3176 | done   | read                                                                                       |
| LNAM | 3123 | done   | looping (byte 1); its rumble send (byte 3): see "Descriptor values"                        |
| ONAM | 3186 | done   | read                                                                                       |
| SNAM |  247 | done   | Alternate Sound For: played at once while the descriptor's file loads (alternate-sound.ts) |

### Records: SOPM (86)

| Item | Uses | Status | Where / why                |
| ---- | ---: | ------ | -------------------------- |
| ANAM |   80 | done   | read                       |
| CNAM |    4 | n/a    | unused by the Creation Kit |
| FNAM |    4 | n/a    | unused by the Creation Kit |
| MNAM |   86 | done   | read                       |
| NAM1 |   82 | done   | read                       |
| ONAM |   35 | done   | read                       |
| SNAM |    4 | n/a    | unused by the Creation Kit |

### Records: SOUN (1191)

| Item | Uses | Status | Where / why                                                        |
| ---- | ---: | ------ | ------------------------------------------------------------------ |
| FNAM |  552 | n/a    | older form versions' file name: every marker names its descriptor  |
| SDSC | 1191 | done   | read                                                               |
| SNDD |  659 | n/a    | older form versions' sound data: every marker names its descriptor |

### Sound fields of records

| Item                                                    |  Uses | Status | Where / why                                                                       |
| ------------------------------------------------------- | ----: | ------ | --------------------------------------------------------------------------------- |
| ACTI SNAM@0 looping sound                               |    33 | done   | cell-loader loopingSoundOf → placed sounds                                        |
| ACTI VNAM@0 activation sound                            |    96 | done   | play-session objectActivation                                                     |
| ALCH ENIT@16 consume sound                              |   470 | done   | equipment-engine consumeSound                                                     |
| ALCH YNAM@0 pick up sound                               |   358 | done   | inventory itemSound                                                               |
| ALCH ZNAM@0 put down sound                              |   324 | done   | inventory itemSound                                                               |
| AMMO YNAM@0 pick up sound                               |    62 | done   | inventory itemSound                                                               |
| AMMO ZNAM@0 put down sound                              |    62 | done   | inventory itemSound                                                               |
| ARMA SNDD@0 footstep set                                |   298 | done   | actor-sounds footsteps                                                            |
| ARMO BIDS@0 block bash impact data set (shields)        |   316 | done   | actor-combat bash                                                                 |
| ARMO YNAM@0 pick up sound                               |   494 | done   | inventory itemSound                                                               |
| ARMO ZNAM@0 put down sound                              |   494 | done   | inventory itemSound                                                               |
| ASPC BNAM@0 reverb                                      |    41 | done   | reverb.ts                                                                         |
| ASPC SNAM@0 ambience loop                               |    41 | done   | sound-system acoustic spaces                                                      |
| BOOK YNAM@0 pick up sound                               |   450 | done   | inventory itemSound                                                               |
| BPTD BPND@68 impact data set (dismember)                |    12 | done   | body-part-data                                                                    |
| BPTD BPND@72 impact data set (explode)                  |    12 | done   | body-part-data                                                                    |
| CELL XCAS@0 acoustic space                              |   769 | done   | sound-system acoustic spaces                                                      |
| CELL XCMO@0 music                                       |   820 | done   | music (location music)                                                            |
| CONT QNAM@0 close sound                                 |   184 | done   | play-session container activation                                                 |
| CONT SNAM@0 open sound                                  |   188 | done   | play-session container activation                                                 |
| DOOR ANAM@0 close sound                                 |   132 | done   | play-session door activation                                                      |
| DOOR BNAM@0 looping sound                               |     1 | done   | cell-loader loopingSoundOf                                                        |
| DOOR SNAM@0 open sound                                  |   141 | done   | play-session door activation                                                      |
| EFSH DATA@308 ambient sound                             |    92 | done   | actor-effects: at the body while it shows                                         |
| EXPL DATA@12 impact data set                            |    94 | done   | magic-projectiles explosion                                                       |
| EXPL DATA@16 placed object (a sound marker)             |     1 | open   | sound markers placed at run time do not play (emitters come from cell loads only) |
| EXPL DATA@28 an older layout's float matching a form id |     1 | n/a    | not a form                                                                        |
| EXPL DATA@4 sound 1                                     |   171 | done   | magic-projectiles explosion                                                       |
| EXPL DATA@8 sound 2                                     |    99 | done   | magic-projectiles explosion                                                       |
| FLOR SNAM@0 harvest sound                               |   109 | done   | harvest-engine                                                                    |
| FSTP DATA@0 impact data set                             |   191 | done   | actor-sounds footsteps                                                            |
| FSTS DATA@0 footsteps                                   |    52 | done   | footstep-records                                                                  |
| HAZD DATA@36 sound                                      |    42 | done   | magic-fx hazards                                                                  |
| INFO ONAM@0 audio output override                       |  1963 | done   | sound-system voiceLine                                                            |
| INFO TRDT@16 response sound                             |   157 | done   | world-lines, dialogue-menu: lines without a voice file                            |
| INGR YNAM@0 pick up sound                               |   113 | done   | inventory itemSound                                                               |
| INGR ZNAM@0 put down sound                              |    76 | done   | inventory itemSound                                                               |
| IPCT NAM1@0 heavy sound                                 |   298 | done   | impacts.ts                                                                        |
| IPCT SNAM@0 sound                                       |   650 | done   | impacts.ts                                                                        |
| IPDS PNAM@4 impact per material                         | 18184 | done   | impacts.ts                                                                        |
| KEYM YNAM@0 pick up sound                               |   259 | done   | inventory itemSound                                                               |
| KEYM ZNAM@0 put down sound                              |   259 | done   | inventory itemSound                                                               |
| LCTN NAM1@0 music                                       |     8 | done   | sound-system: the location's music, after the cell's                              |
| LIGH SNAM@0 looping sound                               |     4 | done   | cell-loader loopingSoundOf                                                        |
| MATT HNAM@0 impact data set                             |    50 | done   | impacts.ts                                                                        |
| MGEF DATA@0 flags matching a form id                    |     1 | n/a    | not a form                                                                        |
| MGEF DATA@100 impact data set                           |   556 | done   | magic-projectiles impacts                                                         |
| MGEF SNDD@12 sound (second entry)                       |   934 | done   | see "Magic effect sounds"                                                         |
| MGEF SNDD@20 sound (third entry)                        |   908 | done   | see "Magic effect sounds"                                                         |
| MGEF SNDD@28 sound (fourth entry)                       |   762 | done   | see "Magic effect sounds"                                                         |
| MGEF SNDD@36 sound (fifth entry)                        |    10 | done   | see "Magic effect sounds"                                                         |
| MGEF SNDD@4 sound (first entry)                         |  1075 | done   | see "Magic effect sounds"                                                         |
| MISC YNAM@0 pick up sound                               |    12 | done   | inventory itemSound                                                               |
| MISC ZNAM@0 put down sound                              |    12 | done   | inventory itemSound                                                               |
| MSTT SNAM@0 looping sound                               |   115 | done   | cell-loader loopingSoundOf                                                        |
| MUSC TNAM@0 tracks                                      |    64 | done   | music.ts                                                                          |
| MUST SNAM@0 palette tracks                              |    21 | done   | music.ts                                                                          |
| NPC_ CSDI@0 creature sound                              |    64 | done   | actor-records; see "Creature sounds"                                              |
| PROJ DATA@40 sound (flight loop)                        |   174 | done   | magic-projectiles                                                                 |
| RACE LNAM@0 close corpse (loot) sound                   |   155 | done   | actors.ts corpse search                                                           |
| RACE NAM5@0 unarmed impact data set                     |   161 | done   | actor-combat                                                                      |
| RACE ONAM@0 open corpse (loot) sound                    |   155 | done   | actors.ts corpse search                                                           |
| REGN RDMO@0 region music                                |    36 | done   | music (location music)                                                            |
| REGN RDSA@0 region sound                                |    70 | done   | ambience                                                                          |
| SNCT PNAM@0 parent category                             |    17 | done   | audio-engine category tree                                                        |
| SNDR GNAM@0 category                                    |  3176 | done   | sound-instance                                                                    |
| SNDR ONAM@0 output model                                |  3186 | done   | sound-instance                                                                    |
| SNDR SNAM@0 alternate sound for                         |   247 | done   | see SNDR SNAM                                                                     |
| SOUN SDSC@0 descriptor                                  |  1191 | done   | cell-loader placed sounds                                                         |
| TREE SNAM@0 harvest sound                               |    76 | done   | harvest-engine                                                                    |
| WATR SNAM@0 open sound                                  |    26 | done   | water-audio                                                                       |
| WEAP BIDS@0 block bash impact data set                  |  3268 | done   | actor-combat bash                                                                 |
| WEAP INAM@0 impact data set                             |  3230 | done   | combat-impacts                                                                    |
| WEAP NAM8@0 unequip sound                               |  3307 | done   | actor-combat sheathe, inventory unequip                                           |
| WEAP NAM9@0 equip sound                                 |  3307 | done   | actor-combat draw, inventory equip                                                |
| WEAP SNAM@0 attack sound                                |    49 | done   | actor-combat                                                                      |
| WEAP TNAM@0 swing sound ("Attack Fail" in xEdit)        |  3244 | done   | actor-combat swing                                                                |
| WEAP UNAM@0 idle sound (bound weapons' loop)            |    10 | done   | weapon-idle-sounds.ts: loops while drawn                                          |
| WEAP XNAM@0 attack sound 2D (crossbows)                 |    36 | done   | actor-combat: the player's shot                                                   |
| WRLD ZNAM@0 music                                       |    37 | done   | music (location music)                                                            |
| WTHR SNAM@0 weather sound                               |    45 | done   | ambience (see "Weather sounds")                                                   |

### Descriptor types (SNDR CNAM)

| Item                | Uses | Status | Where / why                        |
| ------------------- | ---: | ------ | ---------------------------------- |
| 0x1eef540a Standard | 3186 | done   | one file at random, sound-instance |

### Descriptor values (SNDR LNAM, BNAM)

| Item                      | Uses | Status | Where / why                                          |
| ------------------------- | ---: | ------ | ---------------------------------------------------- |
| 0 looping: none           | 2631 | done   | sound-instance                                       |
| 8 looping: Loop           |  452 | done   | sound-instance: the smpl region, else the whole file |
| 16 looping: Envelope Fast |  102 | done   | sound-instance: attack, loop, release at once        |
| 32 looping: Envelope Slow |    1 | done   | sound-instance: release after the pass               |
| rumble send > 0           |  113 | open   | sound-driven gamepad rumble not built                |

### Output models (SOPM)

| Item                                | Uses | Status | Where / why                                                          |
| ----------------------------------- | ---: | ------ | -------------------------------------------------------------------- |
| 0 Uses HRTF                         |   47 | done   | sound-instance: HRTF panner                                          |
| 1 Defined Speaker Output            |   39 | done   | sound-instance: fixed speaker levels                                 |
| bit 0 flag Attenuates With Distance |   76 | done   | attenuation.ts curve                                                 |
| bit 1 flag Allows Rumble            |    2 | open   | sound-driven gamepad rumble not built                                |
| speaker output to C                 |    3 | done   | sound-instance: left, right, centre at -3 dB to both                 |
| speaker output to FL                |   35 | done   | sound-instance: left, right, centre at -3 dB to both                 |
| speaker output to FR                |   35 | done   | sound-instance: left, right, centre at -3 dB to both                 |
| speaker output to RL                |   35 | open   | rear and side speakers fold to their side: surround output not built |
| speaker output to RR                |   35 | open   | rear and side speakers fold to their side: surround output not built |
| speaker output to SL                |   35 | open   | rear and side speakers fold to their side: surround output not built |
| speaker output to SR                |   35 | open   | rear and side speakers fold to their side: surround output not built |

### Categories (SNCT FNAM)

| Item                        | Uses | Status | Where / why                    |
| --------------------------- | ---: | ------ | ------------------------------ |
| bit 0 Mute When Submerged   |    3 | done   | sound-system under water       |
| bit 1 Should Appear on Menu |    4 | done   | journal Audio settings sliders |

### Music types (MUSC FNAM)

| Item                       | Uses | Status | Where / why |
| -------------------------- | ---: | ------ | ----------- |
| bit 0 Plays One Selection  |   20 | done   | music.ts    |
| bit 1 Abrupt Transition    |   10 | done   | music.ts    |
| bit 2 Cycle Tracks         |   38 | done   | music.ts    |
| bit 3 Maintain Track Order |    2 | done   | music.ts    |
| bit 5 Ducks Current Track  |   25 | done   | music.ts    |
| bit 6 Doesn't Queue        |    1 | done   | music.ts    |

### Music tracks (MUST CNAM)

| Item                    | Uses | Status | Where / why     |
| ----------------------- | ---: | ------ | --------------- |
| 0x23f678c3 Palette      |   21 | done   | music.ts layers |
| 0x6ed7e048 Single Track |  283 | done   | music.ts        |
| 0xa1a9c4d5 Silent Track |    5 | done   | music.ts pauses |
| conditions (CTDA)       |   62 | done   | music.ts        |
| cue points (FNAM)       |   19 | done   | music.ts        |
| duration (FLTV)         |   26 | done   | music.ts        |
| fade-out (DNAM)         |   21 | done   | music.ts        |
| finale (BNAM)           |   19 | done   | music.ts        |
| loop data (LNAM)        |    1 | done   | music.ts        |

### Region sounds (REGN RDSA flags)

| Item           | Uses | Status | Where / why |
| -------------- | ---: | ------ | ----------- |
| bit 0 Pleasant |  857 | done   | ambience    |
| bit 1 Cloudy   |  863 | done   | ambience    |
| bit 2 Rainy    |  834 | done   | ambience    |
| bit 3 Snowy    |  706 | done   | ambience    |

### Weather sounds (WTHR SNAM)

| Item            | Uses | Status | Where / why                                                |
| --------------- | ---: | ------ | ---------------------------------------------------------- |
| 0 Default       |   29 | done   | ambience: looping at the weather's share, single at random |
| 1 Precipitation |    9 | done   | ambience: looping at the weather's share                   |
| 2 Wind          |    4 | done   | ambience: looping at the weather's share                   |
| 3 Thunder       |    7 | done   | ambience: after each lightning flash                       |

### Creature sounds (NPC_ CSDT)

| Item             | Uses | Status | Where / why                                             |
| ---------------- | ---: | ------ | ------------------------------------------------------- |
| 0 Idle           |    1 | done   | creature-sounds.ts: with an ambient idle, at its chance |
| 6 Movement Loop  |    4 | done   | creature-sounds.ts: loops while conscious (and moving)  |
| 7 Conscious Loop |   58 | done   | creature-sounds.ts: loops while conscious (and moving)  |

### Magic effect sounds (MGEF SNDD)

| Item                      | Uses | Status | Where / why                                       |
| ------------------------- | ---: | ------ | ------------------------------------------------- |
| 0 Sheathe/Draw            |  908 | done   | actor-combat: as the hands are drawn and put away |
| 1 Charge                  |  808 | done   | actor-casting                                     |
| 2 Ready                   |  766 | done   | actor-casting                                     |
| 3 Release                 | 1005 | done   | actor-casting                                     |
| 4 Concentration Cast Loop |  169 | done   | actor-casting                                     |
| 5 On Hit                  |   33 | done   | magic-engine                                      |

### Condition functions (SNDR, MUST)

| Item                                                | Uses | Status | Where / why                                       |
| --------------------------------------------------- | ---: | ------ | ------------------------------------------------- |
| GetCurrentTime (164 descriptors, 43 tracks)         |  207 | done   | valued (sound-conditions or the game's evaluator) |
| GetIsCurrentWeather (98 descriptors, 48 tracks)     |  146 | done   | valued (sound-conditions or the game's evaluator) |
| IsInInterior (43 descriptors, 0 tracks)             |   43 | done   | valued (sound-conditions or the game's evaluator) |
| GetCombatTargetHasKeyword (0 descriptors, 9 tracks) |    9 | done   | valued (sound-conditions or the game's evaluator) |
| GetGlobalValue (1 descriptors, 0 tracks)            |    1 | done   | valued (sound-conditions or the game's evaluator) |
| IsRaining (2 descriptors, 0 tracks)                 |    2 | done   | valued (sound-conditions or the game's evaluator) |
| GetInFaction (1 descriptors, 0 tracks)              |    1 | done   | valued (sound-conditions or the game's evaluator) |
| HasPerk (3 descriptors, 0 tracks)                   |    3 | done   | valued (sound-conditions or the game's evaluator) |
| GetIsID (2 descriptors, 0 tracks)                   |    2 | done   | valued (sound-conditions or the game's evaluator) |
| GetIsRace (24 descriptors, 0 tracks)                |   24 | done   | valued (sound-conditions or the game's evaluator) |
| GetSleeping (4 descriptors, 0 tracks)               |    4 | done   | valued (sound-conditions or the game's evaluator) |
| IsSwimming (2 descriptors, 0 tracks)                |    2 | done   | valued (sound-conditions or the game's evaluator) |

### Default objects (DOBJ) naming audio forms

| Item                                         | Uses | Status | Where / why                                                                                |
| -------------------------------------------- | ---: | ------ | ------------------------------------------------------------------------------------------ |
| BTMS MUSC MUSCombat                          |    1 | done   | battleMusic                                                                                |
| DCMS MUSC MUSDungeonCleared                  |    1 | done   | dungeonClearedMusic                                                                        |
| DDSC SNCT AudioCategoryVOC                   |    1 | done   | dialogueCategory                                                                           |
| DFMS MUSC MUSExploreTestb                    |    1 | done   | defaultMusic                                                                               |
| DFTS FSTS DefaultFootstepSet                 |    1 | done   | named in code                                                                              |
| DOP2 SOPM SOMDialogue3DDefault               |    1 | done   | dialogueOutput3d                                                                           |
| DOP3 SOPM SOMDialogue2D                      |    1 | done   | dialogueOutput2d                                                                           |
| DTMS MUSC MUSSpecialDeath                    |    1 | done   | deathMusic                                                                                 |
| HFSD SNDR UIHealthHeartbeatBLPSD             |    1 | done   | heartbeatFast                                                                              |
| HSSD SNDR UIHealthHeartbeatALPSD             |    1 | done   | heartbeatSlow                                                                              |
| HVFS SNDR ITMGenericIngredientUpFailSD       |    1 | done   | named in code                                                                              |
| IOPM SOPM SOMUIDefault                       |    1 | done   | interfaceOutput                                                                            |
| LUMS MUSC MUSSpecialSuccess                  |    1 | done   | levelUpMusic                                                                               |
| MDSC SNCT AudioCategoryMUS                   |    1 | done   | musicCategory                                                                              |
| MFSN SNDR MAGFailSD                          |    1 | done   | magicFailSound                                                                             |
| MMSD SNDR AMBrWindBedWorldMapLP              |    1 | done   | worldMapAmbient                                                                            |
| NASD SNDR UIActivateFail                     |    1 | open   | not used                                                                                   |
| NDSC SNCT AudioCategoryNonVOC                |    1 | done   | nonDialogueCategory                                                                        |
| P3OM SOPM SOMMono01400Player3rd              |    1 | done   | playerOutput3rd                                                                            |
| PDLC SNCT AudioCategoryPausedDuringMenuLoad  |    1 | done   | pauseDuringLoadingMenu                                                                     |
| PDMC SNCT AudioCategoryPausedDuringMenuFade  |    1 | done   | pauseDuringMenuFade                                                                        |
| PDSA SNDR ITMGenericArmorDownSD              |    1 | done   | inventory itemSound: the default by the item's kind                                        |
| PDSB SNDR ITMGenericBookDownSD               |    1 | done   | inventory itemSound: the default by the item's kind                                        |
| PDSG SNDR ITMGenericDownSD                   |    1 | done   | inventory itemSound: the default by the item's kind                                        |
| PDSI SNDR ITMGenericIngredientDownSD         |    1 | done   | inventory itemSound: the default by the item's kind                                        |
| PDSW SNDR ITMGenericWeaponDownSD             |    1 | done   | inventory itemSound: the default by the item's kind                                        |
| PIMC SNCT AudioCategoryPausedDuringMenu      |    1 | done   | pauseDuringMenuImmediate                                                                   |
| POPM SOPM SOMMono01400Player1st              |    1 | done   | playerOutput1st                                                                            |
| PUSA SNDR ITMGenericArmorUpSD                |    1 | done   | inventory itemSound: the default by the item's kind                                        |
| PUSB SNDR ITMGenericBookUpSD                 |    1 | done   | inventory itemSound: the default by the item's kind                                        |
| PUSG SNDR ITMGenericUpSD                     |    1 | done   | inventory itemSound: the default by the item's kind                                        |
| PUSI SNDR ITMGenericIngredientUpSD           |    1 | done   | inventory itemSound: the default by the item's kind                                        |
| PUSW SNDR ITMGenericWeaponUpSD               |    1 | done   | inventory itemSound: the default by the item's kind                                        |
| RVBT REVB DefaultReverb                      |    1 | done   | DefaultReverb is silent (-100 dB): as no reverb                                            |
| SCMS MUSC MUSSpecialSuccess                  |    1 | open   | when the original plays the success music is not known (vanilla: LUMS's MUSSpecialSuccess) |
| SFDC SNCT AudioCategorySFXFadeDuringDialogue |    1 | done   | sfxFadeInDialogueCategory                                                                  |
| SFSN SNDR MAGFailShoutSD                     |    1 | done   | shoutFailSound                                                                             |
| SMSC SNCT AudioCategoryAMBr                  |    1 | done   | statsMuteCategory                                                                          |
| SSSC MUSC _NONE                              |    1 | n/a    | names the _NONE music type                                                                 |
| TKGS SNDR MAGAlterationTelekinesisGrabSD     |    1 | open   | not used                                                                                   |
| TKTS SNDR MAGAlterationTelekinesisThrowSD    |    1 | open   | not used                                                                                   |
| TSSC SNCT AudioCategoryNPCKillMove           |    1 | done   | timeSensitiveCategory                                                                      |
| UWLS SNDR AMBUnderwater2DLPM                 |    1 | done   | underwaterLoop                                                                             |
| WASN SNDR MAGWardTestAbsorbSD                |    1 | done   | named in code                                                                              |
| WBSN SNDR MAGWardTestBreakSD                 |    1 | done   | named in code                                                                              |
| WDSN SNDR MAGWardTestDeflectSD               |    1 | done   | named in code                                                                              |

### [Audio] INI settings

| Item                                    | Uses | Status | Where / why                                                                      |
| --------------------------------------- | ---: | ------ | -------------------------------------------------------------------------------- |
| fDialogueHeadPitchExaggeration:Audio    |    1 | open   | not read                                                                         |
| fDialogueHeadRollExaggeration:Audio     |    1 | open   | not read                                                                         |
| fDialogueHeadYawExaggeration:Audio      |    1 | open   | not read                                                                         |
| fMusicDuckingSeconds:Audio              |    1 | done   | read                                                                             |
| fMusicUnDuckingSeconds:Audio            |    1 | done   | read                                                                             |
| fMusicFinaleCrossFadeTimeIn:Audio       |    1 | done   | read                                                                             |
| fMusicFinaleCrossFadeTimeOut:Audio      |    1 | done   | read                                                                             |
| fMinSoundVel:Audio                      |    1 | done   | read                                                                             |
| fWaterAudioFadeInSeconds:Audio          |    1 | done   | read                                                                             |
| fWaterAudioFadeOutSeconds:Audio         |    1 | done   | read                                                                             |
| uWaterAudioSamplePointsToUse:Audio      |    1 | done   | read                                                                             |
| uWaterAudioAxisSamplePoints:Audio       |    1 | done   | read                                                                             |
| uWaterAudioAmbientAttenuation:Audio     |    1 | done   | read                                                                             |
| fAudioRumbleSmallExponent:Audio         |    1 | open   | sound-driven rumble (SNDR rumble send) not built                                 |
| fAudioRumbleBigExponent:Audio           |    1 | open   | sound-driven rumble not built                                                    |
| fAudioRumbleSmallLerpMin:Audio          |    1 | open   | sound-driven rumble not built                                                    |
| fAudioRumbleSmallLerpMax:Audio          |    1 | open   | sound-driven rumble not built                                                    |
| fAudioRumbleSmallDeadZone:Audio         |    1 | open   | sound-driven rumble not built                                                    |
| fAudioRumbleBigLerpMin:Audio            |    1 | open   | sound-driven rumble not built                                                    |
| fAudioRumbleBigLerpMax:Audio            |    1 | open   | sound-driven rumble not built                                                    |
| fAudioRumbleBigDeadZone:Audio           |    1 | open   | sound-driven rumble not built                                                    |
| fAudioRumblePowerAttackAdj:Audio        |    1 | open   | sound-driven rumble not built                                                    |
| fRegionRandomSoundPlacementBase:Audio   |    1 | done   | read                                                                             |
| fRegionSoundPlacementRandomOffset:Audio |    1 | done   | read                                                                             |
| fRegionSoundPlacementZOffset:Audio      |    1 | done   | read                                                                             |
| uRegionSoundsAllowedPerUpdate:Audio     |    1 | done   | read                                                                             |
| fASFadeInTime:Audio                     |    1 | done   | read                                                                             |
| fASFadeOutTime:Audio                    |    1 | done   | read                                                                             |
| fRegionLoopFadeInTime:Audio             |    1 | done   | read                                                                             |
| fRegionLoopFadeOutTime:Audio            |    1 | done   | read                                                                             |
| fReverbTransitionTime:Audio             |    1 | done   | read                                                                             |
| fMenuModeFadeOutTime:Audio              |    1 | done   | read                                                                             |
| fMenuModeFadeInTime:Audio               |    1 | done   | read                                                                             |
| fNonHighlightSpeechAtten:Audio          |    1 | done   | read                                                                             |
| iHighlightSpeechOverlap:Audio           |    1 | n/a    | not read by the engine (fHighlightSpeechOverlap is)                              |
| fMaxHighlightRadius:Audio               |    1 | done   | read                                                                             |
| fHighlightSpeechOverlap:Audio           |    1 | done   | read                                                                             |
| uAudioThreadSleepTimeMenuMode:Audio     |    1 | n/a    | the audio thread's pace: Web Audio runs its own                                  |
| uAudioThreadSleepTimeGameMode:Audio     |    1 | n/a    | the audio thread's pace: Web Audio runs its own                                  |
| fAudioMasterVolume:AudioMenu            |    1 | open   | not read                                                                         |
| iCollisionSoundTimeDelta:Audio          |    1 | done   | read                                                                             |
| fCollisionSoundHeavyThreshold:Audio     |    1 | done   | read                                                                             |
| sAudioAPI:Audio                         |    1 | n/a    | XAudio2: the browser has Web Audio                                               |
| bEnableAudio:Audio                      |    1 | open   | not read                                                                         |
| bEnableAudioCache:Audio                 |    1 | n/a    | the decoded-buffer cache is ours (256 MB, sound-system)                          |
| uMaxSizeForCachedSound:Audio            |    1 | n/a    | the decoded-buffer cache is ours (256 MB, sound-system)                          |
| fDefaultMasterVolume:Audio              |    1 | open   | not read                                                                         |
| sMissingAssetSoundFile:Audio            |    1 | n/a    | empty: a missing file plays nothing (as ours)                                    |
| uStreamingThreshold:Audio               |    1 | open   | music always streams and effects load whole: not checked against the files sizes |
| uAsyncReadPriorityThreshold:Audio       |    1 | n/a    | file read priority of the original's streamer                                    |
| fHardLandingDamageThreshold:Audio       |    1 | open   | not read                                                                         |
| sDeathCameraEffect:Audio                |    1 | open   | not read                                                                         |
| fNonDialogVoiceDucking:Audio            |    1 | done   | read                                                                             |
| fNonDialogVoiceDuckingFadeOut:Audio     |    1 | done   | read                                                                             |
| fNonDialogVoiceDuckingFadeIn:Audio      |    1 | done   | read                                                                             |
| bShowMissingAudioWarnings:MESSAGES      |    1 | done   | missing files are logged once (sound-system)                                     |

### Audio game settings

| Item                                  | Uses | Status | Where / why                            |
| ------------------------------------- | ---: | ------ | -------------------------------------- |
| fCombatMusicUpdateTime                |    1 | done   | read                                   |
| fCombatMusicStopTime                  |    1 | done   | read                                   |
| fCombatMusicNearCombatInnerRadius     |    1 | done   | read                                   |
| fCombatMusicNearCombatOuterRadius     |    1 | done   | read                                   |
| fCombatMusicPlayerTargetedThreatRatio |    1 | done   | read                                   |
| fCombatMusicGroupThreatRatioTimer     |    1 | done   | read                                   |
| fCombatMusicGroupThreatRatioMin       |    1 | done   | read                                   |
| fCombatMusicGroupThreatRatioMax       |    1 | done   | read                                   |
| fCombatMusicPlayerNearStrengthMult    |    1 | done   | read                                   |
| fCombatMusicPlayerCombatStrengthCap   |    1 | n/a    | the original never reads it            |
| fSplashSoundHeavy                     |    1 | done   | read                                   |
| fSplashSoundMedium                    |    1 | done   | read                                   |
| fSplashSoundLight                     |    1 | done   | read                                   |
| fSplashSoundTimer                     |    1 | done   | read                                   |
| fSplashSoundVelocityMult              |    1 | done   | read                                   |
| fSplashSoundOutMult                   |    1 | done   | read                                   |
| fDeathSoundMaxDistance                |    1 | open   | not read                               |
| fGameplayVoiceFilePadding             |    1 | done   | read                                   |
| fAIDefaultSpeechMult                  |    1 | done   | read                                   |
| fDialogSpeechDelaySeconds             |    1 | open   | not read                               |
| fSubtitleSpeechDelay                  |    1 | open   | not read                               |
| fSpeechDelay                          |    1 | open   | not read                               |
| fLowPerfCombatantVoiceDistance        |    1 | open   | not read                               |
| fActorAlertSoundTimer                 |    1 | open   | not read                               |
| bEnableLipLookup                      |    1 | n/a    | lip files are always read when present |
| iLipMorphCount                        |    1 | done   | read                                   |

### Papyrus audio natives

| Item                                  | Uses | Status | Where / why                          |
| ------------------------------------- | ---: | ------ | ------------------------------------ |
| sound.play                            |    1 | done   | natives/forms.ts                     |
| sound.playandwait                     |    1 | done   | natives/forms.ts                     |
| sound.stopinstance                    |    1 | done   | natives/forms.ts                     |
| sound.setinstancevolume               |    1 | done   | natives/forms.ts                     |
| sound.getdescriptor                   |    1 | n/a    | SKSE: no script of the game calls it |
| sounddescriptor.getdecibelattenuation |    1 | n/a    | SKSE: no script of the game calls it |
| sounddescriptor.setdecibelattenuation |    1 | n/a    | SKSE: no script of the game calls it |
| sounddescriptor.getdecibelvariance    |    1 | n/a    | SKSE: no script of the game calls it |
| sounddescriptor.setdecibelvariance    |    1 | n/a    | SKSE: no script of the game calls it |
| sounddescriptor.getfrequencyvariance  |    1 | n/a    | SKSE: no script of the game calls it |
| sounddescriptor.setfrequencyvariance  |    1 | n/a    | SKSE: no script of the game calls it |
| sounddescriptor.getfrequencyshift     |    1 | n/a    | SKSE: no script of the game calls it |
| sounddescriptor.setfrequencyshift     |    1 | n/a    | SKSE: no script of the game calls it |
| soundcategory.pause                   |    1 | done   | natives/forms.ts                     |
| soundcategory.unpause                 |    1 | done   | natives/forms.ts                     |
| soundcategory.mute                    |    1 | done   | natives/forms.ts                     |
| soundcategory.unmute                  |    1 | done   | natives/forms.ts                     |
| soundcategory.setvolume               |    1 | done   | natives/forms.ts                     |
| soundcategory.setfrequency            |    1 | done   | natives/forms.ts                     |
| musictype.add                         |    1 | done   | natives/forms.ts                     |
| musictype.remove                      |    1 | done   | natives/forms.ts                     |

### Sound files

| Item                                             |  Uses | Status | Where / why                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----: | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| descriptor files (5787)                          |  6372 | done   | 50 missing in the data (silent, as the original): sound\fx\npc\werewolf\npc_werewolf_breathe_lp.wav, sound\fx\qst\qst_demofinalshout.wav, sound\fx\mag\shouts\unrelentingforce\thunder\mag_shout_unrelentingforce_thunder_03.wav |
| music track files (274)                          |   302 | done   | 8 missing in the data: music\dread\dread 01 v2.wav, music\dread\dread 04 v2.wav, music\dread\dread 03 v2.wav                                                                                                                     |
| voice files in 242 plugin and voice type folders | 75408 | done   | fuz/xwm/wav and lip (formats/audio)                                                                                                                                                                                              |
| .fuz                                             | 75408 | done   | formats/audio                                                                                                                                                                                                                    |
| .wav                                             |  5978 | done   | formats/audio                                                                                                                                                                                                                    |
| .xwm                                             |   269 | done   | formats/audio                                                                                                                                                                                                                    |
