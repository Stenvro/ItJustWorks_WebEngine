// The sandbox's quests: the running game's quests one at a time, as the game's console shows
// and drives them (sqv, StartQuest, StopQuest, SetStage, MoveTo a quest target): whether one
// runs, its stage and the stages done, its objectives and who fills their targets, its
// aliases. Starting, stopping and setting stages go through the script runtime, so the
// quest's own scripts run as they do in the game.

import type { QuestRecord } from '../world/quest-records.ts';
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

export class QuestPanel {
  readonly #ui: QuestPanelUi;
  readonly #terminal: Terminal;
  #session: GameSession | undefined;
  #quests: QuestRecord[] = [];
  #shown: QuestRecord | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** What the shown quest's state was when it was last drawn (redrawn only on a change). */
  #drawn = '';
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
        return `${running}${quest.editorId}${quest.name ? ` · ${quest.name}` : ''}`;
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
    if (!quest || !state) return String(quest?.formId);
    return JSON.stringify([
      quest.formId,
      state.running,
      state.stage,
      state.completed,
      state.failed,
      [...state.stagesDone],
      [...state.objectives],
      [...state.aliases],
    ]);
  }

  /** The shown quest's state now: header, actions, objectives, stages, aliases. */
  #render(): void {
    this.#drawn = this.#signature();
    const quest = this.#shown;
    const runtime = this.#runtime();
    const detail = this.#ui.detail;
    if (!quest || !runtime) {
      detail.hidden = true;
      return;
    }
    // Keep the scroll position of the stage list across refreshes.
    const scroll = detail.querySelector('.quest-stages')?.scrollTop ?? 0;
    const state = runtime.state.quests.get(quest.formId);
    const running = state?.running === true;
    const head = element('div', 'upgrades-head');
    head.append(
      element('span', '', `${quest.editorId}${quest.name ? ` · ${quest.name}` : ''}`),
      button(running ? 'stop' : 'start', () => {
        this.#act(
          running ? 'StopQuest' : 'StartQuest',
          quest,
          running
            ? runtime.quests.stop(quest.formId)
            : runtime.quests.start(quest.formId).then((started) => {
                if (!started) this.#log(`${quest.editorId} does not start (its conditions)`);
              }),
        );
      }),
    );
    const status = [
      running ? `running · stage ${String(state.stage)}` : 'not running',
      state?.completed === true ? 'completed' : '',
      state?.failed === true ? 'failed' : '',
      `priority ${String(quest.priority)}`,
      hex(quest.formId),
    ].filter((part) => part !== '');
    const parts: HTMLElement[] = [head, element('p', 'quest-status', status.join(' · '))];

    // Objectives: the shown ones, with the references their targets point at.
    const objectives = quest.objectives.filter(
      (objective) => state?.objectives.get(objective.index)?.displayed === true,
    );
    if (objectives.length > 0) {
      const list = element('ul', 'upgrade-list');
      for (const objective of objectives) {
        const done = state?.objectives.get(objective.index);
        const mark = done?.completed === true ? '✓ ' : done?.failed === true ? '✗ ' : '';
        const item = element(
          'li',
          'quest-line',
          `${mark}${String(objective.index)} ${objective.text ?? ''}`,
        );
        for (const target of objective.targets) {
          const reference = state?.aliases.get(target.alias);
          const alias = quest.aliases.find((entry) => entry.id === target.alias);
          if (reference === undefined || reference === PLAYER_REF || alias?.location === true)
            continue;
          item.append(
            button(`go to ${alias?.name ?? hex(reference)}`, () => {
              void this.#goTo(reference);
            }),
          );
        }
        list.append(item);
      }
      parts.push(section('objectives', list));
    }

    // Stages: each one's first journal text; a click sets it (SetStage).
    const stages = element('ul', 'upgrade-list quest-stages');
    for (const stage of quest.stages) {
      const done = state?.stagesDone.has(stage.index) === true;
      const text = stage.logEntries.find((entry) => entry.text)?.text ?? '';
      const row = element('li', 'quest-line');
      const set = button(`${done ? '✓' : ' '} ${String(stage.index)}`, () => {
        this.#act(
          `SetStage ${String(stage.index)}`,
          quest,
          runtime.quests.setStage(quest.formId, stage.index).then((set) => {
            if (!set) this.#log(`${quest.editorId} stage ${String(stage.index)} was not set`);
          }),
        );
      });
      set.classList.add('quest-stage');
      row.append(set, element('span', '', text));
      stages.append(row);
    }
    if (quest.stages.length > 0) parts.push(section('stages', stages));

    // Aliases: who fills them now.
    if (quest.aliases.length > 0) {
      const aliases = element('ul', 'upgrade-list quest-aliases');
      for (const alias of quest.aliases) {
        const filled = state?.aliases.get(alias.id);
        const row = element(
          'li',
          'quest-line',
          `${alias.name}: ${filled === undefined ? '—' : hex(filled)}`,
        );
        if (filled !== undefined && filled !== PLAYER_REF && !alias.location) {
          row.append(
            button('go to', () => {
              void this.#goTo(filled);
            }),
          );
        }
        aliases.append(row);
      }
      parts.push(section('aliases', aliases));
    }

    detail.replaceChildren(...parts);
    detail.hidden = false;
    const list = detail.querySelector('.quest-stages');
    if (list) list.scrollTop = scroll;
  }

  /** Runs a console action on the quest, logs it and shows the result. */
  #act(what: string, quest: QuestRecord, done: Promise<unknown>): void {
    this.#log(`${what} ${quest.editorId}`);
    done
      .catch((error: unknown) => {
        this.#terminal.log('quest', describe(error), 'error');
      })
      .finally(() => {
        this.#render();
        this.#showResults();
      });
    this.#render();
  }

  async #goTo(reference: number): Promise<void> {
    const at = await this.#runtime()?.placement(reference);
    if (!at) {
      this.#log(`${hex(reference)} has no place in the world`);
      return;
    }
    this.#log(`player.moveto ${hex(reference)}`);
    this.onGoTo?.(at);
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
