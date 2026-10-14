// The sandbox's quests: the running game's quests one at a time, as the game's console shows
// and drives them (sqv, StartQuest, StopQuest, SetStage, MoveTo a quest target): whether one
// runs, its stage and the stages done, its objectives and who fills their targets, its
// aliases. Starting, stopping and setting stages go through the script runtime, so the
// quest's own scripts run as they do in the game.

import type { QuestAlias, QuestRecord } from '../world/quest-records.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';
import { matches, renderResults } from './finder.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';

export interface QuestPanelUi {
  readonly panel: HTMLDetailsElement;
  readonly search: HTMLInputElement;
  readonly results: HTMLOListElement;
  readonly count: HTMLElement;
  readonly detail: HTMLElement;
}

/** How often the shown quest's state is read again while the panel is open (ms). */
const REFRESH_MS = 1000;

const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What the panel says about a reference or location that fills an alias. */
interface Filler {
  readonly name: string;
  /** Where it is (undefined: nowhere in the world, e.g. an item in an inventory). */
  readonly at: Placement | undefined;
  readonly enabled: boolean;
  readonly dead: boolean;
}

export class QuestPanel {
  readonly #ui: QuestPanelUi;
  readonly #terminal: Terminal;
  #session: GameSession | undefined;
  #quests: QuestRecord[] = [];
  #shown: QuestRecord | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** What the shown quest's state was when it was last drawn (redrawn only on a change). */
  #drawn = '';
  /** Draws in progress: only the latest one is put on screen. */
  #generation = 0;
  /** The result of the last thing done to each quest, in words. */
  readonly #feedback = new Map<number, string>();
  /** Where the player goes to a quest target (the shell's journey, or a MoveTo). */
  onGoTo: ((at: Placement) => void) | undefined;

  constructor(ui: QuestPanelUi, terminal: Terminal) {
    this.#ui = ui;
    this.#terminal = terminal;
    ui.search.addEventListener('input', () => {
      this.#showResults();
    });
    ui.search.addEventListener('keydown', (event) => {
      const first = this.#matches()[0];
      if (event.key === 'Enter' && first) this.#show(first);
    });
    ui.panel.addEventListener('toggle', () => {
      this.#refreshWhileOpen();
    });
  }

  /** Lists the quests once the session's scripts run (a new game has started). */
  async connect(session: GameSession, runtime: Promise<ScriptRuntime>): Promise<void> {
    this.#session = session;
    this.#quests = [];
    this.#shown = undefined;
    this.#feedback.clear();
    this.#ui.detail.hidden = true;
    const scripts = await runtime;
    if (this.#session !== session) return;
    const quests: QuestRecord[] = [];
    for (const formId of scripts.forms.db.formIdsOfType('QUST')) {
      const record = await scripts.forms.quest(formId);
      if (record) quests.push(record);
    }
    if (this.#session !== session) return;
    quests.sort((a, b) => a.editorId.localeCompare(b.editorId));
    this.#quests = quests;
    this.#ui.count.textContent = String(quests.length);
    this.#ui.panel.hidden = false;
    this.#showResults();
  }

  #runtime(): ScriptRuntime | undefined {
    return this.#session?.scriptsReady;
  }

  #matches(): QuestRecord[] {
    return matches(
      this.#quests,
      (quest) => `${quest.editorId} ${quest.name ?? ''} ${hex(quest.formId)}`.toLowerCase(),
      this.#ui.search.value,
    );
  }

  #showResults(): void {
    const runtime = this.#runtime();
    renderResults(
      this.#ui.results,
      this.#matches(),
      (quest) => {
        const running = runtime?.quests.isRunning(quest.formId) === true ? '● ' : '';
        return `${running}${quest.name ? `${quest.name} · ` : ''}${quest.editorId}`;
      },
      (quest) => {
        this.#show(quest);
      },
    );
  }

  #show(quest: QuestRecord): void {
    this.#shown = quest;
    this.#render();
    this.#refreshWhileOpen();
  }

  #refreshWhileOpen(): void {
    const wanted = this.#ui.panel.open && this.#shown !== undefined;
    if (wanted && this.#timer === undefined) {
      this.#timer = setInterval(() => {
        if (this.#signature() !== this.#drawn) this.#render();
      }, REFRESH_MS);
    } else if (!wanted && this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** The shown quest's state in short, to tell whether it changed. */
  #signature(): string {
    const quest = this.#shown;
    const state = quest && this.#runtime()?.state.quests.get(quest.formId);
    const feedback = quest && this.#feedback.get(quest.formId);
    if (!quest || !state) return `${String(quest?.formId)} ${feedback ?? ''}`;
    return JSON.stringify([
      quest.formId,
      feedback,
      state.running,
      state.stage,
      state.completed,
      state.failed,
      [...state.stagesDone],
      [...state.objectives],
      [...state.aliases],
    ]);
  }

  #render(): void {
    this.#drawn = this.#signature();
    const generation = ++this.#generation;
    this.#draw(generation).catch((error: unknown) => {
      this.#terminal.log('quest', describe(error), 'error');
    });
  }

  /** The shown quest's state now: what it is, what was done, objectives, stages, roles. */
  async #draw(generation: number): Promise<void> {
    const quest = this.#shown;
    const runtime = this.#runtime();
    const detail = this.#ui.detail;
    if (!quest || !runtime) {
      detail.hidden = true;
      return;
    }
    const state = runtime.state.quests.get(quest.formId);
    // Who fills each alias, by name, and whether one can go there.
    const fillers = new Map<number, Filler>();
    await Promise.all(
      quest.aliases.map(async (alias) => {
        const filled = state?.aliases.get(alias.id);
        if (filled !== undefined) fillers.set(alias.id, await this.#filler(runtime, alias, filled));
      }),
    );
    if (generation !== this.#generation) return;
    // Keep the scroll positions across redraws.
    const scroll = detail.scrollTop;
    const stageScroll = detail.querySelector('.quest-stages')?.scrollTop ?? 0;
    const running = state?.running === true;

    const head = element('div', 'upgrades-head');
    head.append(
      element('span', '', quest.name ?? quest.editorId),
      button(running ? 'stop quest' : 'start quest', () => {
        if (running) {
          this.#act(quest, 'StopQuest', runtime.quests.stop(quest.formId), () => 'stopped');
        } else {
          this.#act(quest, 'StartQuest', runtime.quests.start(quest.formId), (started) =>
            started
              ? 'started'
              : `did not start: ${runtime.quests.notStarted.get(quest.formId) ?? 'unknown'}`,
          );
        }
      }),
    );
    const status = running
      ? `running · stage ${String(state.stage)}`
      : state?.completed === true
        ? 'completed (not running)'
        : (state?.starts ?? 0) > 0
          ? 'stopped'
          : 'not started';
    const parts: HTMLElement[] = [
      head,
      element(
        'p',
        'quest-status',
        [
          status,
          state?.completed === true && running ? 'completed' : '',
          state?.failed === true ? 'failed' : '',
          quest.editorId,
          hex(quest.formId),
        ]
          .filter((part) => part !== '')
          .join(' · '),
      ),
    ];
    const feedback = this.#feedback.get(quest.formId);
    if (feedback) parts.push(element('p', 'quest-feedback', feedback));

    // The journal's objectives: those the quest shows now, with where their targets are.
    const objectives = quest.objectives.filter(
      (objective) => state?.objectives.get(objective.index)?.displayed === true,
    );
    const objectiveList = element('ul', 'upgrade-list');
    for (const objective of objectives) {
      const done = state?.objectives.get(objective.index);
      const mark = done?.completed === true ? '✓' : done?.failed === true ? '✗' : '•';
      const item = element('li', 'quest-line', `${mark} ${objective.text ?? ''}`);
      for (const target of objective.targets) {
        const filler = fillers.get(target.alias);
        const reference = state?.aliases.get(target.alias);
        if (filler?.at && reference !== PLAYER_REF) item.append(this.#goToButton(filler));
      }
      objectiveList.append(item);
    }
    if (objectives.length === 0) {
      objectiveList.append(element('li', 'quest-line quest-none', 'none shown yet'));
    }
    parts.push(section('journal objectives', objectiveList));

    // Stages: each one's journal text; a click sets it (SetStage).
    if (quest.stages.length > 0) {
      const stages = element('ul', 'upgrade-list quest-stages');
      for (const stage of quest.stages) {
        const done = state?.stagesDone.has(stage.index) === true;
        const text = stage.logEntries.find((entry) => entry.text)?.text;
        const row = element('li', 'quest-line');
        if (running && state.stage === stage.index) row.classList.add('quest-current');
        const set = button(`${done ? '✓' : ' '} ${String(stage.index)}`, () => {
          this.#act(
            quest,
            `SetStage ${String(stage.index)}`,
            runtime.quests.setStage(quest.formId, stage.index),
            (set) =>
              set
                ? `stage ${String(stage.index)} set`
                : runtime.quests.isRunning(quest.formId)
                  ? `stage ${String(stage.index)} was set before (the quest sets a stage once)`
                  : `stage ${String(stage.index)} not set, the quest did not start: ${
                      runtime.quests.notStarted.get(quest.formId) ?? 'unknown'
                    }`,
          );
        });
        set.classList.add('quest-stage');
        set.title = done ? 'done; click to set it again' : 'click to set this stage';
        row.append(set, element('span', text ? '' : 'quest-none', text ?? 'no journal text'));
        stages.append(row);
      }
      parts.push(section('stages · ✓ done · click one to set it', stages));
    }

    // Roles: who or what fills each alias now.
    if (quest.aliases.length > 0) {
      const roles = element('ul', 'upgrade-list quest-aliases');
      for (const alias of quest.aliases) {
        const filler = fillers.get(alias.id);
        const row = element('li', 'quest-line');
        row.append(element('span', 'quest-role', alias.name));
        if (!filler) {
          row.append(element('span', 'quest-none', 'nobody'));
        } else {
          const notes = [
            !filler.enabled ? 'disabled' : '',
            filler.dead ? 'dead' : '',
            !filler.at && !alias.location && state?.aliases.get(alias.id) !== PLAYER_REF
              ? 'not placed in the world'
              : '',
          ].filter((note) => note !== '');
          row.append(
            element(
              'span',
              '',
              `${filler.name}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
            ),
          );
          if (filler.at && state?.aliases.get(alias.id) !== PLAYER_REF && !alias.location) {
            row.append(this.#goToButton(filler));
          }
        }
        roles.append(row);
      }
      parts.push(section('roles (aliases)', roles));
    }

    detail.replaceChildren(...parts);
    detail.hidden = false;
    detail.scrollTop = scroll;
    const list = detail.querySelector('.quest-stages');
    if (list) list.scrollTop = stageScroll;
  }

  async #filler(runtime: ScriptRuntime, alias: QuestAlias, filled: number): Promise<Filler> {
    if (alias.location) {
      const record = await runtime.forms.record(filled);
      return {
        name: record?.text('FULL') ?? record?.editorId ?? hex(filled),
        at: undefined,
        enabled: true,
        dead: false,
      };
    }
    if (filled === PLAYER_REF)
      return { name: 'the player', at: undefined, enabled: true, dead: false };
    const [record, base, at, enabled, dead] = await Promise.all([
      runtime.forms.record(filled),
      runtime
        .baseOf(filled)
        .then((id) => (id === undefined ? undefined : runtime.forms.record(id))),
      runtime.placement(filled),
      runtime.isEnabled(filled),
      runtime.actors.isDead(filled).catch(() => false),
    ]);
    const name = base?.text('FULL') ?? record?.editorId ?? base?.editorId ?? hex(filled);
    return { name, at, enabled, dead };
  }

  #goToButton(filler: Filler): HTMLButtonElement {
    const go = button(`go to ${filler.name}`, () => {
      if (!filler.at) return;
      this.#log(`player.moveto ${filler.name}`);
      this.onGoTo?.(filler.at);
    });
    go.title = filler.enabled ? 'MoveTo: the player goes there' : 'it is disabled: nothing to see';
    return go;
  }

  /** Runs a console action on the quest: logs it and shows what came of it in words. */
  #act<T>(quest: QuestRecord, what: string, done: Promise<T>, result: (value: T) => string): void {
    this.#log(`${what} ${quest.editorId}`);
    this.#feedback.set(quest.formId, `${what}…`);
    this.#render();
    done
      .then((value) => {
        const text = result(value);
        this.#feedback.set(quest.formId, `${what}: ${text}`);
        this.#log(`${quest.editorId}: ${text}`);
      })
      .catch((error: unknown) => {
        this.#feedback.set(quest.formId, `${what} failed: ${describe(error)}`);
        this.#terminal.log('quest', describe(error), 'error');
      })
      .finally(() => {
        this.#render();
        this.#showResults();
      });
  }

  #log(text: string): void {
    this.#terminal.log('quest', text);
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, click: () => void): HTMLButtonElement {
  const node = element('button', 'preset', label);
  node.type = 'button';
  node.addEventListener('click', click);
  return node;
}

function section(title: string, body: HTMLElement): HTMLElement {
  const wrap = element('div', 'quest-section');
  wrap.append(element('div', 'quest-section-head', title), body);
  return wrap;
}
