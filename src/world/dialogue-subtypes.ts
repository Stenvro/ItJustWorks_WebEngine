// The dialogue topic subtypes (DIAL SNAM): what a topic is for (a greeting, a combat taunt, a
// service, idle chatter, ...) and the Creation Kit's dialogue tab it is under (DIAL DATA's
// category, INFO's "Quest Dialogue Tab"). After xEdit's wbSubtypeNamesEnum (code → name) and
// DIAL DATA subtype enum (the order), whose categories are ranges of that order. Checked
// against the vanilla topics: every topic of a code has its category but 24 (21 SCEN, one each
// of HIT_, DETH, HELO under player dialogue). Platform-independent.
// Notes: docs/formats/esm.md ("Dialogue").

import { TopicCategory } from './dialogue-records.ts';

export interface DialogueSubtype {
  /** SNAM: the four characters ("HELO", "HIT_"). */
  readonly code: string;
  readonly name: string;
  /**
   * DIAL DATA's u16 in the Creation Kit's current order. Older vanilla topics keep older
   * numbers (Attack is 20, 25 or 26): the code is what counts.
   */
  readonly index: number;
  /** TopicCategory: the dialogue tab. */
  readonly category: number;
}

/** Each category's subtypes [code, name], in DATA's order. */
const BY_CATEGORY: readonly (readonly [number, readonly (readonly [string, string])[]])[] = [
  [
    TopicCategory.topic,
    [
      ['CUST', 'Custom'],
      ['PFGT', 'ForceGreet'],
      ['RUMO', 'Rumors'],
      ['FVDL', 'Custom?'],
    ],
  ],
  [
    TopicCategory.favor,
    [
      ['INTI', 'Intimidate'],
      ['FLAT', 'Flatter'],
      ['BRIB', 'Bribe'],
      ['ASKG', 'Ask Gift'],
      ['GIFF', 'Gift'],
      ['ASKF', 'Ask Favor'],
      ['FAVO', 'Favor'],
      ['SHRE', 'Show Relationships'],
      ['FOLL', 'Follow'],
      ['FRJT', 'Reject'],
    ],
  ],
  [TopicCategory.scene, [['SCEN', 'Scene']]],
  [
    TopicCategory.favors,
    [
      ['SHOW', 'Show'],
      ['AGRE', 'Agree'],
      ['REFU', 'Refuse'],
      ['FEXT', 'ExitFavorState'],
      ['MREF', 'MoralRefusal'],
      ['FMLX', 'FlyingMountLand'],
      ['FMXL', 'FlyingMountCancelLand'],
      ['FMAT', 'FlyingMountAcceptTarget'],
      ['FMRT', 'FlyingMountRejectTarget'],
      ['FMNT', 'FlyingMountNoTarget'],
      ['FMDR', 'FlyingMountDestinationReached'],
    ],
  ],
  [
    TopicCategory.combat,
    [
      ['ATCK', 'Attack'],
      ['POAT', 'PowerAttack'],
      ['BASH', 'Bash'],
      ['HIT_', 'Hit'],
      ['FLEE', 'Flee'],
      ['BLED', 'BleedOut'],
      ['AVTH', 'AvoidThreat'],
      ['DETH', 'Death'],
      ['GRST', 'GroupStrategy'],
      ['BLOC', 'Block'],
      ['TAUT', 'Taunt'],
      ['ALKL', 'AllyKilled'],
      ['STEA', 'Steal'],
      ['YIEL', 'Yield'],
      ['ACYI', 'AcceptYield'],
      ['PICC', 'PickpocketCombat'],
      ['ASSA', 'Assault'],
      ['MURD', 'Murder'],
      ['ASNC', 'AssaultNC'],
      ['MUNC', 'MurderNC'],
      ['PICN', 'PickpocketNC'],
      ['STFN', 'StealFromNC'],
      ['TRAN', 'TrespassAgainstNC'],
      ['TRES', 'Trespass'],
      ['WTCR', 'WereTransformCrime'],
      ['VPSS', 'VoicePowerStartShort'],
      ['VPSL', 'VoicePowerStartLong'],
      ['VPES', 'VoicePowerEndShort'],
      ['VPEL', 'VoicePowerEndLong'],
    ],
  ],
  [
    TopicCategory.detection,
    [
      ['ALIL', 'AlertIdle'],
      ['LOIL', 'LostIdle'],
      ['NOTA', 'NormalToAlert'],
      ['ALTC', 'AlertToCombat'],
      ['NOTC', 'NormalToCombat'],
      ['ALTN', 'AlertToNormal'],
      ['COTN', 'CombatToNormal'],
      ['COLO', 'CombatToLost'],
      ['LOTN', 'LostToNormal'],
      ['LOTC', 'LostToCombat'],
      ['DFDA', 'DetectFriendDie'],
    ],
  ],
  [
    TopicCategory.service,
    [
      ['SERU', 'ServiceRefusal'],
      ['REPA', 'Repair'],
      ['TRAV', 'Travel'],
      ['TRAI', 'Training'],
      ['BAEX', 'BarterExit'],
      ['REEX', 'RepairExit'],
      ['RECH', 'Recharge'],
      ['RCEX', 'RechargeExit'],
      ['TREX', 'TrainingExit'],
    ],
  ],
  [
    TopicCategory.miscellaneous,
    [
      ['OBCO', 'ObserveCombat'],
      ['NOTI', 'NoticeCorpse'],
      ['TITG', 'TimeToGo'],
      ['GBYE', 'Goodbye'],
      ['HELO', 'Hello'],
      ['SWMW', 'SwingMeleeWeapon'],
      ['FIWE', 'ShootBow'],
      ['ZKEY', 'ZKeyObject'],
      ['JUMP', 'Jump'],
      ['KNOO', 'KnockOverObject'],
      ['DEOB', 'DestroyObject'],
      ['STOF', 'StandonFurniture'],
      ['LOOB', 'LockedObject'],
      ['PICT', 'PickpocketTopic'],
      ['PURS', 'PursueIdleTopic'],
      ['IDAT', 'SharedInfo'],
      ['PCPS', 'PlayerCastProjectileSpell'],
      ['PCSS', 'PlayerCastSelfSpell'],
      ['PCSH', 'PlayerShout'],
      ['IDLE', 'Idle'],
      ['BREA', 'EnterSprintBreath'],
      ['ENBZ', 'EnterBowZoomBreath'],
      ['EXBZ', 'ExitBowZoomBreath'],
      ['ACAC', 'ActorCollidewithActor'],
      ['PIRN', 'PlayerinIronSights'],
      ['OUTB', 'OutofBreath'],
      ['GRNT', 'CombatGrunt'],
      ['LWBS', 'LeaveWaterBreath'],
    ],
  ],
];

/** Every subtype (103), in DATA's order. */
export const DIALOGUE_SUBTYPES: readonly DialogueSubtype[] = BY_CATEGORY.flatMap(
  ([category, subtypes]) => subtypes.map(([code, name]) => ({ code, name, category, index: 0 })),
).map((subtype, index) => ({ ...subtype, index }));

const BY_CODE = new Map(DIALOGUE_SUBTYPES.map((subtype) => [subtype.code, subtype]));

/** A subtype by its code ("HELO"); undefined for one not in the table. */
export function dialogueSubtype(code: string): DialogueSubtype | undefined {
  return BY_CODE.get(code);
}
