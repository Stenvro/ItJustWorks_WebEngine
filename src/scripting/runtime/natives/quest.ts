// Natives of Quest, Alias, ReferenceAlias, LocationAlias, Scene, TopicInfo, Package and Topic.
// A quest's objectives: displaying one starts the quest (the Creation Kit: quests without an
// event start with Start, SetStage or SetObjectiveDisplayed). Platform-independent.
// Notes: docs/scripting.md ("Quests").

import { GroupType } from '../../../formats/esm/record.ts';
import { ObjectHandle } from '../../values.ts';
import type { ScriptRuntime } from '../runtime.ts';
import { bool, formOf, int, num, object, str, type Register } from './args.ts';

export function registerQuest(n: Register, runtime: ScriptRuntime): void {
  const { state, forms, quests } = runtime;

  // --- Quest ---------------------------------------------------------------------------
  n('quest.start', ({ self, latent }) => (self ? latent(quests.start(self.formId)) : false));
  n('quest.stop', async ({ self, latent }) => {
    if (self) await latent(quests.stop(self.formId));
    return null;
  });
  n('quest.reset', async ({ self, latent }) => {
    if (self) await latent(quests.reset(self.formId));
    return null;
  });
  // The caller waits for the stage's fragment (unlocked meanwhile).
  n('quest.setcurrentstageid', ({ self, args, latent }) =>
    self ? latent(quests.setStage(self.formId, int(args[0]))) : false,
  );
  n('quest.getcurrentstageid', ({ self }) =>
    self ? (state.quests.get(self.formId)?.stage ?? 0) : 0,
  );
  n('quest.isstagedone', ({ self, args }) =>
    self ? (state.quests.get(self.formId)?.stagesDone.has(int(args[0])) ?? false) : false,
  );
  n('quest.isrunning', ({ self }) => (self ? quests.isRunning(self.formId) : false));
  n('quest.isstopped', ({ self }) => (self ? !quests.isRunning(self.formId) : true));
  // Starting and stopping complete within the call here.
  n('quest.isstarting', () => false);
  n('quest.isstopping', () => false);
  n('quest.iscompleted', ({ self }) =>
    self ? (state.quests.get(self.formId)?.completed ?? false) : false,
  );
  n('quest.completequest', ({ self }) => {
    if (self) quests.complete(self.formId);
    return null;
  });
  n('quest.isactive', ({ self }) =>
    self ? (state.quests.get(self.formId)?.active ?? false) : false,
  );
  n('quest.setactive', ({ self, args }) => {
    if (self) state.quest(self.formId).active = bool(args[0], true);
    return null;
  });
  const objective = (quest: number, index: number) => {
    const objectives = state.quest(quest).objectives;
    let entry = objectives.get(index);
    if (!entry) {
      entry = { displayed: false, completed: false, failed: false };
      objectives.set(index, entry);
    }
    return entry;
  };
  n('quest.setobjectivedisplayed', async ({ self, args, latent }) => {
    if (!self) return null;
    // Displaying an objective starts the quest.
    if (!quests.isRunning(self.formId)) await latent(quests.start(self.formId));
    const index = int(args[0]);
    // The quest's first objective shown announces it (abForce shows one shown before again).
    const first = ![...state.quest(self.formId).objectives.values()].some((o) => o.displayed);
    const entry = objective(self.formId, index);
    const displayed = bool(args[1], true);
    if (displayed && (!entry.displayed || bool(args[2]))) {
      runtime.questUpdated(self.formId, 'shown', index, first);
      state.quest(self.formId).updated = ++state.questClock;
      entry.shown = state.questClock;
    }
    entry.displayed = displayed;
    return null;
  });
  // A shown objective's completion and failure are announced too.
  const finish = (quest: number, index: number, status: 'completed' | 'failed', on: boolean) => {
    const entry = objective(quest, index);
    if (on && !entry[status] && entry.displayed) runtime.questUpdated(quest, status, index);
    entry[status] = on;
  };
  n('quest.setobjectivecompleted', ({ self, args }) => {
    if (self) finish(self.formId, int(args[0]), 'completed', bool(args[1], true));
    return null;
  });
  n('quest.setobjectivefailed', ({ self, args }) => {
    if (self) finish(self.formId, int(args[0]), 'failed', bool(args[1], true));
    return null;
  });
  n('quest.isobjectivedisplayed', ({ self, args }) =>
    self
      ? (state.quests.get(self.formId)?.objectives.get(int(args[0]))?.displayed ?? false)
      : false,
  );
  n('quest.isobjectivecompleted', ({ self, args }) =>
    self
      ? (state.quests.get(self.formId)?.objectives.get(int(args[0]))?.completed ?? false)
      : false,
  );
  n('quest.isobjectivefailed', ({ self, args }) =>
    self ? (state.quests.get(self.formId)?.objectives.get(int(args[0]))?.failed ?? false) : false,
  );
  n('quest.completeallobjectives', ({ self }) => {
    for (const [index, entry] of self ? state.quest(self.formId).objectives : []) {
      if (self && entry.displayed) finish(self.formId, index, 'completed', true);
    }
    return null;
  });
  n('quest.failallobjectives', ({ self }) => {
    for (const [index, entry] of self ? state.quest(self.formId).objectives : []) {
      if (self && entry.displayed) finish(self.formId, index, 'failed', true);
    }
    return null;
  });
  n('quest.getalias', async ({ self, args }) => {
    if (!self) return null;
    const alias = await forms.alias(self.formId, int(args[0]));
    return alias ? quests.aliasHandle(self.formId, alias.id, alias.location) : null;
  });
  // The quest's text replacement of a global (<Global=...> in journal and dialogue text).
  n('quest.updatecurrentinstanceglobal', () => true);

  // --- Alias ---------------------------------------------------------------------------
  n('alias.getowningquest', ({ self }) => (self ? new ObjectHandle(self.formId, 'quest') : null));
  n('alias.registerforupdate', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), false, true),
  );
  n('alias.registerforsingleupdate', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), false, false),
  );
  n('alias.registerforupdategametime', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), true, true),
  );
  n('alias.registerforsingleupdategametime', ({ self, args }) =>
    runtime.registerUpdate(self, num(args[0]), true, false),
  );
  n('alias.unregisterforupdate', ({ self }) => runtime.unregisterUpdate(self, false));
  n('alias.unregisterforupdategametime', ({ self }) => runtime.unregisterUpdate(self, true));
  n('alias.registerforanimationevent', ({ self, args }) =>
    runtime.registerAnimationEvent(self, args[0] ?? null, str(args[1]), true),
  );
  n('alias.unregisterforanimationevent', ({ self, args }) =>
    runtime.registerAnimationEvent(self, args[0] ?? null, str(args[1]), false),
  );
  n('alias.registerforsleep', ({ self }) => runtime.registerFor('sleep', self, true));
  n('alias.unregisterforsleep', ({ self }) => runtime.registerFor('sleep', self, false));
  n('alias.registerfortrackedstatsevent', ({ self }) =>
    runtime.registerFor('trackedstats', self, true),
  );
  n('alias.unregisterfortrackedstatsevent', ({ self }) =>
    runtime.registerFor('trackedstats', self, false),
  );
  for (const name of [
    'registerforlos',
    'registerforsinglelosgain',
    'registerforsingleloslost',
    'unregisterforlos',
  ]) {
    n(`alias.${name}`, ({ self, args }) =>
      runtime.registerLineOfSight(self, args[0] ?? null, args[1] ?? null, name),
    );
  }
  n('alias.startobjectprofiling', () => null);
  n('alias.stopobjectprofiling', () => null);

  // --- ReferenceAlias / LocationAlias --------------------------------------------------
  const filled = (self: ObjectHandle | null): number | undefined =>
    self ? state.quests.get(self.formId)?.aliases.get(self.alias) : undefined;
  n('referencealias.getreference', ({ self }) => {
    const reference = filled(self);
    return reference === undefined ? null : runtime.referenceHandle(reference);
  });
  n('referencealias.forcerefto', ({ self, args }) => {
    const reference = runtime.reference(args[0] ?? null);
    if (self && reference !== undefined) runtime.forceAlias(self.formId, self.alias, reference);
    return null;
  });
  n('referencealias.clear', ({ self }) => {
    if (self) runtime.clearAlias(self.formId, self.alias);
    return null;
  });
  n('referencealias.addinventoryeventfilter', ({ self, args }) =>
    runtime.inventoryFilter(self, formOf(args[0]), 'add'),
  );
  n('referencealias.removeinventoryeventfilter', ({ self, args }) =>
    runtime.inventoryFilter(self, formOf(args[0]), 'remove'),
  );
  n('referencealias.removeallinventoryeventfilters', ({ self }) =>
    runtime.inventoryFilter(self, undefined, 'clear'),
  );
  n('locationalias.getlocation', ({ self }) => object(filled(self), 'location'));
  n('locationalias.forcelocationto', ({ self, args }) => {
    const location = formOf(args[0]);
    if (self && location !== undefined) runtime.forceAlias(self.formId, self.alias, location);
    return null;
  });
  n('locationalias.clear', ({ self }) => {
    if (self) runtime.clearAlias(self.formId, self.alias);
    return null;
  });

  // --- Owning quests -------------------------------------------------------------------
  n('topicinfo.getowningquest', async ({ self }) => {
    if (!self) return null;
    const location = forms.db.locate(self.formId);
    const group = location && forms.db.parentGroup(location);
    if (group?.type !== GroupType.topicChildren) return null;
    return object((await forms.record(group.label))?.formIdField('QNAM'), 'quest');
  });
  n('scene.getowningquest', async ({ self }) =>
    self ? object((await forms.record(self.formId))?.formIdField('PNAM'), 'quest') : null,
  );
  n('package.getowningquest', async ({ self }) =>
    self ? object((await forms.record(self.formId))?.formIdField('QNAM'), 'quest') : null,
  );
  n('package.gettemplate', async ({ self }) => {
    const pkcu = self ? (await forms.record(self.formId))?.fields.first('PKCU') : undefined;
    const record = self ? await forms.record(self.formId) : undefined;
    return pkcu && record && pkcu.length >= 8 ? object(record.formIdAt(pkcu, 4), 'package') : null;
  });

  // --- Scenes (TODO(M10): scenes play: their actors' packages and dialogue) -------------
  n('scene.start', ({ self }) => {
    if (self) runtime.sceneStart(self.formId);
    return null;
  });
  // TODO(M10): ForceStart takes its actors out of the scenes they play in.
  n('scene.forcestart', ({ self }) => {
    if (self) runtime.sceneStart(self.formId);
    return null;
  });
  n('scene.stop', ({ self }) => {
    if (self) runtime.sceneStop(self.formId);
    return null;
  });
  n('scene.isplaying', ({ self }) => (self ? runtime.scenePlaying(self.formId) : false));
  n('scene.isactioncomplete', () => false);
  // A topic added to the player's dialogue (TODO(M9): the dialogue menu).
  n('topic.add', () => null);
}
