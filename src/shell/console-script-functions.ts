// How the console runs the game's script functions that src/shell/console-commands.ts has no
// case of: what the game prints for one with a condition function (each function's own line,
// observed in the original: most say "<name> >> <value with two decimals>", some name the value
// otherwise or round it), and the Papyrus native that does what a script function does where
// one does (the same native the scripts call). Platform-independent.

/**
 * The lines of the condition functions whose words differ from "<name> >> %0.2f" (observed in
 * the original). {v} is the value with two decimals, {0} rounded, {i} as an integer, {c} the
 * axis letter.
 */
const CONDITION_LINES: Readonly<Record<string, string>> = {
  GetVelocity: 'GetVelocity >> ({c}) {v}',
  GetRelativeAngle: 'GetRelAng: {c} >> {v}',
  GetStartingPos: 'GetStartingPos: {c} >> {v}',
  GetDisabled: 'GetDisabled >> {0}',
  GetLocked: 'GetLocked >> {0}',
  GetLockLevel: 'GetLockLevel >> {0}',
  GetIsLockBroken: 'GetIsLockBroken >> {0}',
  IsCurrentFurnitureRef: 'IsCurrentFurnitureRef>> {v}',
  IsCurrentFurnitureObj: 'IsCurrentFurnitureObj>> {v}',
  IsPleasant: 'GetIsPleasant >> {v}',
  IsCloudy: 'GetIsCloudy >> {v}',
  IsRaining: 'GetIsRaining >> {v}',
  IsSnowing: 'GetIsSnowing >> {v}',
  GetShouldAttack: 'GetShouldAttack >> {i}',
  GetShouldHelp: 'GetShouldHelp >> {i}',
  IsHostileToActor: 'IsHostileToActor >> {i}',
  GetIsReference: 'GetIsRef >> {v}',
  IsWeaponMagicOut: 'Is Weapon/Magic Out >> {v}',
  IsFacingUp: 'Is Facing Up >> {v}',
  IsLeftUp: 'Is Left Up >> {v}',
  GetKnockedState: 'Get Knocked State >> {v}',
  GetKnockStateEnum: 'Get Knock State (Enum) >> {v}',
  GetAttackState: 'Get Attack State >> {v}',
  GetWeaponAnimType: 'Get Weapon Anim >> {v}',
  IsWeaponSkillType: 'Is Weapon Skill Type >> {v}',
  IsWaiting: 'Is Waiting >> {v}',
  IsIdlePlaying: 'Is Idle Playing >> {v}',
  IsGuard: 'Is Guard >> {v}',
  IsTalking: 'Talking >> {v}',
  IsPCSleeping: 'IsPlayerSleeping >> {v}',
  IsPCAMurderer: 'IsPlayerAMurderer >> {v}',
  IsSwimming: 'Is Swimming >> {v}',
  GetAmountSoldStolen: 'Amount stolen the player sold >> {v}',
  GetDestroyed: 'GetDestroyed >> {0}',
  HasMagicEffect: 'Has Magic Effect >> {v}',
  IsSpellTarget: 'Is Spell Target >> {v}',
  GetVATSMode: 'VATS Mode >> {v}',
  GetVatsTargetHeight: 'VATS Target Height >> {v}',
  GetVampireFeed: 'Player is in Vampire Feed action >> {v}',
  GetCannibal: 'Player is in Cannibal action >> {v}',
  HasBeenEaten: 'Actor has been eaten >> {v}',
  GetIsGhost: 'GetGhost >> {v}',
  IsXBox: 'IsXBox >> {0}',
  IsPS3: 'IsPS3 >> {0}',
  IsWin32: 'IsPC >> {0}',
  GetCauseofDeath: 'Cause of death is >> {v}',
  GetIsObjectType: 'GetIsObjectType is  >> {v}',
  GetDialogueEmotion: 'GetEmotion >> {v}',
  GetDialogueEmotionValue: 'GetEmotionValue >> {v}',
  IsWaterObject: 'IsWaterActivator >> {v}',
  HasPerk: 'Perk Rank >> {i}',
  GetFactionRelation: 'Faction Relation  >> {i}',
  IsLastIdlePlayed: 'The last idle played was  >> {i}',
  GetPlayerTeammate: 'Player teammate  >> {i}',
  GetPlayerTeammateCount: 'Player teammate count  >> {i}',
  IsGreetingPlayer: 'IsGreeting the player >> {v}',
  GetVATSRightAreaFree: 'VATSRightAreaFree >> {v}',
  GetVATSLeftAreaFree: 'VATSLeftAreaFree >> {v}',
  GetVATSBackAreaFree: 'VATSBackAreaFree >> {v}',
  GetVATSFrontAreaFree: 'VATSFrontAreaFree >> {v}',
  GetVATSRightTargetVisible: 'VATSRightTargetVisible >> {v}',
  GetVATSLeftTargetVisible: 'VATSLeftTargetVisible >> {v}',
  GetVATSBackTargetVisible: 'VATSBackTargetVisible >> {v}',
  GetVATSFrontTargetVisible: 'VATSFrontTargetVisible >> {v}',
  HasMagicEffectKeyword: 'HasMagicEffeKeyword >> {v}',
  GetIsEditorLocation: 'GetIsEditorLoc >> {v}',
  GetInCurrentLoc: 'GetInCurrentLocation >> {v}',
  GetIsAliasRef: 'GetIsAlias >> {v}',
  GetInCurrentLocAlias: 'GetInCurrentLocAliasConditionFunction >> {v}',
  GetKeywordDataForAlias: 'GetKeywordDataForLocAlias >> {v}',
  HasEquippedSpell: 'HasEquippedSpell>> {v}',
  IsCurrentSpell: 'IsCurrentSpell>> {v}',
  SpellHasKeyword: 'CurrentSpellHasKeyword >> {v}',
  GetCurrentCastingType: 'GetCurrentCastingType>> {v}',
  IsWardState: 'IsWardState>> {v}',
  IsDualCasting: 'IsDualCasting>> {v}',
  GetCurrentDeliveryType: 'GetCurrentDeliveryType>> {v}',
  GetMovementDirection: 'Movement Direction >> {v}',
  GetInContainer: 'In Container >> {0}',
  IsLocationLoaded: 'Location Loaded >> {0}',
  GetLocationCleared: 'Location Cleared >> {0}',
  CanPayCrimeGold: 'Can Pay Crime Gold >> {v}',
  GetPathingTargetOffset: 'GetPathingOffset: {c} >> {v}',
  GetPathingTargetAngleOffset: 'GetPathingTargetAngleOffset: {c} >> {v}',
  GetPathingTargetSpeedAngle: 'GetPathingTargetSpeedAngle: {c} >> {v}',
  GetPathingCurrentSpeedAngle: 'GetPathingCurrentSpeedAngle: {c} >> {v}',
  GetIsCrimeFaction: 'GetCrimeFaction results is >> {v}',
  IsCasting: 'IsCasting>> {v}',
  IsInFavorState: 'Favor State>> {v}',
  HasTwoHandedWeaponEquipped: 'Has Two-Handed Weapon Equipped >> {v}',
  IsFleeing: 'Is Fleeing >> {v}',
  GetStolenItemValueNoCrime: 'Stolen Item Value no Crime is >> {v}',
  GetStolenItemValue: 'Stolen Item Value Crime is >> {v}',
  IsWeaponOut: 'Is Weapon Out >> {v}',
  IsCloserToAThanB: 'IsCloserToAThanBFunction >> {v}',
  GetAllowWorldInteractions: 'AllowWorldInteractions: >> {v}',
  IsInFriendStatewithPlayer: 'Is in Friend state >> {v}',
  IsBribedbyPlayer: 'IsBribed >> {v}',
  IsIntimidatedbyPlayer: 'Is Intimidated >> {v}',
  IsIgnoringCombat: 'Is Ignoring Combat >> {v}',
  GetLightLevel: 'Get Light Level >> {v}',
  GetRealHoursPassed: 'Get Real Hours Passed >> {v}',
  IsUnlockedDoor: 'IsUnlockedDoor >> {0}',
  GetIsFormType: 'Get Is Form Type >> {v}',
  IsRidingMount: 'Is actor riding mount >> {v}',
  IsBeingRidden: 'Is actor being ridden >> {v}',
  IsPlayersLastRiddenMount: 'Actor players last ridden horse >> {v}',
  IsInDangerousWater: 'Actor is in lava >> {v}',
  IsPlayerMovingIntoNewSpace: 'Player is moving to new area >> {v}',
  GetTimeDead: 'time dead >> {v}',
  IsMoving: 'IsMoving >> {0}',
  IsTurning: 'IsTurning >> {0}',
  GetAnimAction: 'GetAnimAction >> {0}',
};

const AXES = ['X', 'Y', 'Z'];

/** What the game prints for a condition function's value (axis: the axis parameter, 0..2). */
export function conditionLine(name: string, value: number, axis = 0): string {
  const line = CONDITION_LINES[name] ?? `${name} >> {v}`;
  return line
    .replace('{v}', value.toFixed(2))
    .replace('{0}', value.toFixed(0))
    .replace('{i}', String(Math.trunc(value)))
    .replace('{c}', AXES[axis] ?? 'X');
}

/** What a script function passes its native: an argument of the console's, or a fixed value. */
export type NativeArgument =
  /** The parameter as a form (null when left out). */
  | { readonly form: number }
  /** The parameter as a placed reference (null when left out). */
  | { readonly reference: number }
  /** The parameter as a number, else the fallback. */
  | { readonly number: number; readonly fallback?: number }
  /** The parameter as a bool (not 0), else the fallback. */
  | { readonly bool: number; readonly fallback?: boolean }
  /** The parameter as text. */
  | { readonly text: number }
  /** The reference the function acts on. */
  | { readonly self: true }
  | { readonly fixed: boolean | number | null };

/** A script function done by a native. */
export interface NativeFunction {
  /** The native ("actor.startcombat"). */
  readonly native: string;
  /** What the native is called on: the reference (default), a parameter's form, or nothing. */
  readonly on?: 'reference' | 'none' | { readonly form: number };
  readonly args: readonly NativeArgument[];
  /** It prints its result as a condition function's line. */
  readonly prints?: boolean;
  /** It prints the reference it gives back: "<name> >> (<form id, 8 hex digits>)". */
  readonly printsReference?: boolean;
}

const form = (index: number): NativeArgument => ({ form: index });
const ref = (index: number): NativeArgument => ({ reference: index });
const num = (index: number, fallback?: number): NativeArgument =>
  fallback === undefined ? { number: index } : { number: index, fallback };
const bool = (index: number, fallback?: boolean): NativeArgument =>
  fallback === undefined ? { bool: index } : { bool: index, fallback };
const text = (index: number): NativeArgument => ({ text: index });
const self: NativeArgument = { self: true };
const fixed = (value: boolean | number | null): NativeArgument => ({ fixed: value });
const onForm = (index: number): { readonly form: number } => ({ form: index });

/** The script functions a native does, by lower-case name (the natives as the scripts call them). */
export const NATIVE_FUNCTIONS: Readonly<Record<string, NativeFunction>> = {
  startcombat: { native: 'actor.startcombat', args: [ref(0)] },
  stopcombat: { native: 'actor.stopcombat', args: [] },
  say: { native: 'objectreference.say', args: [form(0), fixed(null), fixed(false)] },
  drop: { native: 'objectreference.dropobject', args: [form(0), num(1, 1)] },
  setalert: { native: 'actor.setalert', args: [bool(0)] },
  evaluatepackage: { native: 'actor.evaluatepackage', args: [] },
  modfactionrank: { native: 'actor.modfactionrank', args: [form(0), num(1)] },
  setghost: { native: 'actor.setghost', args: [bool(0)] },
  setactoralpha: { native: 'actor.setalpha', args: [num(0), bool(1, false)] },
  resethealth: { native: 'actor.resethealthandlimbs', args: [] },
  damageactorvalue: { native: 'actor.damageactorvalue', args: [text(0), num(1)] },
  pushactoraway: { native: 'objectreference.pushactoraway', args: [ref(0), num(1)] },
  setplayerteammate: { native: 'actor.setplayerteammate', args: [bool(0), fixed(true)] },
  equipspell: { native: 'actor.equipspell', args: [form(0), num(1)] },
  equipshout: { native: 'actor.equipshout', args: [form(0)] },
  sendanimevent: { native: 'debug.sendanimationevent', on: 'none', args: [self, text(0)] },
  applyhavokimpulse: {
    native: 'objectreference.applyhavokimpulse',
    args: [num(0), num(1), num(2), num(3)],
  },
  setnobleedoutrecovery: { native: 'actor.setnobleedoutrecovery', args: [bool(0)] },
  unequipall: { native: 'actor.unequipall', args: [] },
  unequipitemslot: { native: 'actor.unequipitemslot', args: [num(0)] },
  dispelallspells: { native: 'actor.dispelallspells', args: [] },
  dispel: { native: 'actor.dispelspell', args: [form(0)] },
  knockareaeffect: { native: 'objectreference.knockareaeffect', args: [num(0), num(1)] },
  interruptcast: { native: 'objectreference.interruptcast', args: [] },
  setopenstate: { native: 'objectreference.setopen', args: [bool(0)] },
  setdestroyed: { native: 'objectreference.setdestroyed', args: [bool(0)] },
  cleardestruction: { native: 'objectreference.cleardestruction', args: [] },
  damageobject: { native: 'objectreference.damageobject', args: [num(0)] },
  resetreference: { native: 'objectreference.reset', args: [ref(0)] },
  addtomap: { native: 'objectreference.addtomap', on: onForm(0), args: [bool(1, false)] },
  enablefasttravel: { native: 'game.enablefasttravel', on: 'none', args: [bool(0)] },
  fasttravel: { native: 'game.fasttravel', on: 'none', args: [ref(0)] },
  setobjectivefailed: {
    native: 'quest.setobjectivefailed',
    on: onForm(0),
    args: [num(1), bool(2)],
  },
  getobjectivefailed: {
    native: 'quest.isobjectivefailed',
    on: onForm(0),
    args: [num(1)],
    prints: true,
  },
  getobjectivecompleted: {
    native: 'quest.isobjectivecompleted',
    on: onForm(0),
    args: [num(1)],
    prints: true,
  },
  getobjectivedisplayed: {
    native: 'quest.isobjectivedisplayed',
    on: onForm(0),
    args: [num(1)],
    prints: true,
  },
  applyimagespacemodifier: {
    native: 'imagespacemodifier.apply',
    on: onForm(0),
    args: [num(1, 1)],
  },
  removeimagespacemodifier: { native: 'imagespacemodifier.remove', on: onForm(0), args: [] },
  applyimagespacemodifiercrossfade: {
    native: 'imagespacemodifier.applycrossfade',
    on: onForm(0),
    args: [num(1, 1)],
  },
  removeimagespacemodifiercrossfade: {
    native: 'imagespacemodifier.removecrossfade',
    on: 'none',
    args: [num(0, 1)],
  },
  showbartermenu: { native: 'actor.showbartermenu', args: [] },
  servetime: { native: 'game.servetime', on: 'none', args: [] },
  setlocationcleared: { native: 'location.setcleared', on: onForm(0), args: [bool(1)] },
  setpcexpelled: { native: 'faction.setplayerexpelled', on: onForm(0), args: [bool(1)] },
  setpcenemyoffaction: { native: 'faction.setplayerenemy', on: onForm(0), args: [bool(1)] },
  setfactionreaction: { native: 'faction.setreaction', on: onForm(0), args: [form(1), num(2)] },
  setenemy: {
    native: 'faction.setenemy',
    on: onForm(0),
    args: [form(1), bool(2, false), bool(3, false)],
  },
  setally: {
    native: 'faction.setally',
    on: onForm(0),
    args: [form(1), bool(2, false), bool(3, false)],
  },
  triggerscreenblood: { native: 'game.triggerscreenblood', on: 'none', args: [num(0)] },
  camerashake: {
    native: 'game.shakecamera',
    on: 'none',
    args: [fixed(null), num(0), num(1, 0)],
  },
  autosave: { native: 'game.requestautosave', on: 'none', args: [] },
  addformtoformlist: { native: 'formlist.addform', on: onForm(0), args: [form(1)] },
  revertformlist: { native: 'formlist.revert', on: onForm(0), args: [] },
  removefromallfactions: { native: 'actor.removefromallfactions', args: [] },
  setcriticalstage: { native: 'actor.setcriticalstage', args: [num(0)] },
  setplayerresistingarrest: { native: 'actor.setplayerresistingarrest', args: [] },
  sendtrespassalarm: { native: 'actor.sendtrespassalarm', args: [ref(0)] },
  sendstealalarm: { native: 'objectreference.sendstealalarm', args: [ref(0)] },
  sendassaultalarm: { native: 'actor.sendassaultalarm', args: [] },
  setallowflying: { native: 'actor.setallowflying', args: [bool(0)] },
  playmagicshadervisuals: {
    native: 'effectshader.play',
    on: onForm(0),
    args: [self, num(1, -1)],
  },
  stopmagicshadervisuals: { native: 'effectshader.stop', on: onForm(0), args: [self] },
  startscene: { native: 'scene.start', on: onForm(0), args: [] },
  stopscene: { native: 'scene.stop', on: onForm(0), args: [] },
  setunconscious: { native: 'actor.setunconscious', args: [bool(0)] },
  setrestrained: { native: 'actor.setrestrained', args: [bool(0)] },
  clearownership: { native: 'objectreference.setactorowner', args: [fixed(null)] },
  showmessage: { native: 'message.show', on: onForm(0), args: [] },
  playsound: { native: 'sound.play', on: onForm(0), args: [self] },
  addmusic: { native: 'musictype.add', on: onForm(0), args: [] },
  removemusic: { native: 'musictype.remove', on: onForm(0), args: [] },
  setcrimefaction: { native: 'actor.setcrimefaction', args: [form(0)] },
  getlinkedref: { native: 'objectreference.getlinkedref', args: [form(0)], printsReference: true },
  getcombattarget: { native: 'actor.getcombattarget', args: [], printsReference: true },
  getplayergrabbedref: {
    native: 'game.getplayergrabbedref',
    on: 'none',
    args: [],
    printsReference: true,
  },
};

/** The line of a script function that gives back a reference (observed in the original). */
export function referenceLine(name: string, formId: number | undefined): string {
  return `${name} >> (${(formId ?? 0).toString(16).padStart(8, '0')})`;
}

/**
 * The script language's math functions: Sin, Cos and Tan of degrees (an Int flag 1 gives the
 * inverse, in degrees), Sqrt, Log (natural, or to the base given) and Abs; undefined for any
 * other function. TODO(M13): inferred from the parameters (Float, Int(optional) /
 * Float(optional)) and the earlier games' script docs; the console's line for them is the
 * common one.
 */
export function mathFunction(
  name: string,
  args: readonly (number | string | undefined)[],
): number | undefined {
  const x = typeof args[0] === 'number' ? args[0] : 0;
  const second = args[1];
  const inverse = second === 1;
  const radians = (x * Math.PI) / 180;
  const degrees = (value: number): number => (value * 180) / Math.PI;
  switch (name) {
    case 'Sin':
      return inverse ? degrees(Math.asin(x)) : Math.sin(radians);
    case 'Cos':
      return inverse ? degrees(Math.acos(x)) : Math.cos(radians);
    case 'Tan':
      return inverse ? degrees(Math.atan(x)) : Math.tan(radians);
    case 'Sqrt':
      return Math.sqrt(x);
    case 'Log':
      return typeof second === 'number' ? Math.log(x) / Math.log(second) : Math.log(x);
    case 'Abs':
      return Math.abs(x);
    default:
      return undefined;
  }
}
