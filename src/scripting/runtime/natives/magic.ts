// Natives of ActiveMagicEffect: an effect active on an actor (its scripts get the effect's
// events; it registers for updates, animation events and the like as forms do), its base
// effect, target and caster. Platform-independent. Notes: docs/scripting.md ("Natives").

import type { ScriptRuntime } from '../runtime.ts';
import { formOf, num, object, str, type Register } from './args.ts';

export function registerMagic(n: Register, runtime: ScriptRuntime): void {
  // The effect as its scripts see it: on its actor, or ending while OnEffectFinish runs.
  const effect = (self: { key: string } | null) =>
    self ? runtime.magic.scriptEffect(self.key) : undefined;
  n('activemagiceffect.getbaseobject', ({ self }) => object(effect(self)?.effect, 'magiceffect'));
  n('activemagiceffect.gettargetactor', ({ self }) =>
    runtime.actorHandleOrNone(effect(self)?.target),
  );
  n('activemagiceffect.getcasteractor', ({ self }) =>
    runtime.actorHandleOrNone(effect(self)?.caster),
  );
  n('activemagiceffect.dispel', ({ self }) => {
    if (self) runtime.detach(runtime.magic.dispel(self.key));
    return null;
  });
  n('activemagiceffect.registerforupdate', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), false, true),
  );
  n('activemagiceffect.registerforsingleupdate', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), false, false),
  );
  n('activemagiceffect.registerforupdategametime', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), true, true),
  );
  n('activemagiceffect.registerforsingleupdategametime', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), true, false),
  );
  n('activemagiceffect.unregisterforupdate', ({ self }) => runtime.unregisterUpdate(self, false));
  n('activemagiceffect.unregisterforupdategametime', ({ self }) =>
    runtime.unregisterUpdate(self, true),
  );
  n('activemagiceffect.registerforanimationevent', ({ self, args }) =>
    runtime.registerAnimationEvent(self, args[0] ?? null, str(args[1]), true),
  );
  n('activemagiceffect.unregisterforanimationevent', ({ self, args }) =>
    runtime.registerAnimationEvent(self, args[0] ?? null, str(args[1]), false),
  );
  n('activemagiceffect.registerforsleep', ({ self }) => runtime.registerFor('sleep', self, true));
  n('activemagiceffect.unregisterforsleep', ({ self }) =>
    runtime.registerFor('sleep', self, false),
  );
  n('activemagiceffect.registerfortrackedstatsevent', ({ self }) =>
    runtime.registerFor('trackedstats', self, true),
  );
  n('activemagiceffect.unregisterfortrackedstatsevent', ({ self }) =>
    runtime.registerFor('trackedstats', self, false),
  );
  for (const name of [
    'registerforlos',
    'registerforsinglelosgain',
    'registerforsingleloslost',
    'unregisterforlos',
  ]) {
    n(`activemagiceffect.${name}`, ({ self, args }) =>
      runtime.registerLineOfSight(self, args[0] ?? null, args[1] ?? null, name),
    );
  }
  n('activemagiceffect.addinventoryeventfilter', ({ self, args }) =>
    runtime.inventoryFilter(self, formOf(args[0]), 'add'),
  );
  n('activemagiceffect.removeinventoryeventfilter', ({ self, args }) =>
    runtime.inventoryFilter(self, formOf(args[0]), 'remove'),
  );
  n('activemagiceffect.removeallinventoryeventfilters', ({ self }) =>
    runtime.inventoryFilter(self, undefined, 'clear'),
  );
  n('activemagiceffect.startobjectprofiling', () => null);
  n('activemagiceffect.stopobjectprofiling', () => null);
}
