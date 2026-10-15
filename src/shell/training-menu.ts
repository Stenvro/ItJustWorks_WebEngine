// Training with a trainer (interface\trainingmenu.swf, Game.ShowTrainingMenu from a dialogue's
// script): the card shows the skill the trainer's class teaches (CLAS) with the player's level
// in it, the trainer's tier (Journeyman 50, Expert 75, Master 90: the skill level names), the
// sessions had at this player level of five, the cost and the player's gold. The movie has no
// keys of its own: the engine takes Accept (E, Enter) to train and Cancel (Tab, Esc) to leave,
// as its buttons (Train, Exit) do when clicked. A session raises the skill by one, its gold
// going to the trainer (UESP, "Trainers"); the game's message says why one cannot be had
// (sCanNotTrainAnymore, sCanNotTrainHigher, sInsufficientGoldToTrain). TODO(M11): the skill's
// progress (the meter) and the experience a session gives toward the player's level, the
// skill increase notice and sound.

import { TRAININGS_PER_LEVEL, trainingCost } from '../gameplay/training.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { parseClass, type ClassRecord } from '../world/actor-stats-records.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { GameSettings } from '../world/game-settings.ts';
import type { GameSession } from './game-session.ts';
import { GOLD } from './inventory-menu.ts';
import type { Terminal } from './terminal.ts';

const CARD = '_root.TrainingMenuObj';

/** A trainer's tier by the level its class teaches up to. */
const TIERS: readonly [number, string][] = [
  [90, 'sMasterDisplayName'],
  [75, 'sExpertDisplayName'],
  [50, 'sJourneymanDisplayName'],
  [25, 'sApprenticeDisplayName'],
  [0, 'sNoviceDisplayName'],
];

export class TrainingMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
  }

  /** Opens the menu for a trainer; `closed` once it has closed. Undefined: it teaches nothing. */
  async open(trainer: number, depth: number, closed: () => void): Promise<Menu | undefined> {
    const runtime = this.#session.scriptsReady;
    if (!runtime) return undefined;
    const info = await runtime.actors.info(trainer);
    const classId = info?.traits.class;
    const record = classId === undefined ? undefined : await runtime.forms.record(classId);
    const teaches = record?.type === 'CLAS' ? parseClass(record) : undefined;
    if (teaches?.trainingSkill === undefined) {
      this.#terminal.log('ui', `${trainer.toString(16)} teaches no skill (its class)`, 'warn');
      return undefined;
    }
    const settings = await this.#session.settings();
    let done = false;
    const close = (menu: Menu): void => {
      if (done) return;
      done = true;
      this.#host.close(menu);
      closed();
    };
    const train = (menu: Menu): void => {
      this.#train(menu, runtime, settings, trainer, teaches).catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `no training: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      });
    };
    return this.#host.open('trainingmenu.swf', {
      depth,
      interactive: true,
      onKey: (menu, event) => {
        if (event.repeat) return false;
        if (event.code === 'KeyE' || event.code === 'Enter') {
          train(menu);
          return true;
        }
        if (event.code === 'Tab' || event.code === 'Escape') {
          close(menu);
          return true;
        }
        return false;
      },
      handlers: {
        Train: (menu) => {
          train(menu);
        },
        Exit: (menu) => {
          close(menu);
        },
      },
      setup: async (menu) => {
        await menu.waitFor(`${CARD}.SetPlatform`);
        menu.invoke(`${CARD}.SetPlatform`, 0, false);
        await this.#show(menu, runtime, settings, teaches);
      },
    });
  }

  /** The skill a class teaches, as an actor value. */
  static #skill(teaches: ClassRecord): number {
    return ActorValue.firstSkill + (teaches.trainingSkill ?? 0);
  }

  #sessions(runtime: ScriptRuntime, level: number): number {
    const training = runtime.state.training;
    return training.level === level ? training.sessions : 0;
  }

  #cost(settings: GameSettings, level: number): number {
    return trainingCost(level, {
      multCost: settings.number('fTrainingMultCost') ?? 10,
      expertCost: settings.number('iTrainingExpertCost') ?? 3,
      masterCost: settings.number('iTrainingMasterCost') ?? 5,
    });
  }

  async #show(
    menu: Menu,
    runtime: ScriptRuntime,
    settings: GameSettings,
    teaches: ClassRecord,
  ): Promise<void> {
    const skill = TrainingMenu.#skill(teaches);
    const level = Math.floor((await runtime.actors.value(PLAYER_REF, skill)).base);
    const name = (await runtime.forms.actorValueForm(skill))?.text('FULL') ?? '';
    const tier = TIERS.find(([minimum]) => teaches.maxTrainingLevel >= minimum)?.[1];
    const sessions = this.#sessions(runtime, await runtime.actors.level(PLAYER_REF));
    const set = (field: string, text: string): void => {
      menu.set(`${CARD}.${field}.text`, text);
    };
    set('SkillName', `${name} ${String(level)}`);
    set('TrainerSkill', tier ? (settings.string(tier) ?? '') : '');
    set('TimesTrained', `${String(sessions)}/${String(TRAININGS_PER_LEVEL)}`);
    set('TrainCost', String(this.#cost(settings, level)));
    set('CurrentGold', String(await runtime.itemCount(PLAYER_REF, GOLD)));
  }

  async #train(
    menu: Menu,
    runtime: ScriptRuntime,
    settings: GameSettings,
    trainer: number,
    teaches: ClassRecord,
  ): Promise<void> {
    const skill = TrainingMenu.#skill(teaches);
    const value = await runtime.actors.value(PLAYER_REF, skill);
    const level = Math.floor(value.base);
    const playerLevel = await runtime.actors.level(PLAYER_REF);
    const sessions = this.#sessions(runtime, playerLevel);
    const cost = this.#cost(settings, level);
    const refuse = (setting: string): void => {
      this.#session.hud.notification(settings.string(setting) ?? '');
    };
    if (sessions >= TRAININGS_PER_LEVEL) {
      refuse('sCanNotTrainAnymore');
      return;
    }
    if (level >= teaches.maxTrainingLevel) {
      refuse('sCanNotTrainHigher');
      return;
    }
    if ((await runtime.itemCount(PLAYER_REF, GOLD)) < cost) {
      refuse('sInsufficientGoldToTrain');
      return;
    }
    await runtime.removeItem(PLAYER_REF, runtime.formHandle(GOLD), cost, true, trainer);
    runtime.actors.setBase(PLAYER_REF, skill, value.base + 1);
    runtime.state.training = { level: playerLevel, sessions: sessions + 1 };
    await this.#show(menu, runtime, settings, teaches);
  }
}
