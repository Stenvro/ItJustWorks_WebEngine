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
  // A script's increment is not told to the tracked stats' listeners (the engine's own are).
  n('game.incrementstat', ({ args }) => {
    runtime.incrementStat(str(args[0]), int(args[1], 1), false);
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
  n('game.teachword', async ({ args }) => {
    const word = formOf(args[0]);
    if (word !== undefined) await runtime.casting.teachWord(word);
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
  // ShakeCamera(akSource, afStrength = 0.5, afDuration = 0.0): observed in the original, the
  // strength is kept within 0 and 1 and the shake starts at the source (none: the player).
  n('game.shakecamera', ({ args }) => {
    const strength = Math.min(1, Math.max(0, num(args[1], 0.5)));
    world.shakeCamera?.(strength, num(args[2], 0), runtime.reference(args[0] ?? null));
    return null;
  });
  // ShakeController(afSmallMotorStrength, afBigMotorStrength, afDuration): the gamepad's motors,
  // each strength kept within 0 and 1.
  n('game.shakecontroller', ({ args }) => {
    const unit = (value: number): number => Math.min(1, Math.max(0, value));
    world.shakeController?.(
      unit(num(args[0], 0)),
      unit(num(args[1], 0)),
      Math.max(0, num(args[2], 0)),
    );
    return null;
  });
  n('game.setcameratarget', () => null);
  // TriggerScreenBlood(aiValue): that many splatters of blood on the screen.
  n('game.triggerscreenblood', ({ args }) => {
    world.screenBlood?.(Math.max(0, Math.floor(num(args[0], 0))));
    return null;
  });
  // SetSunGazeImageSpaceModifier(akImod): what the player's gaze at the sun applies (None: nothing);
  // IsPlayerSunGazing: whether they gaze at it now (src/gameplay/sun-gaze.ts).
  n('game.setsungazeimagespacemodifier', ({ args }) => {
    const modifier = formOf(args[0]);
    runtime.sunGazeModifier = modifier === 0 ? undefined : modifier;
    return null;
  });
  n('game.isplayersungazing', () => runtime.sunGaze.gazing);
  for (const axis of ['x', 'y', 'z'] as const)
    n(
      `game.getsunposition${axis}`,
      () => runtime.sunPosition()[axis === 'x' ? 0 : axis === 'y' ? 1 : 2],
    );
  n('game.getplayergrabbedref', () => runtime.referenceHandleOrNone(world.grabbed?.()));
  n('game.getplayerslastriddenhorse', () => object(runtime.lastHorse, 'actor'));
  // RequestSave / RequestAutoSave: observed in the original, both only queue a task with the
  // save manager (a save, an autosave), which makes it once the game may save.
  n('game.requestsave', () => {
    world.requestSave?.('save');
    return null;
  });
  n('game.requestautosave', () => {
    world.requestSave?.('autosave');
    return null;
  });
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
  // SetBeastForm: the player is a werewolf or a vampire lord from now on (the menus it shuts).
  n('game.setbeastform', ({ args }) => {
    runtime.beastForm = bool(args[0]);
    return null;
  });
  // ShowFirstPersonGeometry: the first-person arms and weapon drawn or not
  // (src/shell/first-person-body.ts).
  n('game.showfirstpersongeometry', ({ args }) => {
    runtime.firstPersonGeometry = bool(args[0], true);
    return null;
  });
  // SendWereWolfTransformation: the player changed into a werewolf: a crime where it is seen
  // (iCrimeGoldWerewolf, the WereTransformCrime lines: crime-engine.ts werewolf).
  n('game.sendwerewolftransformation', async () => {
    await runtime.crime.werewolf(PLAYER_REF);
    return null;
  });
  n('game.sethudcartmode', ({ args }) => {
    runtime.hudCartMode = bool(args[0], true);
    return null;
  });
  // SetAllowFlyingMountLandingRequests: whether a dragon the player rides lands when asked
  // (src/shell/dragon-riding.ts).
  n('game.setallowflyingmountlandingrequests', ({ args }) => {
    runtime.flyingMountLandingAllowed = bool(args[0], true);
    return null;
  });
  n('game.setsittingrotation', () => null);
  // ClearPrison: the player is no longer held in jail.
  n('game.clearprison', () => {
    delete runtime.state.crime.jail;
    return null;
  });
  // ServeTime: the player serves their jail time (the jail's bed: JailBedScript).
  n('game.servetime', async () => {
    await runtime.crime.serveTime();
    return null;
  });
  // ClearTempEffects: the temporary effects in the world go at once (the hits' decals).
  n('game.cleartempeffects', () => {
    world.clearTempEffects?.();
    return null;
  });
  // SetPlayerReportCrime(abReportCrime): whether crimes against the player are reported.
  n('game.setplayerreportcrime', ({ args }) => {
    runtime.state.crime.reportCrimeAgainstPlayer = bool(args[0], true);
    return null;
  });
  n('game.precachechargen', () => null);
  n('game.precachechargenclear', () => null);
  n('game.requestmodel', () => null);
  n('game.usinggamepad', () => false);
  // AddHavokBallAndSocketConstraint(arRefA, arRefANode, arRefB, arRefBNode, A's local offset
  // x y z, B's x y z): the world's physics joins the two (hanged corpses, hanging keys).
  n('game.addhavokballandsocketconstraint', ({ args }) => {
    const a = formOf(args[0]);
    const b = formOf(args[2]);
    if (a === undefined || b === undefined) return false;
    return (
      runtime.world.ballAndSocket?.(
        a,
        str(args[1]),
        b,
        str(args[3]),
        [num(args[4]), num(args[5]), num(args[6])],
        [num(args[7]), num(args[8]), num(args[9])],
      ) ?? false
    );
  });
  // RemoveHavokConstraints(arFirstRef, arFirstRefNodeName, arSecondRef, arSecondRefNodeName).
  n('game.removehavokconstraints', ({ args }) => {
    const a = formOf(args[0]);
    const b = formOf(args[2]);
    if (a === undefined || b === undefined) return false;
    return runtime.world.removeConstraints?.(a, str(args[1]), b, str(args[3])) ?? false;
  });
}
