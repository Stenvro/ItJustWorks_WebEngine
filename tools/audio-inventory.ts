// The audio inventory (docs/completeness/audio.md): sweeps the load order for everything the
// original's audio uses (the audio records and every subrecord they have, the sound fields of
// every other record, the values that choose behaviour: descriptor types, looping, output
// models, categories' flags, music types and tracks, weather and region sounds, creature
// sounds, magic effect sounds), the sound files, the default objects that name audio forms,
// the engine's [Audio] settings and audio game settings, and the Papyrus audio natives, and
// marks every one handled or open by the status tables below.
//
//   node tools/audio-inventory.ts             the sweep's counts with their status
//   node tools/audio-inventory.ts --markdown  the same as the checklist's tables
//   node tools/audio-inventory.ts --open      only what is used and not done
//
// The status tables are kept by hand against src/audio, src/world and the shell: an item is
// "done" only when every use in the data plays as the original plays it. A used item without a
// status counts as open. Settings, default objects and natives are "done" when our code names
// them (and the hand table does not say otherwise).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { DefaultObjects } from '../src/world/default-objects.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { soundFileCandidates, soundFilePath } from '../src/world/sound-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { conditionAudit } from './condition-usage.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values } = parseArgs({
  options: {
    markdown: { type: 'boolean', default: false },
    open: { type: 'boolean', default: false },
  },
});

type Status = 'done' | 'open' | 'n/a';
type Rating = readonly [Status, string];

// --- Our code, as text (what names a setting, a default object, a native) -------------------

const SRC = new URL('../src/', import.meta.url);
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}
const srcRoot = decodeURIComponent(SRC.pathname).replace(/^\/([A-Za-z]:)/, '$1');
const sources = new Map(
  sourceFiles(srcRoot).map((path) => [
    path.slice(srcRoot.length).replace(/\\/g, '/'),
    readFileSync(path, 'utf8'),
  ]),
);
const allSource = [...sources.values()].join('\n');
const sourceOf = (path: string): string => sources.get(path) ?? '';

// --- Status tables ---------------------------------------------------------------------------

/** The audio records and the readers that parse them (subrecords named there are read). */
const AUDIO_RECORDS: Record<string, readonly string[]> = {
  SNDR: ['world/sound-records.ts'],
  SOUN: ['world/sound-records.ts'],
  SOPM: ['world/sound-records.ts'],
  SNCT: ['world/sound-records.ts'],
  ASPC: ['world/sound-records.ts'],
  REVB: ['world/sound-records.ts'],
  MUSC: ['world/sound-records.ts'],
  MUST: ['world/sound-records.ts'],
  IPCT: ['world/impact-records.ts'],
  IPDS: ['world/impact-records.ts'],
  FSTP: ['world/footstep-records.ts'],
  FSTS: ['world/footstep-records.ts'],
};
const RECORD_COMMON = new Set(['EDID', 'OBND']);
/** Subrecords of the audio records rated by hand (what plays nothing, what is not yet played). */
const SUBRECORD_NOTES: Record<string, Rating> = {
  'SNDR CNAM': ['done', 'descriptor type: see "Descriptor types" below'],
  'SNDR FNAM': ['done', 'older form versions: the looping flag (sound-records.ts)'],
  'SNDR SNAM': [
    'done',
    "Alternate Sound For: played at once while the descriptor's file loads (alternate-sound.ts)",
  ],
  'SNDR LNAM': ['done', 'looping (byte 1); its rumble send (byte 3): see "Descriptor values"'],
  'SOUN FNAM': ['n/a', "older form versions' file name: every marker names its descriptor"],
  'SOUN SNDD': ['n/a', "older form versions' sound data: every marker names its descriptor"],
  'MUST CITC': ['n/a', 'the condition count'],
  'SOPM FNAM': ['n/a', 'unused by the Creation Kit'],
  'SOPM ENAM': ['n/a', 'unused by the Creation Kit'],
  'SOPM VNAM': ['n/a', 'unused by the Creation Kit'],
  'SOPM CNAM': ['n/a', 'unused by the Creation Kit'],
  'SOPM SNAM': ['n/a', 'unused by the Creation Kit'],
  'SNCT FULL': ['done', 'the settings slider name (journal Audio settings)'],
  'IPCT DATA': [
    'done',
    'impact-records.ts: duration, orientation, radius (decals); sound level is detection',
  ],
  'IPCT DODT': ['n/a', 'decal data (rendering)'],
  'IPCT DNAM': ['n/a', 'texture set (rendering)'],
  'IPCT ENAM': ['n/a', 'secondary texture set (rendering)'],
  'IPCT NAM2': ['n/a', 'hazard (gameplay)'],
  'IPCT MODL': ['n/a', 'its model (rendering)'],
  'IPCT MODT': ['n/a', 'texture hashes'],
  'FSTS XCNT': ['done', 'the gait counts (footstep-records.ts)'],
};

/**
 * Sound fields of other records: `TYPE FIELD@offset` → [what it is, status, where]. The sweep
 * finds every subrecord holding a form id of an audio record; one not listed here is open.
 */
const SOUND_FIELDS: Record<string, readonly [string, Status, string]> = {
  'ACTI SNAM@0': ['looping sound', 'done', 'cell-loader loopingSoundOf → placed sounds'],
  'ACTI VNAM@0': ['activation sound', 'done', 'play-session objectActivation'],
  'TACT SNAM@0': ['looping sound', 'done', 'cell-loader loopingSoundOf'],
  'MSTT SNAM@0': ['looping sound', 'done', 'cell-loader loopingSoundOf'],
  'LIGH SNAM@0': ['looping sound', 'done', 'cell-loader loopingSoundOf'],
  'DOOR SNAM@0': ['open sound', 'done', 'play-session door activation'],
  'DOOR ANAM@0': ['close sound', 'done', 'play-session door activation'],
  'DOOR BNAM@0': ['looping sound', 'done', 'cell-loader loopingSoundOf'],
  'CONT SNAM@0': ['open sound', 'done', 'play-session container activation'],
  'CONT QNAM@0': ['close sound', 'done', 'play-session container activation'],
  'FLOR SNAM@0': ['harvest sound', 'done', 'harvest-engine'],
  'TREE SNAM@0': ['harvest sound', 'done', 'harvest-engine'],
  'SOUN SDSC@0': ['descriptor', 'done', 'cell-loader placed sounds'],
  'ALCH YNAM@0': ['pick up sound', 'done', 'inventory itemSound'],
  'ALCH ZNAM@0': ['put down sound', 'done', 'inventory itemSound'],
  'ALCH ENIT@16': ['consume sound', 'done', 'equipment-engine consumeSound'],
  'AMMO YNAM@0': ['pick up sound', 'done', 'inventory itemSound'],
  'AMMO ZNAM@0': ['put down sound', 'done', 'inventory itemSound'],
  'ARMO YNAM@0': ['pick up sound', 'done', 'inventory itemSound'],
  'ARMO ZNAM@0': ['put down sound', 'done', 'inventory itemSound'],
  'BOOK YNAM@0': ['pick up sound', 'done', 'inventory itemSound'],
  'BOOK ZNAM@0': ['put down sound', 'done', 'inventory itemSound'],
  'INGR YNAM@0': ['pick up sound', 'done', 'inventory itemSound'],
  'INGR ZNAM@0': ['put down sound', 'done', 'inventory itemSound'],
  'KEYM YNAM@0': ['pick up sound', 'done', 'inventory itemSound'],
  'KEYM ZNAM@0': ['put down sound', 'done', 'inventory itemSound'],
  'MISC YNAM@0': ['pick up sound', 'done', 'inventory itemSound'],
  'MISC ZNAM@0': ['put down sound', 'done', 'inventory itemSound'],
  'SCRL YNAM@0': ['pick up sound', 'done', 'inventory itemSound'],
  'SCRL ZNAM@0': ['put down sound', 'done', 'inventory itemSound'],
  'SLGM YNAM@0': ['pick up sound', 'done', 'inventory itemSound'],
  'SLGM ZNAM@0': ['put down sound', 'done', 'inventory itemSound'],
  'WEAP YNAM@0': ['pick up sound', 'done', 'inventory itemSound'],
  'WEAP ZNAM@0': ['put down sound', 'done', 'inventory itemSound'],
  'WEAP SNAM@0': ['attack sound', 'done', 'actor-combat'],
  'WEAP XNAM@0': ['attack sound 2D (crossbows)', 'done', "actor-combat: the player's shot"],
  'WEAP NAM7@0': ['attack loop', 'open', 'read (combat-records), never played'],
  'WEAP TNAM@0': ['swing sound ("Attack Fail" in xEdit)', 'done', 'actor-combat swing'],
  'WEAP UNAM@0': [
    "idle sound (bound weapons' loop)",
    'done',
    'weapon-idle-sounds.ts: loops while drawn',
  ],
  'WEAP NAM9@0': ['equip sound', 'done', 'actor-combat draw, inventory equip'],
  'WEAP NAM8@0': ['unequip sound', 'done', 'actor-combat sheathe, inventory unequip'],
  'WEAP INAM@0': ['impact data set', 'done', 'combat-impacts'],
  'WEAP BIDS@0': ['block bash impact data set', 'done', 'actor-combat bash'],
  'ARMO BIDS@0': ['block bash impact data set (shields)', 'done', 'actor-combat bash'],
  'ARMA SNDD@0': ['footstep set', 'done', 'actor-sounds footsteps'],
  'RACE NAM5@0': ['unarmed impact data set', 'done', 'actor-combat'],
  'RACE ONAM@0': ['open corpse (loot) sound', 'done', 'actors.ts corpse search'],
  'RACE LNAM@0': ['close corpse (loot) sound', 'done', 'actors.ts corpse search'],
  'NPC_ CSDI@0': ['creature sound', 'done', 'actor-records; see "Creature sounds"'],
  'MGEF SNDD@4': ['sound (first entry)', 'done', 'see "Magic effect sounds"'],
  'MGEF SNDD@12': ['sound (second entry)', 'done', 'see "Magic effect sounds"'],
  'MGEF SNDD@20': ['sound (third entry)', 'done', 'see "Magic effect sounds"'],
  'MGEF SNDD@28': ['sound (fourth entry)', 'done', 'see "Magic effect sounds"'],
  'MGEF SNDD@36': ['sound (fifth entry)', 'done', 'see "Magic effect sounds"'],
  'MGEF SNDD@44': ['sound (sixth entry)', 'done', 'see "Magic effect sounds"'],
  'MGEF DATA@100': ['impact data set', 'done', 'magic-projectiles impacts'],
  'EXPL DATA@4': ['sound 1', 'done', 'magic-projectiles explosion'],
  'EXPL DATA@8': ['sound 2', 'done', 'magic-projectiles explosion'],
  'EXPL DATA@12': ['impact data set', 'done', 'magic-projectiles explosion'],
  'EXPL DATA@16': [
    'placed object (a sound marker)',
    'open',
    'sound markers placed at run time do not play (emitters come from cell loads only)',
  ],
  'EXPL DATA@28': ["an older layout's float matching a form id", 'n/a', 'not a form'],
  'MGEF DATA@0': ['flags matching a form id', 'n/a', 'not a form'],
  'HAZD DATA@36': ['sound', 'done', 'magic-fx hazards'],
  'PROJ DATA@40': ['sound (flight loop)', 'done', 'magic-projectiles'],
  'PROJ DATA@56': ['countdown sound', 'open', 'read (projectile-data), never played'],
  'PROJ DATA@60': ['disable sound', 'open', 'read (projectile-data), never played'],
  'EFSH DATA@308': ['ambient sound', 'done', 'actor-effects: at the body while it shows'],
  'BPTD BPND@68': ['impact data set (dismember)', 'done', 'body-part-data'],
  'BPTD BPND@72': ['impact data set (explode)', 'done', 'body-part-data'],
  'MATT HNAM@0': ['impact data set', 'done', 'impacts.ts'],
  'IPDS PNAM@4': ['impact per material', 'done', 'impacts.ts'],
  'IPCT SNAM@0': ['sound', 'done', 'impacts.ts'],
  'IPCT NAM1@0': ['heavy sound', 'done', 'impacts.ts'],
  'FSTP DATA@0': ['impact data set', 'done', 'actor-sounds footsteps'],
  'FSTS DATA@0': ['footsteps', 'done', 'footstep-records'],
  'WATR SNAM@0': ['open sound', 'done', 'water-audio'],
  'WTHR SNAM@0': ['weather sound', 'done', 'ambience (see "Weather sounds")'],
  'REGN RDSA@0': ['region sound', 'done', 'ambience'],
  'REGN RDMO@0': ['region music', 'done', 'music (location music)'],
  'ASPC SNAM@0': ['ambience loop', 'done', 'sound-system acoustic spaces'],
  'ASPC BNAM@0': ['reverb', 'done', 'reverb.ts'],
  'CELL XCAS@0': ['acoustic space', 'done', 'sound-system acoustic spaces'],
  'CELL XCMO@0': ['music', 'done', 'music (location music)'],
  'WRLD ZNAM@0': ['music', 'done', 'music (location music)'],
  'LCTN NAM1@0': ['music', 'done', "sound-system: the location's music, after the cell's"],
  'INFO TRDT@16': [
    'response sound',
    'done',
    'world-lines, dialogue-menu: lines without a voice file',
  ],
  'INFO ONAM@0': ['audio output override', 'done', 'sound-system voiceLine'],
  'SNDR GNAM@0': ['category', 'done', 'sound-instance'],
  'SNDR ONAM@0': ['output model', 'done', 'sound-instance'],
  'SNDR SNAM@0': ['alternate sound for', 'done', 'see SNDR SNAM'],
  'SNCT PNAM@0': ['parent category', 'done', 'audio-engine category tree'],
  'MUSC TNAM@0': ['tracks', 'done', 'music.ts'],
  'MUST SNAM@0': ['palette tracks', 'done', 'music.ts'],
};
/**
 * 4-byte fields that are not form ids (string table ids, texts, numbers), except where a record
 * type uses the signature for a form (FORM_FIELDS).
 */
const NOT_FORMS = new Set([
  'FULL',
  'DESC',
  'EDID',
  'ITXT',
  'RNAM',
  'CNAM',
  'NAM1',
  'NAM2',
  'DATA',
  'DNAM',
  'NNAM',
]);
const FORM_FIELDS = new Set(['LCTN NAM1', 'IPCT NAM1', 'FSTP DATA']);
/** Longer subrecords holding sound forms among other values (scanned at every 4 bytes). */
const STRUCTS = new Set([
  'ALCH ENIT',
  'MGEF DATA',
  'MGEF SNDD',
  'EXPL DATA',
  'HAZD DATA',
  'PROJ DATA',
  'EFSH DATA',
  'BPTD BPND',
  'INFO TRDT',
  'REGN RDSA',
  'WTHR SNAM',
  'MUSC TNAM',
  'MUST SNAM',
  'IPDS PNAM',
  'FSTS DATA',
  'NPC_ CSDI',
]);
/** Subrecords that are lists or structs of entries: their offsets fold to one key. */
const FOLDED: Record<string, (offset: number) => number> = {
  'MUSC TNAM': () => 0,
  'MUST SNAM': () => 0,
  'FSTS DATA': () => 0,
  'REGN RDSA': (offset) => offset % 12,
  'IPDS PNAM': (offset) => offset % 8,
  'WTHR SNAM': (offset) => offset % 8,
};
/** Record types not swept for sound fields (placed references and world data). */
const SKIP_TYPES = new Set([
  'REFR',
  'ACHR',
  'PGRE',
  'PHZD',
  'NAVM',
  'LAND',
  'NAVI',
  'PARW',
  'PBAR',
  'PBEA',
  'PCON',
  'PFLA',
  'PMIS',
  'TES4',
]);
const AUDIO_TYPES = new Set([
  'SNDR',
  'SOUN',
  'SOPM',
  'SNCT',
  'ASPC',
  'REVB',
  'MUSC',
  'MUST',
  'IPCT',
  'IPDS',
  'FSTP',
  'FSTS',
]);

/** SNDR CNAM: the descriptor type (a name hash, xEdit). */
const DESCRIPTOR_TYPES: Record<number, readonly [string, Status, string]> = {
  0x1eef540a: ['Standard', 'done', 'one file at random, sound-instance'],
  0x54651a43: ['Compound', 'open', 'not played as compound'],
  0xed157ae3: ['AutoWeapon', 'n/a', "Fallout's automatic weapons: unused by Skyrim's data"],
};
/** WTHR SNAM sound types. */
const WEATHER_SOUND_TYPES: Record<number, readonly [string, Status, string]> = {
  0: ['Default', 'done', "ambience: looping at the weather's share, single at random"],
  1: ['Precipitation', 'done', "ambience: looping at the weather's share"],
  2: ['Wind', 'done', "ambience: looping at the weather's share"],
  3: ['Thunder', 'done', 'ambience: after each lightning flash'],
};
/**
 * NPC_ CSDT creature sound types: Skyrim's list starts at Idle (its creatures' feet are
 * footstep sets); the data agrees (MudcrabIdle 0, movement loops 6, conscious and breathing
 * loops 7).
 */
const CREATURE_SOUND_TYPES = [
  'Idle',
  'Aware',
  'Attack',
  'Hit',
  'Death',
  'Weapon',
  'Movement Loop',
  'Conscious Loop',
  'Auxiliary 1',
  'Auxiliary 2',
  'Auxiliary 3',
  'Auxiliary 4',
  'Auxiliary 5',
  'Auxiliary 6',
  'Auxiliary 7',
  'Auxiliary 8',
  'Jump',
  'PlayRandom/Loop',
];
/** MGEF SNDD types (magic-effects.ts EffectSound). */
const EFFECT_SOUND_TYPES: Record<number, readonly [string, Status, string]> = {
  0: ['Sheathe/Draw', 'done', 'actor-combat: as the hands are drawn and put away'],
  1: ['Charge', 'done', 'actor-casting'],
  2: ['Ready', 'done', 'actor-casting'],
  3: ['Release', 'done', 'actor-casting'],
  4: ['Concentration Cast Loop', 'done', 'actor-casting'],
  5: ['On Hit', 'done', 'magic-engine'],
};
/** MUST CNAM track types. */
const TRACK_TYPES: Record<number, readonly [string, Status, string]> = {
  0x23f678c3: ['Palette', 'done', 'music.ts layers'],
  0x6ed7e048: ['Single Track', 'done', 'music.ts'],
  0xa1a9c4d5: ['Silent Track', 'done', 'music.ts pauses'],
};
/** MUSC FNAM flags by bit. */
const MUSIC_FLAGS: Record<number, readonly [string, Status, string]> = {
  0: ['Plays One Selection', 'done', 'music.ts'],
  1: ['Abrupt Transition', 'done', 'music.ts'],
  2: ['Cycle Tracks', 'done', 'music.ts'],
  3: ['Maintain Track Order', 'done', 'music.ts'],
  5: ['Ducks Current Track', 'done', 'music.ts'],
  6: ["Doesn't Queue", 'done', 'music.ts'],
};
/** SNCT FNAM flags by bit. */
const CATEGORY_FLAGS: Record<number, readonly [string, Status, string]> = {
  0: ['Mute When Submerged', 'done', 'sound-system under water'],
  1: ['Should Appear on Menu', 'done', 'journal Audio settings sliders'],
};
/** REGN RDSA flags by bit. */
const REGION_SOUND_FLAGS: Record<number, readonly [string, Status, string]> = {
  0: ['Pleasant', 'done', 'ambience'],
  1: ['Cloudy', 'done', 'ambience'],
  2: ['Rainy', 'done', 'ambience'],
  3: ['Snowy', 'done', 'ambience'],
};

/** The engine's [Audio] INI settings (and the AudioMenu master volume) rated by hand. */
const INI_SETTINGS: Record<string, Rating | undefined> = {
  'fDialogueHeadPitchExaggeration:Audio': undefined,
  'fDialogueHeadRollExaggeration:Audio': undefined,
  'fDialogueHeadYawExaggeration:Audio': undefined,
  'fMusicDuckingSeconds:Audio': undefined,
  'fMusicUnDuckingSeconds:Audio': undefined,
  'fMusicFinaleCrossFadeTimeIn:Audio': undefined,
  'fMusicFinaleCrossFadeTimeOut:Audio': undefined,
  'fMinSoundVel:Audio': undefined,
  'fWaterAudioFadeInSeconds:Audio': undefined,
  'fWaterAudioFadeOutSeconds:Audio': undefined,
  'uWaterAudioSamplePointsToUse:Audio': undefined,
  'uWaterAudioAxisSamplePoints:Audio': undefined,
  'uWaterAudioAmbientAttenuation:Audio': undefined,
  'fAudioRumbleSmallExponent:Audio': ['open', 'sound-driven rumble (SNDR rumble send) not built'],
  'fAudioRumbleBigExponent:Audio': ['open', 'sound-driven rumble not built'],
  'fAudioRumbleSmallLerpMin:Audio': ['open', 'sound-driven rumble not built'],
  'fAudioRumbleSmallLerpMax:Audio': ['open', 'sound-driven rumble not built'],
  'fAudioRumbleSmallDeadZone:Audio': ['open', 'sound-driven rumble not built'],
  'fAudioRumbleBigLerpMin:Audio': ['open', 'sound-driven rumble not built'],
  'fAudioRumbleBigLerpMax:Audio': ['open', 'sound-driven rumble not built'],
  'fAudioRumbleBigDeadZone:Audio': ['open', 'sound-driven rumble not built'],
  'fAudioRumblePowerAttackAdj:Audio': ['open', 'sound-driven rumble not built'],
  'fRegionRandomSoundPlacementBase:Audio': undefined,
  'fRegionSoundPlacementRandomOffset:Audio': undefined,
  'fRegionSoundPlacementZOffset:Audio': undefined,
  'uRegionSoundsAllowedPerUpdate:Audio': undefined,
  'fASFadeInTime:Audio': undefined,
  'fASFadeOutTime:Audio': undefined,
  'fRegionLoopFadeInTime:Audio': undefined,
  'fRegionLoopFadeOutTime:Audio': undefined,
  'fReverbTransitionTime:Audio': undefined,
  'fMenuModeFadeOutTime:Audio': undefined,
  'fMenuModeFadeInTime:Audio': undefined,
  'fNonHighlightSpeechAtten:Audio': undefined,
  'iHighlightSpeechOverlap:Audio': ['n/a', 'not read by the engine (fHighlightSpeechOverlap is)'],
  'fMaxHighlightRadius:Audio': undefined,
  'fHighlightSpeechOverlap:Audio': undefined,
  'uAudioThreadSleepTimeMenuMode:Audio': ['n/a', "the audio thread's pace: Web Audio runs its own"],
  'uAudioThreadSleepTimeGameMode:Audio': ['n/a', "the audio thread's pace: Web Audio runs its own"],
  'fAudioMasterVolume:AudioMenu': undefined,
  'iCollisionSoundTimeDelta:Audio': undefined,
  'fCollisionSoundHeavyThreshold:Audio': undefined,
  'sAudioAPI:Audio': ['n/a', 'XAudio2: the browser has Web Audio'],
  'bEnableAudio:Audio': undefined,
  'bEnableAudioCache:Audio': ['n/a', 'the decoded-buffer cache is ours (256 MB, sound-system)'],
  'uMaxSizeForCachedSound:Audio': [
    'n/a',
    'the decoded-buffer cache is ours (256 MB, sound-system)',
  ],
  'fDefaultMasterVolume:Audio': undefined,
  'sMissingAssetSoundFile:Audio': ['n/a', 'empty: a missing file plays nothing (as ours)'],
  'uStreamingThreshold:Audio': [
    'open',
    'music always streams and effects load whole: not checked against the files sizes',
  ],
  'uAsyncReadPriorityThreshold:Audio': ['n/a', "file read priority of the original's streamer"],
  'fHardLandingDamageThreshold:Audio': undefined,
  'sDeathCameraEffect:Audio': undefined,
  'fNonDialogVoiceDucking:Audio': undefined,
  'fNonDialogVoiceDuckingFadeOut:Audio': undefined,
  'fNonDialogVoiceDuckingFadeIn:Audio': undefined,
  'bShowMissingAudioWarnings:MESSAGES': ['done', 'missing files are logged once (sound-system)'],
};
/** Game settings of audio (by the original's names), rated by hand where not simply named. */
const GAME_SETTINGS: Record<string, Rating | undefined> = {
  fCombatMusicUpdateTime: undefined,
  fCombatMusicStopTime: undefined,
  fCombatMusicNearCombatInnerRadius: undefined,
  fCombatMusicNearCombatOuterRadius: undefined,
  fCombatMusicPlayerTargetedThreatRatio: undefined,
  fCombatMusicGroupThreatRatioTimer: undefined,
  fCombatMusicGroupThreatRatioMin: undefined,
  fCombatMusicGroupThreatRatioMax: undefined,
  fCombatMusicPlayerNearStrengthMult: undefined,
  fCombatMusicPlayerCombatStrengthCap: ['n/a', 'the original never reads it'],
  fSplashSoundHeavy: undefined,
  fSplashSoundMedium: undefined,
  fSplashSoundLight: undefined,
  fSplashSoundTimer: undefined,
  fSplashSoundVelocityMult: undefined,
  fSplashSoundOutMult: undefined,
  fDeathSoundMaxDistance: undefined,
  fGameplayVoiceFilePadding: undefined,
  fAIDefaultSpeechMult: undefined,
  fDialogSpeechDelaySeconds: undefined,
  fSubtitleSpeechDelay: undefined,
  fSpeechDelay: undefined,
  fLowPerfCombatantVoiceDistance: undefined,
  fActorAlertSoundTimer: undefined,
  bEnableLipLookup: ['n/a', 'lip files are always read when present'],
  iLipMorphCount: undefined,
};
/** Papyrus natives of the audio scripts (vanilla and SKSE), by our registration names. */
const NATIVES = [
  'sound.play',
  'sound.playandwait',
  'sound.stopinstance',
  'sound.setinstancevolume',
  'sound.getdescriptor',
  'sounddescriptor.getdecibelattenuation',
  'sounddescriptor.setdecibelattenuation',
  'sounddescriptor.getdecibelvariance',
  'sounddescriptor.setdecibelvariance',
  'sounddescriptor.getfrequencyvariance',
  'sounddescriptor.setfrequencyvariance',
  'sounddescriptor.getfrequencyshift',
  'sounddescriptor.setfrequencyshift',
  'soundcategory.pause',
  'soundcategory.unpause',
  'soundcategory.mute',
  'soundcategory.unmute',
  'soundcategory.setvolume',
  'soundcategory.setfrequency',
  'musictype.add',
  'musictype.remove',
];
/** Default objects naming audio forms, rated by hand where our code does not use the code. */
const DEFAULT_NOTES: Record<string, Rating> = {
  RVBT: ['done', 'DefaultReverb is silent (-100 dB): as no reverb'],
  SSSC: ['n/a', 'names the _NONE music type'],
  SCMS: [
    'open',
    "when the original plays the success music is not known (vanilla: LUMS's MUSSpecialSuccess)",
  ],
  ...Object.fromEntries(
    ['PUSA', 'PUSB', 'PUSG', 'PUSI', 'PUSW', 'PDSA', 'PDSB', 'PDSG', 'PDSI', 'PDSW'].map((use) => [
      use,
      ['done', "inventory itemSound: the default by the item's kind"] as const,
    ]),
  ),
};
/** SKSE's natives: no script of the game calls them. */
const SKSE_NATIVES = new Set([
  'sound.getdescriptor',
  'sounddescriptor.getdecibelattenuation',
  'sounddescriptor.setdecibelattenuation',
  'sounddescriptor.getdecibelvariance',
  'sounddescriptor.setdecibelvariance',
  'sounddescriptor.getfrequencyvariance',
  'sounddescriptor.setfrequencyvariance',
  'sounddescriptor.getfrequencyshift',
  'sounddescriptor.setfrequencyshift',
]);

// --- The sweep -------------------------------------------------------------------------------

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const count = (map: Map<string, number>, key: string, n = 1): void => {
  map.set(key, (map.get(key) ?? 0) + n);
};
const fourCC = (n: number): string =>
  String.fromCharCode(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
const typeCache = new Map<number, string>();
const typeOf = (formId: number): string => {
  let type = typeCache.get(formId);
  if (type === undefined) {
    const location = db.locate(formId);
    type = location ? db.typeAt(location) : '';
    typeCache.set(formId, type);
  }
  return type;
};
const viewOf = (data: Uint8Array): DataView =>
  new DataView(data.buffer, data.byteOffset, data.byteLength);

const types = new Set<string>();
for (const plugin of db.plugins)
  for (let record = 0; record < plugin.index.recordCount; record++)
    types.add(fourCC(plugin.index.types[record] ?? 0));

const subrecords = new Map<string, number>();
const recordCounts = new Map<string, number>();
const soundFields = new Map<string, number>();
const descriptorTypes = new Map<string, number>();
const looping = new Map<string, number>();
const rumble = new Map<string, number>();
const outputTypes = new Map<string, number>();
const outputFlags = new Map<string, number>();
const channels = new Map<string, number>();
const categoryFlags = new Map<string, number>();
const musicFlags = new Map<string, number>();
const trackTypes = new Map<string, number>();
const trackFeatures = new Map<string, number>();
const regionFlags = new Map<string, number>();
const weatherTypes = new Map<string, number>();
const creatureTypes = new Map<string, number>();
const effectTypes = new Map<string, number>();
const descriptorFiles: string[] = [];
const trackFiles: string[] = [];
const compound: string[] = [];

const visit = (record: GameRecord): void => {
  const type = record.type;
  if (AUDIO_RECORDS[type]) {
    count(recordCounts, type);
    const seen = new Set<string>();
    for (const field of record.fields.list) {
      if (seen.has(field.type)) continue;
      seen.add(field.type);
      count(subrecords, `${type} ${field.type}`);
    }
  }
  // Sound fields: form ids of audio records anywhere in a field.
  for (const field of record.fields.list) {
    const length = field.data.byteLength;
    if (length < 4 || length > 4096) continue;
    const key = `${type} ${field.type}`;
    if (length === 4 ? NOT_FORMS.has(field.type) && !FORM_FIELDS.has(key) : !STRUCTS.has(key))
      continue;
    const found = new Set<string>();
    for (let offset = 0; offset + 4 <= length; offset += 4) {
      const raw = viewOf(field.data).getUint32(offset, true);
      if (raw === 0 || raw === 0xffffffff) continue;
      if (!AUDIO_TYPES.has(typeOf(record.formIdAt(field.data, offset)))) continue;
      const fold = FOLDED[`${type} ${field.type}`];
      found.add(`${type} ${field.type}@${String(fold ? fold(offset) : offset)}`);
    }
    for (const key of found) count(soundFields, key);
  }
  const u32 = (sig: string): number | undefined => {
    const data = record.fields.first(sig);
    return data && data.byteLength >= 4 ? viewOf(data).getUint32(0, true) : undefined;
  };
  const bits = (map: Map<string, number>, flags: number): void => {
    for (let bit = 0; bit < 32; bit++) if ((flags >>> bit) & 1) count(map, String(bit));
  };
  switch (type) {
    case 'SNDR': {
      const cnam = u32('CNAM');
      count(descriptorTypes, String(cnam ?? 0x1eef540a));
      if (cnam === 0x54651a43) compound.push(record.editorId ?? '');
      const lnam = record.fields.first('LNAM');
      count(looping, String(lnam?.[1] ?? (((u32('FNAM') ?? 0) & 0x10) !== 0 ? 8 : 0)));
      if ((lnam?.[3] ?? 0) !== 0) count(rumble, 'rumble send > 0');
      for (const data of record.fields.all('ANAM')) {
        const name = record.textAt(data);
        if (name) descriptorFiles.push(soundFilePath(name, 'sound'));
      }
      break;
    }
    case 'SOPM': {
      count(outputTypes, String(u32('MNAM') ?? 0));
      const nam1 = record.fields.first('NAM1');
      bits(outputFlags, nam1?.[0] ?? 0);
      const onam = record.fields.first('ONAM');
      if (onam && (u32('MNAM') ?? 0) === 1) {
        const names = ['FL', 'FR', 'C', 'LFE', 'RL', 'RR', 'SL', 'SR'];
        const used = new Set<string>();
        for (let input = 0; input < 3; input++)
          for (let out = 0; out < 8; out++)
            if ((onam[input * 8 + out] ?? 0) !== 0) used.add(names[out] ?? '');
        for (const name of used) count(channels, name);
      }
      break;
    }
    case 'SNCT':
      bits(categoryFlags, u32('FNAM') ?? 0);
      break;
    case 'MUSC':
      bits(musicFlags, u32('FNAM') ?? 0);
      break;
    case 'MUST': {
      count(trackTypes, String(u32('CNAM') ?? 0));
      if (record.fields.has('FNAM')) count(trackFeatures, 'cue points (FNAM)');
      if (record.fields.has('LNAM')) count(trackFeatures, 'loop data (LNAM)');
      if (record.fields.has('BNAM')) count(trackFeatures, 'finale (BNAM)');
      if (record.fields.has('CTDA')) count(trackFeatures, 'conditions (CTDA)');
      if (record.fields.has('DNAM')) count(trackFeatures, 'fade-out (DNAM)');
      if (record.fields.has('FLTV')) count(trackFeatures, 'duration (FLTV)');
      for (const sig of ['ANAM', 'BNAM']) {
        const data = record.fields.first(sig);
        const name = data && record.textAt(data);
        if (name) trackFiles.push(soundFilePath(name, 'music'));
      }
      break;
    }
    case 'REGN':
      for (const data of record.fields.all('RDSA'))
        for (let offset = 0; offset + 12 <= data.byteLength; offset += 12)
          bits(regionFlags, viewOf(data).getUint32(offset + 4, true));
      break;
    case 'WTHR':
      for (const data of record.fields.all('SNAM'))
        if (data.byteLength >= 8) count(weatherTypes, String(viewOf(data).getUint32(4, true)));
      break;
    case 'NPC_':
      for (const data of record.fields.all('CSDT'))
        if (data.byteLength >= 4) count(creatureTypes, String(viewOf(data).getUint32(0, true)));
      break;
    case 'MGEF':
      for (const data of record.fields.all('SNDD'))
        for (let offset = 0; offset + 8 <= data.byteLength; offset += 8)
          count(effectTypes, String(viewOf(data).getUint32(offset, true)));
      break;
  }
};
await db.scan(
  [...types].filter((type) => !SKIP_TYPES.has(type)),
  () => true,
  visit,
);

// Condition functions of descriptors and tracks.
const library = new ScriptLibrary(async (name) => {
  const path = `scripts\\${name}.pex`;
  return vfs.has(path) ? vfs.read(path) : undefined;
});
const runtime = new ScriptRuntime(db, library, { warn: () => undefined });
const audit = await conditionAudit(db, runtime);
const unvalued = new Map(audit.unvalued.map((finding) => [finding.usage.function, finding.why]));

// Default objects that name audio forms.
const defaults = await DefaultObjects.read(db);
const useKeys = new Map<string, string>();
for (const match of sourceOf('world/default-objects.ts').matchAll(/(\w+): '(\w{4})'/g))
  useKeys.set(match[2] ?? '', match[1] ?? '');

// Sound files.
const files = { fx: 0, voice: 0, music: 0, other: 0 };
const extensions = new Map<string, number>();
const voiceTypes = new Set<string>();
for (const path of [...vfs.list('sound'), ...vfs.list('music')]) {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  count(extensions, ext);
  if (path.startsWith('sound\\fx\\')) files.fx++;
  else if (path.startsWith('sound\\voice\\')) {
    files.voice++;
    const parts = path.split('\\');
    if (parts.length > 4) voiceTypes.add(`${parts[2] ?? ''}\\${parts[3] ?? ''}`);
  } else if (path.startsWith('music\\')) files.music++;
  else files.other++;
}
const missing = (list: readonly string[]): string[] =>
  [...new Set(list)].filter((path) => !soundFileCandidates(path).some((name) => vfs.has(name)));

// --- Report ----------------------------------------------------------------------------------

interface Row {
  readonly section: string;
  readonly name: string;
  readonly uses: number;
  readonly status: Status;
  readonly note: string;
}
const rows: Row[] = [];
const add = (section: string, name: string, uses: number, entry?: Rating): void => {
  rows.push({ section, name, uses, status: entry?.[0] ?? 'open', note: entry?.[1] ?? 'unrated' });
};
const tableRows = (
  section: string,
  map: Map<string, number>,
  table: Record<number, readonly [string, Status, string]>,
  label: (key: number) => string = (key) => `0x${key.toString(16)}`,
): void => {
  for (const [key, n] of [...map].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const entry = table[Number(key)];
    add(section, `${label(Number(key))} ${entry?.[0] ?? '?'}`, n, entry && [entry[1], entry[2]]);
  }
};

const readBy = (type: string, signature: string): boolean =>
  (AUDIO_RECORDS[type] ?? []).some((path) => sourceOf(path).includes(`'${signature}'`));
for (const [key, n] of [...subrecords].sort()) {
  const [type, signature] = key.split(' ') as [string, string];
  if (RECORD_COMMON.has(signature)) continue;
  add(
    `Records: ${type} (${String(recordCounts.get(type) ?? 0)})`,
    signature,
    n,
    SUBRECORD_NOTES[key] ??
      (signature === 'CTDA' || signature === 'CIS1' || signature === 'CIS2'
        ? ['done', 'conditions: see "Condition functions"']
        : readBy(type, signature)
          ? ['done', 'read']
          : ['open', 'not read']),
  );
}
for (const [key, n] of [...soundFields].sort()) {
  const entry = SOUND_FIELDS[key];
  add(
    'Sound fields of records',
    `${key} ${entry?.[0] ?? ''}`.trim(),
    n,
    entry && [entry[1], entry[2]],
  );
}
tableRows('Descriptor types (SNDR CNAM)', descriptorTypes, DESCRIPTOR_TYPES);
tableRows(
  'Descriptor values (SNDR LNAM, BNAM)',
  looping,
  {
    0: ['looping: none', 'done', 'sound-instance'],
    8: ['looping: Loop', 'done', 'sound-instance: the smpl region, else the whole file'],
    16: ['looping: Envelope Fast', 'done', 'sound-instance: attack, loop, release at once'],
    32: ['looping: Envelope Slow', 'done', 'sound-instance: release after the pass'],
  },
  (key) => String(key),
);
for (const [key, n] of rumble)
  add('Descriptor values (SNDR LNAM, BNAM)', key, n, [
    'open',
    'sound-driven gamepad rumble not built',
  ]);
tableRows(
  'Output models (SOPM)',
  outputTypes,
  {
    0: ['Uses HRTF', 'done', 'sound-instance: HRTF panner'],
    1: ['Defined Speaker Output', 'done', 'sound-instance: fixed speaker levels'],
  },
  (key) => String(key),
);
tableRows(
  'Output models (SOPM)',
  outputFlags,
  {
    0: ['flag Attenuates With Distance', 'done', 'attenuation.ts curve'],
    1: ['flag Allows Rumble', 'open', 'sound-driven gamepad rumble not built'],
  },
  (key) => `bit ${String(key)}`,
);
for (const [name, n] of [...channels].sort())
  add(
    'Output models (SOPM)',
    `speaker output to ${name}`,
    n,
    ['FL', 'FR', 'C'].includes(name)
      ? ['done', 'sound-instance: left, right, centre at -3 dB to both']
      : name === 'LFE'
        ? ['open', 'no subwoofer channel: the browser output is stereo (surround output not built)']
        : ['open', 'rear and side speakers fold to their side: surround output not built'],
  );
tableRows('Categories (SNCT FNAM)', categoryFlags, CATEGORY_FLAGS, (key) => `bit ${String(key)}`);
tableRows('Music types (MUSC FNAM)', musicFlags, MUSIC_FLAGS, (key) => `bit ${String(key)}`);
tableRows('Music tracks (MUST CNAM)', trackTypes, TRACK_TYPES);
for (const [name, n] of [...trackFeatures].sort())
  add('Music tracks (MUST CNAM)', name, n, ['done', 'music.ts']);
tableRows(
  'Region sounds (REGN RDSA flags)',
  regionFlags,
  REGION_SOUND_FLAGS,
  (key) => `bit ${String(key)}`,
);
tableRows('Weather sounds (WTHR SNAM)', weatherTypes, WEATHER_SOUND_TYPES, (key) => String(key));
for (const [key, n] of [...creatureTypes].sort((a, b) => Number(a[0]) - Number(b[0])))
  add(
    'Creature sounds (NPC_ CSDT)',
    `${key} ${CREATURE_SOUND_TYPES[Number(key)] ?? '?'}`,
    n,
    key === '6' || key === '7'
      ? ['done', 'creature-sounds.ts: loops while conscious (and moving)']
      : key === '0'
        ? ['done', 'creature-sounds.ts: with an ambient idle, at its chance']
        : ['open', 'one-shot creature sounds: when the original plays them is not known'],
  );
tableRows('Magic effect sounds (MGEF SNDD)', effectTypes, EFFECT_SOUND_TYPES, (key) => String(key));
for (const usage of [...audit.usage.values()].sort((a, b) => b.sound - a.sound)) {
  const descriptors = usage.records.get('SNDR') ?? 0;
  const tracks = usage.records.get('MUST') ?? 0;
  if (descriptors + tracks === 0) continue;
  const why = unvalued.get(usage.function);
  add(
    'Condition functions (SNDR, MUST)',
    `${conditionFunctionName(usage.function)} (${String(descriptors)} descriptors, ${String(tracks)} tracks)`,
    descriptors + tracks,
    why === undefined
      ? ['done', "valued (sound-conditions or the game's evaluator)"]
      : ['open', `not valued: ${why}`],
  );
}
for (const [use, formId] of [...defaults.entries()].sort()) {
  const type = typeOf(formId);
  if (!AUDIO_TYPES.has(type)) continue;
  const key = useKeys.get(use);
  const used =
    key !== undefined &&
    [...sources].some(
      ([path, text]) =>
        path !== 'world/default-objects.ts' && text.includes(`DefaultObjectUse.${key}`),
    );
  const literal = [...sources].some(
    ([path, text]) => path !== 'world/default-objects.ts' && text.includes(`'${use}'`),
  );
  const editorId = (await db.get(formId))?.editorId ?? '';
  add(
    'Default objects (DOBJ) naming audio forms',
    `${use} ${type} ${editorId}`,
    1,
    DEFAULT_NOTES[use] ??
      (used || literal ? ['done', key ?? 'named in code'] : ['open', 'not used']),
  );
}
for (const [name, rating] of Object.entries(INI_SETTINGS)) {
  const bare = name.slice(0, name.indexOf(':'));
  add(
    '[Audio] INI settings',
    name,
    1,
    rating ?? (allSource.includes(`'${bare}'`) ? ['done', 'read'] : ['open', 'not read']),
  );
}
for (const [name, rating] of Object.entries(GAME_SETTINGS))
  add(
    'Audio game settings',
    name,
    1,
    rating ?? (allSource.includes(name) ? ['done', 'read'] : ['open', 'not read']),
  );
for (const name of NATIVES) {
  const [script = '', action = ''] = name.split('.');
  // SoundCategory's four state natives are registered in a loop over their names.
  const registered =
    allSource.includes(`'${name}'`) ||
    (allSource.includes(`\`${script}.\${action}\``) && allSource.includes(`'${action}'`));
  add(
    'Papyrus audio natives',
    name,
    1,
    registered
      ? ['done', 'natives/forms.ts']
      : SKSE_NATIVES.has(name)
        ? ['n/a', 'SKSE: no script of the game calls it']
        : ['open', 'not registered'],
  );
}
const missingDescriptorFiles = missing(descriptorFiles);
const missingTrackFiles = missing(trackFiles);
add(
  'Sound files',
  `descriptor files (${String(new Set(descriptorFiles).size)})`,
  descriptorFiles.length,
  missingDescriptorFiles.length === 0
    ? ['done', 'every file found']
    : [
        'done',
        `${String(missingDescriptorFiles.length)} missing in the data (silent, as the original): ${missingDescriptorFiles.slice(0, 3).join(', ')}`,
      ],
);
add(
  'Sound files',
  `music track files (${String(new Set(trackFiles).size)})`,
  trackFiles.length,
  missingTrackFiles.length === 0
    ? ['done', 'every file found']
    : [
        'done',
        `${String(missingTrackFiles.length)} missing in the data: ${missingTrackFiles.slice(0, 3).join(', ')}`,
      ],
);
add(
  'Sound files',
  `voice files in ${String(voiceTypes.size)} plugin and voice type folders`,
  files.voice,
  ['done', 'fuz/xwm/wav and lip (formats/audio)'],
);
for (const [ext, n] of [...extensions].sort())
  add(
    'Sound files',
    `.${ext}`,
    n,
    ['wav', 'xwm', 'fuz', 'lip'].includes(ext)
      ? ['done', 'formats/audio']
      : ['n/a', 'not a sound file'],
  );

// --- Print -----------------------------------------------------------------------------------

const used = rows.filter((row) => row.status !== 'n/a');
const done = used.filter((row) => row.status === 'done').length;
console.log(
  `${String(rows.length)} items: ${String(done)} done, ${String(used.length - done)} open,` +
    ` ${String(rows.length - used.length)} n/a; compound descriptors: ${compound.slice(0, 8).join(', ') || 'none'}`,
);
const sections = new Map<string, { items: number; done: number; open: number; na: number }>();
for (const row of rows) {
  const name = row.section.startsWith('Records:') ? "Audio records' subrecords" : row.section;
  const entry = sections.get(name) ?? { items: 0, done: 0, open: 0, na: 0 };
  entry.items++;
  if (row.status === 'done') entry.done++;
  else if (row.status === 'open') entry.open++;
  else entry.na++;
  sections.set(name, entry);
}
if (values.markdown) {
  console.log('\n| Part | Items | Done | Open | n/a |\n| --- | ---: | ---: | ---: | ---: |');
  for (const [name, entry] of sections)
    console.log(
      `| ${name} | ${String(entry.items)} | ${String(entry.done)} | ${String(entry.open)} | ${String(entry.na)} |`,
    );
}
let section = '';
for (const row of rows) {
  if (values.open && row.status !== 'open') continue;
  if (row.section !== section) {
    section = row.section;
    console.log(
      values.markdown
        ? `\n### ${section}\n\n| Item | Uses | Status | Where / why |\n| --- | ---: | --- | --- |`
        : `\n${section}`,
    );
  }
  console.log(
    values.markdown
      ? `| ${row.name.replace(/\|/g, '\\|')} | ${String(row.uses)} | ${row.status} | ${row.note} |`
      : `  ${row.status.padEnd(5)} ${String(row.uses).padStart(7)}  ${row.name}  ${row.note}`,
  );
}
