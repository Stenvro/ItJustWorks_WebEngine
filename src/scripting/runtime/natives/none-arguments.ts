// The natives' own checks of a None argument (observed in the original): there is no one rule.
// A call on a None object is the VM's ("Cannot call X() on a None object"); a None argument is
// each native's own check, with its own line in the Papyrus log, after which the native does
// nothing and returns what the original returns there (its type's default, but -1 for
// FormList.Find and the largest float for GetDistance). Arguments of a wrong type cannot reach a
// native (the compiler types them; a failed cast gives None). Lines that begin "cannot"
// follow the object they are about, as the original writes them. A native whose None argument is
// fine (RemoveItem's akOtherContainer, AttachAshPile's default pile) has no entry.
// Platform-independent. Notes: docs/scripting.md ("Natives").

import type { NativeCall, NativeFunction } from '../../papyrus-vm.ts';
import { formatValue, type Value } from '../../values.ts';

/** One argument a native checks: its index and the original's line for a None there. */
interface NoneCheck {
  readonly arg: number;
  readonly line: string;
}

/** A native's checks, in the order it makes them, and what it returns after the line. */
interface NoneChecks {
  readonly checks: readonly NoneCheck[];
  readonly result: Value;
}

/** The largest single-precision float (GetDistance to None). */
const FLOAT_MAX = 3.4028234663852886e38;

const on = (arg: number, line: string): NoneCheck => ({ arg, line });

const LOS_FROM = on(0, 'Cannot register for LOS from a None actor');
const LOS_TO = on(1, 'Cannot register for LOS for a None target');
const UNLOS_FROM = on(0, 'Cannot unregister for a LOS event from a None actor');
const UNLOS_TO = on(1, 'Cannot unregister for a LOS event for a None target');
const ANIM_ON = on(0, 'Cannot register for an animation event on an None object');
const UNANIM_ON = on(0, 'Cannot unregister for an animation event on an None object');
const MOVED_TO = on(0, "cannot be moved to a None object's location");
const SPELL_SOURCE = on(0, 'Cannot cast a spell from a None source');
const ALLY = on(0, 'Cannot be an ally of a None faction');
const LEVELED = on(0, 'Cannot add form None to leveled list');
const FIND_TYPE = on(0, 'None or invalid form type as Base object for FindClosestReferenceOfType');
const FIND_LIST = on(0, 'None or invalid form list passed in to FindClosestReferenceOfType');

/** The checks by "script.function" in lower case. */
export const NONE_ARGUMENT_CHECKS: ReadonlyMap<string, NoneChecks> = new Map<string, NoneChecks>([
  // The registrations every script object has (ActiveMagicEffect, Alias, Form).
  ...['activemagiceffect', 'alias', 'form'].flatMap((type): [string, NoneChecks][] => [
    [`${type}.registerforlos`, { checks: [LOS_FROM, LOS_TO], result: null }],
    [`${type}.registerforsinglelosgain`, { checks: [LOS_FROM, LOS_TO], result: null }],
    [`${type}.registerforsingleloslost`, { checks: [LOS_FROM, LOS_TO], result: null }],
    [`${type}.unregisterforlos`, { checks: [UNLOS_FROM, UNLOS_TO], result: null }],
    [`${type}.registerforanimationevent`, { checks: [ANIM_ON], result: false }],
    [`${type}.unregisterforanimationevent`, { checks: [UNANIM_ON], result: null }],
  ]),
  ...(
    [
      ['activemagiceffect', 'this effect'],
      ['referencealias', 'this reference alias'],
      ['objectreference', 'this reference'],
    ] as const
  ).flatMap(([type, what]): [string, NoneChecks][] => [
    [
      `${type}.addinventoryeventfilter`,
      { checks: [on(0, `Cannot add a None inventory event filter to ${what}`)], result: null },
    ],
    [
      `${type}.removeinventoryeventfilter`,
      { checks: [on(0, `Cannot remove a None inventory event filter from ${what}`)], result: null },
    ],
  ]),
  // Actor.
  ['actor.addshout', { checks: [on(0, 'Cannot add a None shout to the actor')], result: false }],
  ['actor.addspell', { checks: [on(0, 'Cannot add a None spell to the actor')], result: false }],
  ['actor.equipitem', { checks: [on(0, 'Cannot equip a None item')], result: null }],
  ['actor.equipshout', { checks: [on(0, 'Cannot equip a None shout')], result: null }],
  ['actor.equipspell', { checks: [on(0, 'Cannot equip a None spell')], result: null }],
  [
    'actor.getfactionrank',
    { checks: [on(0, 'Cannot get the faction rank with a None faction')], result: 0 },
  ],
  [
    'actor.getfactionreaction',
    { checks: [on(0, 'Cannot get faction reaction against a None actor')], result: 0 },
  ],
  [
    'actor.getrelationshiprank',
    { checks: [on(0, 'Cannot determine relationship rank with a None actor')], result: 0 },
  ],
  [
    'actor.hasassociation',
    { checks: [on(0, 'Cannot check if an actor has a None association type')], result: false },
  ],
  ['actor.haslos', { checks: [on(0, 'Cannot request LOS to a None object')], result: false }],
  [
    'actor.hasparentrelationship',
    {
      checks: [on(0, 'Cannot check if an actor has a parent relationship with None')],
      result: false,
    },
  ],
  ['actor.isdetectedby', { checks: [on(0, 'Cannot be detected by a None actor')], result: false }],
  [
    'actor.isequipped',
    { checks: [on(0, 'Cannot check to for a None item to be equipped')], result: false },
  ],
  [
    'actor.modfactionrank',
    { checks: [on(0, 'Cannot modify the faction rank with a None faction')], result: null },
  ],
  [
    'actor.pathtoreference',
    { checks: [on(0, 'Destination is none, cannot path to none')], result: false },
  ],
  ['actor.playidle', { checks: [on(0, 'Cannot play a None idle on an actor')], result: false }],
  [
    'actor.playidlewithtarget',
    { checks: [on(0, 'Cannot play a None idle on an actor')], result: false },
  ],
  [
    'actor.sendtrespassalarm',
    { checks: [on(0, 'Cannot sound trespass alarm on a None actor')], result: null },
  ],
  [
    'actor.setfactionrank',
    { checks: [on(0, 'Cannot set the faction rank with a None faction')], result: null },
  ],
  ['actor.setlookat', { checks: [on(0, 'Cannot look at a None target')], result: null }],
  [
    'actor.setoutfit',
    { checks: [on(0, 'Cannot set sleep or default outfit to None')], result: null },
  ],
  [
    'actor.setrelationshiprank',
    { checks: [on(0, 'Cannot set relationship rank with a None actor')], result: null },
  ],
  // The original's line has the two spaces.
  [
    'actor.startcannibal',
    { checks: [on(0, 'Cannot start cannibal  with a None actor')], result: null },
  ],
  ['actor.startcombat', { checks: [on(0, 'Cannot start combat with a None actor')], result: null }],
  [
    'actor.startvampirefeed',
    { checks: [on(0, 'Cannot start vampire feed with a None actor')], result: null },
  ],
  ['actor.unequipitem', { checks: [on(0, 'Cannot unequip a None item')], result: null }],
  ['actor.unequipshout', { checks: [on(0, 'Cannot unequip a None shout')], result: null }],
  ['actor.unequipspell', { checks: [on(0, 'Cannot unequip a None spell')], result: null }],
  [
    'actor.wornhaskeyword',
    { checks: [on(0, 'Cannot check worn items against a None keyword')], result: false },
  ],
  // Aliases and locations.
  [
    'locationalias.forcelocationto',
    { checks: [on(0, "Cannot force the alias's location to a None location")], result: null },
  ],
  [
    'referencealias.forcerefto',
    { checks: [on(0, "Cannot force the alias's reference to a None reference")], result: null },
  ],
  [
    'location.getreftypealivecount',
    { checks: [on(0, 'Cannot get a count from a None location ref type')], result: 0 },
  ],
  [
    'location.getreftypedeadcount',
    { checks: [on(0, 'Cannot get a count from a None location ref type')], result: 0 },
  ],
  [
    'location.hascommonparent',
    { checks: [on(0, 'Cannot check location against a None location')], result: false },
  ],
  [
    'location.ischild',
    { checks: [on(0, 'Cannot check location against a None location')], result: false },
  ],
  [
    'location.setkeyworddata',
    { checks: [on(0, 'Cannot set keyword data with a None keyword')], result: null },
  ],
  // Effects, sounds and spells.
  [
    'visualeffect.play',
    { checks: [on(0, 'Cannot play a visual effect on a None object')], result: null },
  ],
  [
    'visualeffect.stop',
    { checks: [on(0, 'Cannot stop a visual effect on a None object')], result: null },
  ],
  [
    'effectshader.play',
    { checks: [on(0, 'Cannot play an effect shader on a None object')], result: null },
  ],
  [
    'effectshader.stop',
    { checks: [on(0, 'Cannot stop an effect shader on a None object')], result: null },
  ],
  ['sound.play', { checks: [on(0, 'Cannot play a sound from a None object')], result: 0 }],
  [
    'sound.playandwait',
    { checks: [on(0, 'Cannot play a sound from a None object')], result: false },
  ],
  ['spell.cast', { checks: [SPELL_SOURCE], result: null }],
  ['scroll.cast', { checks: [SPELL_SOURCE], result: null }],
  ['weapon.fire', { checks: [on(0, 'Cannot fire a weapon from a None source')], result: null }],
  // Forms.
  ['formlist.find', { checks: [on(0, 'Cannot find a None form')], result: -1 }],
  ['leveledactor.addform', { checks: [LEVELED], result: null }],
  ['leveleditem.addform', { checks: [LEVELED], result: null }],
  ['leveledspell.addform', { checks: [LEVELED], result: null }],
  ['faction.setally', { checks: [ALLY], result: null }],
  ['faction.setenemy', { checks: [ALLY], result: null }],
  [
    'faction.modreaction',
    {
      checks: [on(0, "Cannot modify a faction's reaction towards a None faction")],
      result: null,
    },
  ],
  [
    'faction.setreaction',
    { checks: [on(0, 'Cannot set the faction reaction towards a None faction')], result: null },
  ],
  // Debug and Game.
  [
    'debug.dumpaliasdata',
    { checks: [on(0, "Cannot dump a None quest's aliases to the log")], result: null },
  ],
  [
    'game.addhavokballandsocketconstraint',
    {
      checks: [
        on(0, 'none first reference passed in to AddHavokBallAndSocketConstraint'),
        on(2, 'none second reference passed in to AddHavokBallAndSocketConstraint'),
      ],
      result: false,
    },
  ],
  [
    'game.removehavokconstraints',
    {
      checks: [
        on(0, 'none first reference passed in to RemoveHavokConstraints'),
        on(2, 'none second reference passed in to RemoveHavokConstraints'),
      ],
      result: false,
    },
  ],
  [
    'game.fasttravel',
    { checks: [on(0, "Cannot fast-travel to a None object's location")], result: null },
  ],
  ['game.findclosestreferenceoftype', { checks: [FIND_TYPE], result: null }],
  ['game.findrandomreferenceoftype', { checks: [FIND_TYPE], result: null }],
  ['game.findclosestreferenceofanytypeinlist', { checks: [FIND_LIST], result: null }],
  ['game.findrandomreferenceofanytypeinlist', { checks: [FIND_LIST], result: null }],
  [
    'game.teachword',
    { checks: [on(0, 'Cannot teach the player a None word of power')], result: null },
  ],
  ['game.unlockword', { checks: [on(0, 'Cannot unlock a None word of power')], result: null }],
  [
    'game.iswordunlocked',
    { checks: [on(0, 'Cannot determine Locked status of a None word of power')], result: false },
  ],
  // ObjectReference.
  ['objectreference.activate', { checks: [on(0, 'Action ref cannot be None')], result: false }],
  [
    'objectreference.adddependentanimatedobjectreference',
    { checks: [on(0, 'Cannot make none object dependent.')], result: false },
  ],
  [
    'objectreference.removedependentanimatedobjectreference',
    { checks: [on(0, 'Cannot remove none object from being dependent.')], result: false },
  ],
  [
    'objectreference.additem',
    { checks: [on(0, 'Cannot add a None item to a container')], result: null },
  ],
  [
    'objectreference.createdetectionevent',
    { checks: [on(0, 'Cannot generate a detection event with a None owner')], result: null },
  ],
  ['objectreference.dropobject', { checks: [on(0, 'Cannot drop a None item')], result: null }],
  [
    'objectreference.getdistance',
    {
      checks: [on(0, 'Cannot calculate distance between and object and None')],
      result: FLOAT_MAX,
    },
  ],
  [
    'objectreference.getheadingangle',
    { checks: [on(0, 'Cannot get the heading angle to a None object')], result: 0 },
  ],
  [
    'objectreference.hasreftype',
    {
      checks: [on(0, 'Cannot check if the reference has a None location ref type')],
      result: false,
    },
  ],
  ['objectreference.moveto', { checks: [MOVED_TO], result: null }],
  ['objectreference.movetonode', { checks: [MOVED_TO], result: null }],
  ['objectreference.movetointeractionlocation', { checks: [MOVED_TO], result: null }],
  ['objectreference.placeatme', { checks: [on(0, 'Cannot place a None object')], result: null }],
  [
    'objectreference.placeactoratme',
    { checks: [on(0, 'Cannot place a None actor')], result: null },
  ],
  [
    'objectreference.playimpacteffect',
    { checks: [on(0, 'cannot play a None impact effect')], result: false },
  ],
  [
    'objectreference.processtraphit',
    { checks: [on(0, 'Cannot process a None trap')], result: null },
  ],
  [
    'objectreference.pushactoraway',
    { checks: [on(0, 'Cannot push back a None actor')], result: null },
  ],
  ['objectreference.say', { checks: [on(0, 'cannot speak a None topic info')], result: null }],
  [
    'objectreference.sendstealalarm',
    { checks: [on(0, 'cannot be stolen by a None actor')], result: null },
  ],
]);

/**
 * Wraps a native with its None checks: a None where it checks is the original's line on the
 * calling stack and the native's result there; otherwise the native runs.
 */
export function withNoneChecks(
  name: string,
  fn: NativeFunction,
  warn: (message: string) => void,
): NativeFunction {
  const entry = NONE_ARGUMENT_CHECKS.get(name);
  if (!entry) return fn;
  return (call: NativeCall) => {
    for (const { arg, line } of entry.checks) {
      if ((call.args[arg] ?? null) !== null) continue;
      // A line beginning "cannot" in lower case goes after the object it is about.
      const text = line.startsWith('cannot ') ? `${formatValue(call.self)} ${line}` : line;
      warn(`${call.where()}: ${text}`);
      return entry.result;
    }
    return fn(call);
  };
}
