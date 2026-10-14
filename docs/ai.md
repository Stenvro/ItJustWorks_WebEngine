# AI

What actors do is milestone M10. This is what is in place before it.

## Where packages put actors

An actor's editor placement is often not where the game shows it. Whiterun's Imperial guards
stand in a cluster above the Cloud District until their packages put them on their posts. Draugr,
Falmer and Dwemer spiders are placed 32 to 512 units in front of the alcoves, wall pods and
pipes they wait in. Town people are placed in the houses they sleep in. In the game an actor's
AI decides where it is long before the player arrives, so as its cell loads it is where its
package has it (`src/ai/package-start.ts`; check: `node tools/package-info.ts <reference>` for
one actor, `--audit` for cells):

- **The package that runs:** the first in the actor's list (PKID of the NPC\_ its templates give
  AI packages from, template flag 0x20) whose schedule fits the game's time and whose
  conditions hold. A night that began yesterday counts by yesterday's day of the week.
- **Its first procedure:** a template's tree (else the package's own) is walked in order. Of a
  Sequence or Stacked branch the first child whose conditions hold runs; a Simultaneous
  branch's first child gives the place. The procedure's inputs (PKC2) are the package's data
  inputs over its template's defaults.
- **The place:** the procedure's first input that is a location or a target.
  - A reference: the actor is on it (its position and heading) if it is in the actor's cell or
    worldspace, else in another (not in this cell). A Sit, Sleep or UseIdleMarker on furniture
    puts it in the furniture, which holds it (no character controller), at the furniture's
    first active marker ([nif.md](formats/nif.md#furniture-markers)), facing its heading; its
    feet stay at the furniture's height until the furniture's idle plays (TODO(M10)).
  - A linked reference (XLKR of a keyword), "in cell" (here or elsewhere), near the editor
    location, the package start or self (where it was placed).
  - An actor (the player, a follower's leader): it moves, so the actor stays where it was placed.
- **Conditions** are valued where the data decides them: GetIsID, GetInFaction,
  GetFactionRank, GetIsRace, GetIsSex, GetGlobalValue (the global's starting value),
  GetCurrentTime, GetDayOfWeek, IsInInterior, HasLinkedRef, GetNumericPackageData (the
  package's own input) and Variable01..10 actor values (0 until a script sets them). Quests
  that do not start with the game are at stage 0 with no stage done. Those that do (QUST DNAM
  0x01) have their start-up stage done. Where a script fragment runs on that stage, its effects
  are not known, nor are quest aliases' packages (ALPC; they run before the actor's own) until
  the Papyrus VM runs the quests (M8).
- **Not decided** where a condition is not known (random chance, the player's state, package
  data, alias references), a Random branch chooses, a linked reference is missing (the Civil
  War scripts link guards to their posts during sieges) or the place is found by searching
  (objects of a type, the nearest bed). Then the actor stays where it was placed.

The game starts on a Sundas, the 17th of Last Seed 4E 201 (the GameDay, GameMonth and GameYear
globals; UESP gives the day of the week). The clock counts its midnights (`GameSession.gameDaysPassed`)
for the days of the week.

At 10:00 on the first day, of Whiterun's 32 actors 5 guards start on their patrol and post
markers, 11 are elsewhere (asleep in the barracks and the jail, at the main gate in Tamriel), a
cow stays where it was placed, 1 is dead and 14 are not decided (10 garrison guards whose
posts the Civil War scripts link, 4 on conditions about the player and quests). Of 4873 actors in interiors
enabled at a new game, 1088 start on a reference (912 of them in ambush furniture: creature
alcoves, Dwemer pipes, dragon priests' coffins, Falmer wall pods), 169 are elsewhere, 2180
stay, 498 are not decided and 938 are dead.

TODO(M10): running the packages (travel, sandbox, patrols, furniture use with its entry
markers and idles, schedules changing while a cell is loaded), actors coming into a cell from
another, and objects found by searching. With the running game's scripts, quest state and
globals are theirs, and the packages of the aliases that hold an actor come before its own
(by quest priority, as the Creation Kit stacks them); without them an actor an alias may hold
is not decided.
