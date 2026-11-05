// What reading a book does in the game, apart from showing it (the book menu, book-menu.ts, as
// it opens a book; the headless simulation's book menu, which shows nothing): the book is read
// (TESBookReadEvent: the reference's, or a scripted base's, OnRead), and a skill book read the
// first time raises its skill (UESP, "Skill Books"; the reader's perks may add levels).

import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorValue } from '../world/actor-values.ts';
import { BookFlag, parseItem } from '../world/item-records.ts';

/** The 18 skills. */
const SKILLS = 18;

/** What is read: the book (BOOK), and where it lies when read in the world. */
export interface BookRead {
  readonly book: number;
  /** The reference read in the world; none: read from the inventory. */
  readonly reference?: number;
}

/** The player has opened a book: it is told read, and a skill book teaches the first time. */
export async function bookRead(
  runtime: ScriptRuntime,
  read: BookRead,
  book: { readonly flags: number; readonly teaches: number },
): Promise<void> {
  const first = !runtime.state.booksRead.has(read.book);
  runtime.state.booksRead.add(read.book);
  // The hub tells it (TESBookReadEvent: the reference's OnRead).
  await runtime.events.emitted('bookRead', {
    book: read.book,
    reader: PLAYER_REF,
    reference: read.reference,
    first,
  });
  if (!first || (book.flags & BookFlag.teachesSkill) === 0 || book.teaches < 0) return;
  // The experience the skill lacks to its next level (UESP "Skill Books"); the HUD announces
  // it (sSkillIncreased); the reader's perks may add levels (Adjust Book Skill Points:
  // Scholar's Insight's second).
  const skill = book.teaches;
  if (skill < ActorValue.firstSkill || skill >= ActorValue.firstSkill + SKILLS) return;
  const levels = await runtime.perks.apply(EntryPoint.adjustBookSkillPoints, PLAYER_REF, 1);
  await runtime.progression.incrementSkill(skill, Math.max(0, Math.round(levels)));
}

/**
 * Opens a book where nothing is shown (the headless simulation's book menu): as the book menu
 * does, one without a record or a text does not open (Creation Kit wiki, "Book"); one that
 * does is read. Whether it opened.
 */
export async function openBookUnseen(runtime: ScriptRuntime, read: BookRead): Promise<boolean> {
  const record = await runtime.forms.record(read.book);
  const item = record && parseItem(record);
  if (!record || !item?.book || (record.text('DESC') ?? '') === '') return false;
  await bookRead(runtime, read, item.book);
  return true;
}
