// Natives of Utility, Debug, Math, Form, GlobalVariable, FormList, Keyword and Message
// (signatures: the game's own declarations in Utility.pex, Debug.pex, ...).
// Platform-independent. Notes: docs/scripting.md ("Natives").

import { formatValue } from '../../values.ts';
import { globalValue } from '../condition-values.ts';
import type { ScriptRuntime } from '../runtime.ts';
import { bool, formOf, int, num, object, str, type Register } from './args.ts';

const DEG = 180 / Math.PI;

export function registerCore(n: Register, runtime: ScriptRuntime): void {
  const { state, forms } = runtime;

  // --- Utility ---------------------------------------------------------------------------
  n('utility.wait', ({ args, latent, vm }) =>
    latent(vm.scheduler.waitReal(num(args[0]))).then(() => null),
  );
  // In menus the game's clocks stand still (Wait waits on); WaitMenuMode counts menus too.
  n('utility.waitmenumode', ({ args, latent, vm }) =>
    latent(vm.scheduler.waitWall(num(args[0]))).then(() => null),
  );
  n('utility.waitgametime', ({ args, latent, vm }) =>
    latent(vm.scheduler.waitGame(num(args[0]))).then(() => null),
  );
  n('utility.randomint', ({ args }) => {
    const min = int(args[0], 0);
    const max = int(args[1], 100);
    return min + Math.floor(Math.random() * (Math.max(min, max) - min + 1));
  });
  n('utility.randomfloat', ({ args }) => {
    const min = num(args[0], 0);
    const max = num(args[1], 1);
    return min + Math.random() * (max - min);
  });
  n('utility.getcurrentrealtime', () => state.realTime);
  n('utility.getcurrentgametime', () => state.gameDaysPassed);
  n('utility.isinmenumode', () => runtime.inMenuMode);
  n('utility.gametimetostring', ({ args }) => runtime.gameTimeString(num(args[0])));
  n('utility.getcurrentmemory', () => 0);
  n('utility.getbudgetcount', () => 0);
  n('utility.getcurrentbudget', () => 0);
  n('utility.overbudget', () => false);
  n('utility.getbudgetname', () => '');
  n('utility.getaverageframerate', () => runtime.frameRate);
  n('utility.getminframerate', () => runtime.frameRate);
  n('utility.getmaxframerate', () => runtime.frameRate);
  n('utility.captureframerate', () => '');
  n('utility.startframeratecapture', () => null);
  n('utility.endframeratecapture', () => null);
  // INI settings scripts set (none in vanilla gameplay); kept with the game's.
  for (const kind of ['int', 'bool', 'float', 'string']) {
    n(`utility.setini${kind}`, ({ args }) => {
      runtime.iniOverrides.set(str(args[0]).toLowerCase(), args[1] ?? null);
      return null;
    });
  }

  // --- Debug -------------------------------------------------------------------------------
  // The Papyrus log (Papyrus.0.log): kept for tools; the game writes it only when enabled.
  for (const name of ['trace', 'tracestack']) {
    n(`debug.${name}`, ({ args }) => {
      runtime.log(str(args[0]));
      return null;
    });
  }
  n('debug.traceuser', ({ args }) => {
    runtime.log(`${str(args[0])}: ${str(args[1])}`);
    return true;
  });
  n('debug.openuserlog', () => true);
  n('debug.closeuserlog', () => null);
  n('debug.notification', ({ args }) => {
    const text = str(args[0]);
    state.messages.push(text);
    runtime.world.notification?.(text);
    return null;
  });
  n('debug.messagebox', ({ args }) => {
    const text = str(args[0]);
    state.messages.push(text);
    const shown = runtime.world.messageBox?.(text);
    if (shown) runtime.detach(shown);
    return null;
  });
  n('debug.sendanimationevent', ({ args }) => {
    const reference = runtime.reference(args[0] ?? null);
    if (reference !== undefined) runtime.world.animationEvent?.(reference, str(args[1]));
    return null;
  });
  n('debug.getplatformname', () => 'PC');
  n('debug.getversionnumber', () => '1.6.1170.0');
  n('debug.getconfigname', () => 'Final');
  // Console and profiling helpers: nothing to do in the game a player plays.
  for (const name of [
    'dumpaliasdata',
    'dbsendplayerposition',
    'showrefposition',
    'togglecollisions',
    'togglemenus',
    'toggleai',
    'setfootik',
    'startscriptprofiling',
    'stopscriptprofiling',
    'startstackprofiling',
    'stopstackprofiling',
    'takescreenshot',
    'debugchannelnotify',
    'quitgame',
    'centeroncell',
  ]) {
    n(`debug.${name}`, () => null);
  }
  // The console's tgm (src/scripting/runtime/actor-engine.ts: the player takes no damage).
  n('debug.setgodmode', ({ args }) => {
    runtime.godMode = bool(args[0]);
    return null;
  });
  n('debug.centeroncellandwait', () => 0);
  n('debug.playermovetoandwait', () => 0);

  // --- Math --------------------------------------------------------------------------------
  n('math.abs', ({ args }) => Math.abs(num(args[0])));
  n('math.floor', ({ args }) => Math.floor(num(args[0])));
  n('math.ceiling', ({ args }) => Math.ceil(num(args[0])));
  n('math.pow', ({ args }) => Math.pow(num(args[0]), num(args[1])));
  n('math.sqrt', ({ args }) => Math.sqrt(Math.max(0, num(args[0]))));
  // Papyrus' trigonometry works in degrees.
  n('math.sin', ({ args }) => Math.sin(num(args[0]) / DEG));
  n('math.cos', ({ args }) => Math.cos(num(args[0]) / DEG));
  n('math.tan', ({ args }) => Math.tan(num(args[0]) / DEG));
  n('math.asin', ({ args }) => Math.asin(num(args[0])) * DEG);
  n('math.acos', ({ args }) => Math.acos(num(args[0])) * DEG);
  n('math.atan', ({ args }) => Math.atan(num(args[0])) * DEG);
  n('math.degreestoradians', ({ args }) => num(args[0]) / DEG);
  n('math.radianstodegrees', ({ args }) => num(args[0]) * DEG);

  // --- Form --------------------------------------------------------------------------------
  n('form.getformid', ({ self }) => (self ? self.formId | 0 : 0));
  n('form.getgoldvalue', async ({ self }) => (self ? runtime.goldValue(self.formId) : 0));
  n('form.haskeyword', async ({ self, args }) => {
    const keyword = formOf(args[0]);
    return self !== null && keyword !== undefined && runtime.hasKeyword(self.formId, keyword);
  });
  n('form.playerknows', ({ self }) => (self ? runtime.playerKnows(self.formId) : false));
  n('form.registerforupdate', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), false, true),
  );
  n('form.registerforsingleupdate', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), false, false),
  );
  n('form.registerforupdategametime', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), true, true),
  );
  n('form.registerforsingleupdategametime', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), true, false),
  );
  n('form.unregisterforupdate', ({ self }) => runtime.unregisterUpdate(self, false));
  n('form.unregisterforupdategametime', ({ self }) => runtime.unregisterUpdate(self, true));
  n('form.registerforanimationevent', ({ self, args }) =>
    runtime.registerAnimationEvent(self, args[0] ?? null, str(args[1]), true),
  );
  n('form.unregisterforanimationevent', ({ self, args }) =>
    runtime.registerAnimationEvent(self, args[0] ?? null, str(args[1]), false),
  );
  n('form.registerforsleep', ({ self }) => runtime.registerFor('sleep', self, true));
  n('form.unregisterforsleep', ({ self }) => runtime.registerFor('sleep', self, false));
  n('form.registerfortrackedstatsevent', ({ self }) =>
    runtime.registerFor('trackedstats', self, true),
  );
  n('form.unregisterfortrackedstatsevent', ({ self }) =>
    runtime.registerFor('trackedstats', self, false),
  );
  // Line of sight: detection tells when it is gained or lost (src/shell/actor-senses.ts).
  for (const name of [
    'registerforlos',
    'registerforsinglelosgain',
    'registerforsingleloslost',
    'unregisterforlos',
  ]) {
    n(`form.${name}`, ({ self, args }) =>
      runtime.registerLineOfSight(self, args[0] ?? null, args[1] ?? null, name),
    );
  }
  n('form.startobjectprofiling', () => null);
  n('form.stopobjectprofiling', () => null);

  // --- GlobalVariable ------------------------------------------------------------------------
  n('globalvariable.getvalue', async ({ self }) => (self ? globalValue(runtime, self.formId) : 0));
  n('globalvariable.setvalue', async ({ self, args }) => {
    if (!self) return null;
    // Constant globals (GLOB record flag 0x40) keep their value.
    const record = await forms.record(self.formId);
    if (record && (record.flags & 0x40) !== 0) {
      runtime.vm.warn(`${record.editorId ?? formatValue(self)}: a constant global was set`);
      return null;
    }
    // The clock's globals move the clock.
    if (!runtime.setClockGlobal(self.formId, num(args[0])))
      state.globals.set(self.formId, num(args[0]));
    return null;
  });

  // --- FormList ----------------------------------------------------------------------------
  n('formlist.getsize', async ({ self }) =>
    self ? (await runtime.formList(self.formId)).length : 0,
  );
  n('formlist.getat', async ({ self, args }) => {
    const items = self ? await runtime.formList(self.formId) : [];
    return object(items[int(args[0])], 'form');
  });
  n('formlist.find', async ({ self, args }) => {
    const form = formOf(args[0]);
    return self && form !== undefined ? (await runtime.formList(self.formId)).indexOf(form) : -1;
  });
  n('formlist.hasform', async ({ self, args }) => {
    const form = formOf(args[0]);
    return (
      self !== null && form !== undefined && (await runtime.formList(self.formId)).includes(form)
    );
  });
  n('formlist.addform', ({ self, args }) => {
    const form = formOf(args[0]);
    if (self && form !== undefined) runtime.formListAdd(self.formId, form);
    return null;
  });
  n('formlist.removeaddedform', ({ self, args }) => {
    const form = formOf(args[0]);
    if (self && form !== undefined) runtime.formListRemove(self.formId, form);
    return null;
  });
  n('formlist.revert', ({ self }) => {
    if (self) runtime.formListRevert(self.formId);
    return null;
  });

  // --- Keyword (story manager events) ---------------------------------------------------------
  n('keyword.sendstoryevent', ({ self, args }) => {
    if (self) runtime.detach(runtime.storyEvent(self.formId, args));
    return null;
  });
  n('keyword.sendstoryeventandwait', async ({ self, args, latent }) =>
    self ? latent(runtime.storyEvent(self.formId, args)) : false,
  );

  // --- Message -------------------------------------------------------------------------------
  n('message.show', async ({ self, args, latent }) =>
    self
      ? latent(
          runtime.showMessage(
            self.formId,
            args.map((a) => num(a)),
          ),
        )
      : 0,
  );
  n('message.showashelpmessage', async ({ self, args }) => {
    if (self)
      await runtime.showHelpMessage(
        self.formId,
        str(args[0]),
        num(args[1]),
        num(args[2]),
        int(args[3]),
      );
    return null;
  });
  n('message.resethelpmessage', ({ args }) => {
    runtime.resetHelpMessage(str(args[0]));
    return null;
  });
}
