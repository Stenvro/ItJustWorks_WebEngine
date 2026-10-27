// The game's journal (interface\quest_journal.swf): its quests page (the quests given to the
// player with their descriptions and objectives, the active ones, the miscellaneous
// objectives), its stats page (the game's statistics) and its system page (saving, loading,
// settings, controls, help, quitting). J opens it on the page it was left on, Esc (Pause) on
// the system page. What it asks of the engine (GameDelegate calls) is answered here.
// Notes: docs/ui.md ("The journal").

import { MISC_STATS, StatCategory } from '../gameplay/misc-stats.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { journalQuests, MISC_QUEST_TYPE, type JournalQuest } from '../scripting/runtime/journal.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { SaveHeader } from '../save/save-codec.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { formatGameDate } from '../world/game-time.ts';
import type { GameSession } from './game-session.ts';
import { questTargets } from './compass.ts';
import type { Terminal } from './terminal.ts';
import { settingsHandlers } from './journal-settings.ts';
import { controlsHandlers } from './journal-controls.ts';

/** HelpManualPC: the help topics of the PC game (Skyrim.esm's FLST 0x163). */
const HELP_MANUAL_PC = 0x163;

/** The journal's pages (its tabs). */
export const JournalPage = { quests: 0, stats: 1, system: 2 } as const;

/** What the journal remembers between openings (the game keeps it with its state). */
interface JournalMemory {
  tab: number;
  quest: number;
  /** The miscellaneous objectives show on the compass. */
  miscActive: boolean;
}

/** The player's date, level and progress, as the journal's and the tween menu's bars show. */
export async function playerBarInfo(
  session: GameSession,
): Promise<{ date: string; level: number; progress: number }> {
  const runtime = session.scriptsReady;
  const settings = await session.settings();
  if (!runtime) return { date: '', level: 1, progress: 0 };
  const date = formatGameDate(runtime.date, runtime.dayOfWeek, runtime.gameHour, (name) =>
    settings.string(name),
  );
  // The progress to the next level (the player's experience; 0..100).
  return {
    date,
    level: await runtime.actors.level(PLAYER_REF),
    progress: (await runtime.progression.levelProgress()) * 100,
  };
}

export class JournalMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  readonly #memory: JournalMemory = { tab: JournalPage.quests, quest: 0, miscActive: true };
  /** The quests as the last RequestQuestsData gave them (objectives are asked for later). */
  #quests: JournalQuest[] = [];
  /** The quest list the menu passed (a clip it asked to fill). */
  #titleList: string | undefined;
  readonly #unanswered = new Set<string>();
  /** Quit to the main menu, or the game, ends Play's game. */
  onQuit: ((toDesktop: boolean) => void) | undefined;
  /** Saving and loading (Play's): unset, the system page's Save, Load and Quicksave do nothing. */
  saves: JournalSaves | undefined;
  /** The saves the list shows now (the system page's Save or Load), and whether it saves. */
  #listed: { headers: SaveHeader[]; saving: boolean; list: string } | undefined;
  /** Show on Map: the journal closes, the map opens on a quest target (its reference). */
  onShowOnMap: ((reference: number) => void) | undefined;
  /** The objectives' targets on the map ("quest:objective" → the first target's reference). */
  #targets = new Map<string, number>();

  /** The stats page's favorites, read as the journal opens. */
  #favorites: Awaited<ReturnType<ScriptRuntime['usage']['favorites']>> | undefined;

  /** How a hold's bounty is named on the stats page (sBountyStatString, "%s Bounty"). */
  #bountyFormat = '%s Bounty';

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
    void session.settings().then((settings) => {
      this.#bountyFormat = settings.string('sBountyStatString') ?? this.#bountyFormat;
    });
  }

  /**
   * Opens the journal on a page (the system page for Pause; the page it was left on for the
   * journal); `closed` is called once it has closed.
   */
  async open(page: number | undefined, closed: () => void, depth: number): Promise<Menu> {
    // DisablePlayerControls' abJournalTabs: the system page alone.
    const tabsDisabled = this.#session.scriptsReady?.controls.journalTabs === false;
    const tab = tabsDisabled ? JournalPage.system : (page ?? this.#memory.tab);
    // A GameDelegate request is answered during the call (the menu forgets it once the call
    // returns): what the journal shows is read before it opens.
    const runtime = this.#session.scriptsReady;
    this.#quests = runtime ? await journalQuests(runtime) : [];
    this.#targets = new Map();
    for (const target of runtime ? await questTargets(runtime) : []) {
      const key = `${String(target.quest)}:${String(target.objective)}`;
      if (!this.#targets.has(key)) this.#targets.set(key, target.reference);
    }
    const bar = await playerBarInfo(this.#session);
    const help = await this.#helpTopics();
    // The favorite weapon, spell, school and shout (what the player used most: usage-stats.ts).
    this.#favorites = runtime ? await runtime.usage.favorites() : undefined;
    let done = false;
    const close = (menu: Menu): void => {
      if (done) return;
      done = true;
      this.#host.close(menu);
      closed();
    };
    void this.#playSound('UIJournalOpen');
    return this.#host.open('quest_journal.swf', {
      depth,
      interactive: true,
      handlers: {
        // What the journal asks that is not answered yet goes to the log once.
        ...Object.fromEntries(
          UNBUILT.map((name) => [
            name,
            () => {
              this.#notAnswered(name);
            },
          ]),
        ),
        // The settings pages (src/shell/journal-settings.ts).
        ...settingsHandlers(this.#host, this.#session),
        // The controls page (src/shell/journal-controls.ts).
        ...controlsHandlers(this.#session),
        // The installed content page (Creations): an online store, never reached from
        // localhost (hard rule 4).
        ShouldShowMod: (menu, args) => {
          menu.respond(args[0], false);
        },
        ShouldShowKinectTunerOption: (menu, args) => {
          menu.respond(args[0], false);
        },
        RequestIsOnPC: (menu, args) => {
          menu.respond(args[0], true);
        },
        RememberCurrentTabIndex: (_menu, args) => {
          if (typeof args[1] === 'number') this.#memory.tab = args[1];
        },
        CloseMenu: (menu, args) => {
          // (the page, the quest selected, its instance)
          if (typeof args[1] === 'number') this.#memory.tab = args[1];
          if (typeof args[2] === 'number') this.#memory.quest = args[2];
          close(menu);
        },
        RequestPlayerInfo: (menu, args) => {
          menu.respond(args[0], bar.date, String(bar.level), bar.progress);
        },
        RequestQuestsData: (menu, args) => {
          this.#questsData(menu, args[0], args[1]);
        },
        RequestObjectivesData: (menu) => {
          this.#objectivesData(menu);
        },
        // (its request id, then the objective's questTargetID: the target's reference) The
        // movie closes the journal itself.
        ShowTargetOnMap: (_menu, args) => {
          const reference = Number(args[1]);
          if (Number.isFinite(reference)) this.onShowOnMap?.(reference);
        },
        ToggleQuestActiveStatus: (menu, args) => {
          const formId = typeof args[1] === 'number' ? args[1] : 0;
          const runtime = this.#session.scriptsReady;
          if (!runtime || formId === 0) return;
          const state = runtime.state.quest(formId);
          state.active = !state.active;
          menu.respond(args[0], state.active);
        },
        ToggleShowMiscObjectives: (_menu, args) => {
          this.#memory.miscActive = args[1] === true;
          const runtime = this.#session.scriptsReady;
          for (const quest of this.#quests) {
            if (quest.type === MISC_QUEST_TYPE && runtime)
              runtime.state.quest(quest.formId).active = this.#memory.miscActive;
          }
        },
        // The help topics (HelpManualPC's messages: their titles), and one's title and text.
        PopulateHelpTopics: (menu, args) => {
          const list = menu.reference(args[1]);
          if (!list) return;
          help.forEach((topic, index) => {
            menu.invoke(`${list}.push`, { text: topic.title, index });
          });
        },
        RequestHelpText: (menu, args) => {
          const topic = typeof args[1] === 'number' ? help[args[1]] : undefined;
          const title = menu.reference(args[2]);
          const text = menu.reference(args[3]);
          if (!topic) return;
          // A text field and a TextArea (CLIK) both take `text`.
          if (title) menu.set(`${title}.text`, topic.title);
          if (text) menu.set(`${text}.text`, topic.text);
        },
        // The game's version under the system page's list: the engine runs no game executable
        // and has none to show (the field stays empty rather than showing its placeholder).
        SetVersionText: (menu, args) => {
          const field = menu.reference(args[1]);
          if (field) menu.set(`${field}.text`, '');
        },
        updateStats: (menu, args) => {
          menu.respond(args[0], ...this.#stats());
        },
        // Save and Load list the saves (the movie adds its [NEW SAVE] on Save), newest first.
        SAVE: (menu, args) => {
          void this.#listSaves(menu, args[0], true);
        },
        LOAD: (menu, args) => {
          void this.#listSaves(menu, args[0], false);
        },
        SaveGame: (menu, args) => {
          const listed = this.#listed;
          const index = typeof args[0] === 'number' ? args[0] : 0;
          // The first entry is the new save; the others are saved over.
          const over = index > 0 ? listed?.headers[index - 1]?.name : undefined;
          close(menu);
          void this.saves?.save(over);
        },
        IsOKtoLoad: (menu) => {
          menu.call('ConfirmOKToLoad');
        },
        LoadGame: (menu, args) => {
          const index = typeof args[0] === 'number' ? args[0] : -1;
          const name = this.#listed?.headers[index]?.name;
          if (name === undefined) return;
          close(menu);
          this.saves?.load(name);
        },
        DeleteSave: (menu, args) => {
          const listed = this.#listed;
          const index = typeof args[0] === 'number' ? args[0] : -1;
          const name = listed?.headers[listed.saving ? index - 1 : index]?.name;
          if (!listed || name === undefined) return;
          void this.saves
            ?.delete(name)
            .then(() => this.#listSaves(menu, listed.list, listed.saving));
        },
        QuickSave: (menu) => {
          close(menu);
          this.saves?.quicksave();
        },
        // One list for every character (TODO(M13): the character filter), all at once.
        UseCurrentCharacterFilter: () => undefined,
        ForceStopSaveListLoading: () => undefined,
        // TODO(M13): the save's thumbnail shown (img://BGSSaveLoadHeader_Screenshot).
        PrepSaveGameScreenshot: () => undefined,
        SetSaveDisabled: () => undefined,
        QuitToMainMenu: (menu) => {
          close(menu);
          this.onQuit?.(false);
        },
        QuitToDesktop: (menu) => {
          close(menu);
          this.onQuit?.(true);
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', 0, false);
        menu.call('RestoreSavedSettings', tab, tabsDisabled);
      },
    });
  }

  /**
   * RequestQuestsData(TitleList): the engine fills the list's entries (name, form id,
   * instance, active, done, type), the miscellaneous objectives as one entry the menu adds,
   * then answers with the quest to select, whether there are miscellaneous objectives and
   * whether they are active, and whether a quest's targets may be shown on the map.
   */
  #questsData(menu: Menu, request: unknown, list: unknown): void {
    const titleList = menu.reference(list);
    this.#titleList = titleList;
    if (!titleList) return;
    const entries = `${titleList}.entryList`;
    menu.set(`${entries}.length`, 0);
    let hasMisc = false;
    for (const quest of this.#quests) {
      if (quest.type === MISC_QUEST_TYPE) {
        hasMisc ||= quest.objectives.some((objective) => !objective.completed);
        continue;
      }
      if (!quest.name) continue;
      menu.invoke(`${entries}.push`, {
        text: quest.name,
        formID: quest.formId,
        instance: 0,
        active: quest.active,
        completed: quest.completed,
        type: quest.type,
      });
    }
    // Show on Map: for the objectives with a target on the map (questTargetID).
    menu.respond(request, this.#memory.quest, 0, hasMisc, this.#memory.miscActive, true);
  }

  /**
   * RequestObjectivesData: the selected quest's objectives (and description), at once (the
   * menu reads them right after asking); for the miscellaneous entry, every miscellaneous
   * objective not done yet.
   */
  #objectivesData(menu: Menu): void {
    const list = this.#titleList;
    if (!list) return;
    const selected = menu.get(`${list}.selectedEntry.formID`);
    const runtime = this.#session.scriptsReady;
    if (selected === 0) {
      const objectives = this.#quests
        .filter((quest) => quest.type === MISC_QUEST_TYPE)
        .flatMap((quest) =>
          quest.objectives
            .filter((objective) => !objective.completed && !objective.failed)
            .map((objective) => ({
              text: objective.text,
              formID: quest.formId,
              instance: 0,
              active: runtime?.state.quests.get(quest.formId)?.active ?? false,
              completed: false,
              failed: false,
              ...this.#targetOf(quest.formId, objective.index),
            })),
        );
      menu.set(`${list}.selectedEntry.objectives`, objectives);
      return;
    }
    const quest = this.#quests.find((entry) => entry.formId === selected);
    if (!quest) return;
    menu.set(`${list}.selectedEntry.description`, quest.description);
    menu.set(
      `${list}.selectedEntry.objectives`,
      quest.objectives.map((objective) => ({
        text: objective.text,
        // Objectives not done of the active quest show as active (on the compass).
        active: quest.active && !objective.completed && !objective.failed,
        completed: objective.completed,
        failed: objective.failed,
        ...this.#targetOf(quest.formId, objective.index),
      })),
    );
  }

  /** An objective's questTargetID (its target's reference), if it has one on the map. */
  #targetOf(quest: number, objective: number): { questTargetID?: number } {
    const reference = this.#targets.get(`${String(quest)}:${String(objective)}`);
    return reference === undefined ? {} : { questTargetID: reference };
  }

  /** The stats page: name, value, category and an unused field, for every stat. */
  #stats(): unknown[] {
    const runtime: ScriptRuntime | undefined = this.#session.scriptsReady;
    const values: unknown[] = [];
    for (const stat of MISC_STATS) {
      const key = stat.name.toLowerCase();
      let value: number | string = runtime?.stats.get(key) ?? 0;
      if (key === 'days passed') value = runtime?.daysPassed ?? 0;
      // The favorite weapon, spell, school and shout: names (none used yet: empty).
      const favorites = this.#favorites;
      if (key === 'favorite weapon') value = favorites?.weapon ?? '';
      if (key === 'favorite spell') value = favorites?.spell ?? '';
      if (key === 'favorite school') value = favorites?.school ?? '';
      if (key === 'favorite shout') value = favorites?.shout ?? '';
      values.push(stat.name, value, stat.category, 0);
    }
    // The bounties the player owes, each crime faction's ("Whiterun Bounty"), in the crime
    // category (UESP "Skyrim:Statistics").
    for (const { faction, gold } of runtime?.crime.bounties() ?? []) {
      const name = runtime?.crime.name(faction);
      if (name === undefined) continue;
      values.push(this.#bountyFormat.replace('%s', name), gold, StatCategory.crime, 0);
    }
    return values;
  }

  /** The help topics: the messages of the form list HelpManualPC (FLST 0x163), in order. */
  async #helpTopics(): Promise<{ title: string; text: string }[]> {
    const db = await this.#session.db;
    const list = await db.get(HELP_MANUAL_PC);
    const topics: { title: string; text: string }[] = [];
    for (const data of list?.fields.all('LNAM') ?? []) {
      const message = list ? await db.get(list.formIdAt(data)) : undefined;
      if (message?.type !== 'MESG') continue;
      topics.push({ title: message.text('FULL') ?? '', text: message.text('DESC') ?? '' });
    }
    return topics;
  }

  /**
   * Fills the save list (the movie's entryList) with the saves, then tells the movie it is
   * complete (onSaveLoadBatchComplete: initial update, entries processed, entries in all). An
   * entry: its text (the list's line), the player's name, level and race, the game time.
   */
  async #listSaves(menu: Menu, list: unknown, saving: boolean): Promise<void> {
    const path = typeof list === 'string' && list.startsWith('_') ? list : menu.reference(list);
    if (!path) return;
    const headers = (await this.saves?.list()) ?? [];
    this.#listed = { headers, saving, list: path };
    const runtime = this.#session.scriptsReady;
    menu.set(`${path}.length`, 0);
    headers.forEach((header, index) => {
      menu.invoke(`${path}.push`, {
        text: `${header.name}  ${header.location}`,
        name: header.playerName,
        level: header.playerLevel,
        raceName: '',
        playTime: runtime?.gameTimeString(header.gameDays) ?? '',
        index,
        fileNum: header.number,
      });
    });
    menu.call('onSaveLoadBatchComplete', true, headers.length, headers.length);
  }

  #notAnswered(name: string): void {
    if (this.#unanswered.has(name)) return;
    this.#unanswered.add(name);
    this.#terminal.log('ui', `the journal asks ${name}: not answered yet`, 'warn');
  }

  async #playSound(editorId: string): Promise<void> {
    const sounds = await this.#session.sounds();
    await sounds.playNamed(editorId, undefined);
  }
}

/** The system page's requests not answered yet: the save list's character filter (TODO(M13)). */
const UNBUILT = ['PopulateCharacterList', 'CharacterSelected'] as const;

/** What the journal's Save, Load and Quicksave do (Play's save manager). */
export interface JournalSaves {
  list(): Promise<SaveHeader[]>;
  /** A new save, or over the save of this name. */
  save(overwrite?: string): Promise<unknown>;
  quicksave(): void;
  load(name: string): void;
  delete(name: string): Promise<void>;
}
