// Natives of Game (signatures: the game's Game.pex): the player, forms by id, game settings,
// the player's controls, stats, words of power, fast travel; what the engine shows (fades,
// camera, menus) goes through the WorldBridge. Platform-independent.
// Notes: docs/scripting.md ("Natives").

import type { ScriptRuntime } from '../runtime.ts';
import { PLAYER_REF } from '../forms.ts';
import { bool, formOf, int, num, object, str, type Register } from './args.ts';
import { ObjectHandle, type Value } from '../../values.ts';

/** Game.EnablePlayerControls / DisablePlayerControls flags, in their argument order. */
export const CONTROLS = [
  'movement',
  'fighting',
  'camSwitch',
  'looking',
  'sneaking',
  'menu',
  'activate',
  'journalTabs',
] as const;

export function registerGame(n: Register, runtime: ScriptRuntime): void {
  const { state, world } = runtime;
  n('game.getplayer', () => new ObjectHandle(PLAYER_REF, 'actor'));
  n('game.getform', async ({ args }) => {
    const formId = int(args[0]) >>> 0;
    return (await runtime.forms.record(formId)) || formId === PLAYER_REF
      ? runtime.formHandle(formId)
      : null;
  });
  n('game.getformfromfile', async ({ args }) => {
    // The id as the plugin numbers it (its masters' ids keep their index), in that plugin.
    const formId = runtime.forms.db.formIdOf(str(args[1]), int(args[0]) & 0xffffff);
    return formId === undefined || !(await runtime.forms.record(formId))
      ? null
      : runtime.formHandle(formId);
  });
  n('game.getgamesettingfloat', async ({ args }) => num(await runtime.gameSetting(str(args[0]))));
  n('game.getgamesettingint', async ({ args }) => int(await runtime.gameSetting(str(args[0]))));
  n('game.getgamesettingstring', async ({ args }) => {
    const value = await runtime.gameSetting(str(args[0]));
    return typeof value === 'string' ? value : '';
  });
  n('game.getrealhourspassed', () => state.realTime / 3600);

  // --- Controls ------------------------------------------------------------------------------
  const setControls = (enabled: boolean, args: readonly Value[]): void => {
    CONTROLS.forEach((control, i) => {
      // Arguments left out default to true (each control named is changed).
      const named = bool(args[i], true);
      if (named) runtime.controls[control] = enabled;
    });
    runtime.controls.disablePov = enabled ? 0 : int(args[8]);
    world.controlsChanged?.();
  };
  n('game.enableplayercontrols', ({ args }) => {
    setControls(true, args);
    return null;
  });
  n('game.disableplayercontrols', ({ args }) => {
    setControls(false, args);
    return null;
  });
  for (const control of CONTROLS) {
    n(`game.is${control.toLowerCase()}controlsenabled`, () => runtime.controls[control]);
  }
  n('game.isjournalcontrolsenabled', () => runtime.controls.journalTabs);
  n('game.setplayeraidriven', ({ args }) => {
    runtime.controls.aiDriven = bool(args[0], true);
    world.controlsChanged?.();
    return null;
  });
  n('game.setinchargen', ({ args }) => {
    runtime.chargen = {
      noSaving: bool(args[0]),
      noWaiting: bool(args[1]),
      controlsMessage: bool(args[2]),
    };
    return null;
  });

  // --- Fast travel --------------------------------------------------------------------------
  n('game.enablefasttravel', ({ args }) => {
    runtime.fastTravelEnabled = bool(args[0], true);
    return null;
  });
  n('game.isfasttravelenabled', () => runtime.fastTravelEnabled);
  n('game.isfasttravelcontrolsenabled', () => runtime.fastTravelEnabled);
  n('game.fasttravel', ({ args }) => {
    const destination = runtime.reference(args[0] ?? null);
    if (destination !== undefined) world.fastTravel?.(destination);
    return null;
  });

  // --- Stats, skills, perks, shouts ---------------------------------------------------------
  // Skills and perk points: the progression engine (progression-engine.ts).
  n('game.incrementstat', ({ args }) => {
    const stat = str(args[0]).toLowerCase();
    runtime.stats.set(stat, (runtime.stats.get(stat) ?? 0) + int(args[1], 1));
    return null;
  });
  n('game.querystat', ({ args }) => runtime.stats.get(str(args[0]).toLowerCase()) ?? 0);
  // AdvanceSkill(asSkillName, afMagnitude): skill uses (the experience the use gives).
  n('game.advanceskill', async ({ args }) => {
    await runtime.advanceSkill(str(args[0]), num(args[1]));
    return null;
  });
  // IncrementSkill(asSkillName) / IncrementSkillBy(asSkillName, aiCount): levels as if earned.
  n('game.incrementskill', async ({ args }) => {
    await runtime.incrementSkill(str(args[0]), 1);
    return null;
  });
  n('game.incrementskillby', async ({ args }) => {
    await runtime.incrementSkill(str(args[0]), int(args[1], 1));
    return null;
  });
  n('game.addperkpoints', ({ args }) => {
    runtime.perkPoints += int(args[0]);
    return null;
  });
  n('game.teachword', ({ args }) => {
    const word = formOf(args[0]);
    if (word !== undefined && !runtime.wordsLearned.has(word))
      runtime.wordsLearned.set(word, false);
    return null;
  });
  n('game.unlockword', ({ args }) => {
    const word = formOf(args[0]);
    if (word !== undefined) runtime.wordsLearned.set(word, true);
    return null;
  });
  n('game.iswordunlocked', ({ args }) => {
    const word = formOf(args[0]);
    return word !== undefined && runtime.wordsLearned.get(word) === true;
  });
  n('game.addachievement', () => null);
  n('game.calculatefavorcost', ({ args }) => int(args[0]));

  // --- Finding references near a point (among the loaded cells' references) ---------------
  n('game.findclosestreferenceoftype', async ({ args }) =>
    runtime.referenceHandleOrNone(await runtime.findReference([formOf(args[0])], args, true)),
  );
  n('game.findrandomreferenceoftype', async ({ args }) =>
    runtime.referenceHandleOrNone(await runtime.findReference([formOf(args[0])], args, false)),
  );
  n('game.findclosestreferenceofanytypeinlist', async ({ args }) => {
    const list = formOf(args[0]);
    const forms = list === undefined ? [] : await runtime.formList(list);
    return runtime.referenceHandleOrNone(await runtime.findReference(forms, args, true));
  });
  n('game.findrandomreferenceofanytypeinlist', async ({ args }) => {
    const list = formOf(args[0]);
    const forms = list === undefined ? [] : await runtime.formList(list);
    return runtime.referenceHandleOrNone(await runtime.findReference(forms, args, false));
  });
  n('game.findclosestactor', async ({ args }) =>
    runtime.referenceHandleOrNone(
      await runtime.findActor([num(args[0]), num(args[1]), num(args[2])], num(args[3]), true),
    ),
  );
  n('game.findrandomactor', async ({ args }) =>
    runtime.referenceHandleOrNone(
      await runtime.findActor([num(args[0]), num(args[1]), num(args[2])], num(args[3]), false),
    ),
  );

  // --- The engine: camera, fades, menus, video ------------------------------------------------
  n('game.fadeoutgame', ({ args }) => {
    world.fade?.(bool(args[0]), bool(args[1]), num(args[2]), num(args[3]));
    return null;
  });
  n('game.forcefirstperson', () => {
    world.pointOfView?.('first');
    return null;
  });
  n('game.forcethirdperson', () => {
    world.pointOfView?.('third');
    return null;
  });
  n('game.showfirstpersongeometry', () => null);
  n('game.shakecamera', ({ args }) => {
    world.shakeCamera?.(num(args[1], 0.5), num(args[2]));
    return null;
  });
  n('game.shakecontroller', () => null);
  n('game.setcameratarget', () => null);
  n('game.triggerscreenblood', () => null);
  n('game.setsungazeimagespacemodifier', () => null);
  n('game.isplayersungazing', () => false);
  for (const axis of ['x', 'y', 'z'] as const)
    n(
      `game.getsunposition${axis}`,
      () => runtime.sunPosition()[axis === 'x' ? 0 : axis === 'y' ? 1 : 2],
    );
  n('game.getplayergrabbedref', () => runtime.referenceHandleOrNone(world.grabbed?.()));
  n('game.getplayerslastriddenhorse', () => object(runtime.lastHorse, 'actor'));
  n('game.requestsave', () => null);
  n('game.requestautosave', () => null);
  n('game.showracemenu', () => {
    void world.menu?.({ name: 'RaceSex Menu', limited: false });
    return null;
  });
  n('game.showlimitedracemenu', () => {
    void world.menu?.({ name: 'RaceSex Menu', limited: true });
    return null;
  });
  n('game.showtrainingmenu', ({ args }) => {
    void world.menu?.({ name: 'Training Menu', actor: runtime.reference(args[0] ?? null) });
    return null;
  });
  n('game.showtitlesequencemenu', () => {
    world.titleSequence?.('show');
    return null;
  });
  n('game.hidetitlesequencemenu', () => {
    world.titleSequence?.('hide');
    return null;
  });
  n('game.starttitlesequence', ({ args }) => {
    world.titleSequence?.('start', str(args[0]));
    return null;
  });
  n('game.playbink', ({ args }) => {
    world.video?.(str(args[0]));
    return null;
  });
  n('game.quittomainmenu', () => {
    void world.menu?.({ name: 'Main Menu' });
    return null;
  });
  n('game.setbeastform', () => null);
  n('game.sendwerewolftransformation', () => null);
  n('game.sethudcartmode', ({ args }) => {
    runtime.hudCartMode = bool(args[0], true);
    return null;
  });
  n('game.setallowflyingmountlandingrequests', () => null);
  n('game.setsittingrotation', () => null);
  n('game.clearprison', () => null);
  n('game.servetime', () => null);
  n('game.cleartempeffects', () => null);
  n('game.setplayerreportcrime', () => null);
  n('game.precachechargen', () => null);
  n('game.precachechargenclear', () => null);
  n('game.requestmodel', () => null);
  n('game.usinggamepad', () => false);
  n('game.addhavokballandsocketconstraint', () => false);
  n('game.removehavokconstraints', () => false);
}
