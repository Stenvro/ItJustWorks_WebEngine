# Gameplay

The gameplay systems of milestone M11: their rules (platform-independent, `src/gameplay/`), what
the running game keeps of them (`src/scripting/runtime/`) and their sources.

## Equipment

What every actor (the player and each NPC) holds and wears: its **loadout** (`Loadout`,
`src/gameplay/equipment.ts`), kept in the game state (`ActorState.equipment`; `ActorState.equipped`
mirrors it as a set) by the equip system (`ScriptRuntime.equipment`,
`src/scripting/runtime/equipment-engine.ts`). `node tools/equipment-info.ts` prints an actor's
from the real data (`--player`, `--base <editor id>`, `--audit` for every placed actor).

### Places

- **Equip slots** (EQUP; xEdit "Equip Type", CommonLibSSE `BGSEquipSlot`,
  `src/world/equip-slots.ts`): a slot without parents is one of an actor's own places, which the
  default objects name: LHEQ the left hand, RHEQ the right hand, VOEQ the voice, POEQ the potion
  slot (EHEQ is EitherHand). A slot with parents (PNAM) takes all of them when its DATA has "use
  all parents" (BothHands: both hands; Shield: the left hand), else one (EitherHand).
- An item's slot is its ETYP. Without one: weapons the right hand, carried lights (torches) the
  left hand (CommonLibSSE: `TESObjectLIGH`'s own equip slot), spells and scrolls either hand (the
  Creation Kit's default), shouts the voice, potions, food and ingredients the potion slot (they
  are used up), ammunition its own slot. Armor and clothing take their **biped slots** (BOD2 /
  BODT); a shield (ETYP Shield) takes the left hand and its biped slot 39.
- Vanilla's one-handed weapons and staves mostly name RightHand, yet the menus put them in the
  hand asked for (the player dual-wields); a hand item asked for a hand the race lacks goes in
  the other.
- A race has only the places its slots give (RACE QNAM: a wolf has its right hand, a dragon its
  right hand and voice) and uses only the equipment its VNAM flags allow (weapon types, spells,
  shields, torches).

### Equipping

- Armor comes off where a new piece covers any of its biped slots.
- A hand's item comes off when another goes there; a two-handed item (BothHands: greatswords,
  battleaxes, bows, crossbows, two-handed spells) empties both hands, and a shield or torch
  takes it off again. An item the actor has one of moves to the other hand rather than being in
  both; spells are not counted (one spell can be in both hands).
- `EquipItem` gives the actor one first if it has none (Creation Kit); `abPreventRemoval` keeps
  it on against the player and the AI; `UnequipItem`'s `abPreventEquip` keeps the AI from
  equipping it again. `UnequipAll` takes off every item (not spells or shouts),
  `UnequipItemSlot(aiSlot)` what covers a biped slot (30..61).
- Items that leave the inventory (dropped, sold, stored, `RemoveItem`, `RemoveAllItems`) come
  off when the actor no longer has enough of them.
- The actor's scripts hear `OnObjectUnequipped`, then `OnObjectEquipped` (the base object,
  reference None); the item's own scripts `OnUnequipped` / `OnEquipped` with the actor (one
  script instance per base: TODO(M13), the game has one per item). Using a potion and reading a
  book from the inventory are heard as equipping it. What the actor wears changing makes its
  look again (`WorldBridge.equipmentChanged`); listeners (`EquipmentEngine.listeners`) hear
  every change.

### Outfits and what NPCs take up

- An actor is dressed as its inventory is first read (`ScriptRuntime.inventory`, whose base
  items for an actor are those of the NPC\_ its templates take the inventory from): the pieces of
  its outfit (its own from `Actor.SetOutfit`, else its base's from `ActorBase.SetOutfit`, else its
  record's DOFT; leveled items picked at the actor's level) join its items as the outfit's and
  are worn. A new outfit takes the old one's items away and is worn (Creation Kit: SetOutfit);
  the sleep outfit (SOFT) is worn while it sleeps (`EquipmentEngine.sleep`, for the AI).
- The player gets the Player record's outfit too: the iron armor of a game started without the
  opening; the opening's scripts (MQ101) strip it (`RemoveAllItems`) and dress the prisoner.
- NPCs then take up what they carry that suits them (TODO(M13): the engine's choice is not
  documented; UESP's followers wear what has a higher rating than what covers its slots): armor
  rated above what covers the same slots, or for free slots; a melee weapon (one-handed beside a
  shield it has), else a bow or crossbow, else a staff, the one that does the most damage with
  its skill; a shield beside a one-handed weapon; the best arrows (non-bolts) or bolts for its
  bow or crossbow. Items given to an NPC are weighed the same way. Combat chooses its weapons by
  its combat style (TODO(M10) 5.2).

### The menus

- Inventory, magic and favorites: the left mouse button equips to the right hand, the right
  button to the left hand (the control map's item menu context: RightEquip and LeftEquip are
  the attack buttons). The engine calls the movie's `AttemptEquip(slot)` (it checks the mouse is
  over the list, then asks `ItemSelect(slot)`); the 3D item's quick click asks
  `CheckForMouseEquip(button)`, answered with the slot. Slots are 0 left and 1 right (the
  game's order); E or Enter (`ItemSelect()` without one) uses the item's own place, the right
  hand for either hand.
- Choosing what is equipped where asked takes it off; potions, food and ingredients are used
  (one gone, their effects cast on the player: `WorldBridge.castSpell`; an ingredient eaten shows
  its first effect), books read. Equipping plays a weapon's NAM9 / NAM8 sound, else the item's
  pick-up or put-down sound (TODO(M13): what the engine plays for armor); potions their ENIT
  consume sound.
- The rows' equip state (InventoryDefines): 1 worn or equipped, 2 the left hand, 3 the right, 4
  both hands (a two-handed item, a spell in each hand).

### Stats

- **Armor rating** of a piece (UESP "Skyrim:Armor"): ceiling((base + item quality) × skill
  multiplier) × perks. The base is DNAM / 100; the item quality what improving added
  (`temperingIncrease`, src/gameplay/crafting.ts: (3.6 × level − 1.6), half for all but chest
  armor; the player's by `GameState.itemHealth`). The skill multiplier is fArmorRatingBase (1) at
  skill 0 up to fArmorRatingPCMax (1.4: 1 + 0.4 × skill / 100) for the player, fArmorRatingMax
  (2.5: 1 + 1.5 × skill / 100) for NPCs, at 100; the skill is Light or Heavy Armor with its
  fortifications (the LightArmorMod / HeavyArmorMod and PowerMod actor values). Clothing has none.
  Perks (unison, matching set, Agile Defender / Juggernaut): `EquipmentEngine.modifiers`,
  TODO(M11) for the perk system.
- The **total** the inventory shows: the worn pieces' plus the armor effects (the DamageResist
  actor value: Oakflesh, ...). **Damage taken off**: rating × fArmorScalingFactor (0.12) percent
  plus fArmorBaseFactor (3%) per piece of armor worn (shields too, not clothing), at most
  fMaxArmorRating (80%).
- **Weapon damage** (UESP "Skyrim:Weapons"): round((base + smithing increase) × skill
  multiplier × (1 + perk effects) × (1 + item effects) × (1 + potion effect)). The skill
  multiplier is fDamagePCSkillMin (1) at skill 0 up to fDamagePCSkillMax (1.5) at 100: 1 + skill
  / 200; NPCs' fDamageSkillMin and fDamageSkillMax are built into the engine and undocumented
  (TODO(M13): taken as the player's). Item and potion effects are the skill's Mod and PowerMod
  actor values (percent). A bow's or crossbow's shot adds its ammunition's damage before the
  multipliers (`WeaponStats.shotDamage`); the inventory shows the weapon's damage plus the
  arrows' base damage (UESP "Skyrim:Archery": the menu does not multiply the arrows'). Unarmed:
  the UnarmedDamage actor value.
- **Carry weight**: the items' weights times their counts against the CarryWeight actor value.
  More is over-encumbered (`Actor.IsOverEncumbered`): the player walks (no running or
  sprinting) and the HUD says sOverEncumbered; fast travel is refused
  (sNoFastTravelOverencumbered, src/gameplay/fast-travel.ts).

### For combat, magic and perks

`EquipmentEngine` answers what an actor holds in each hand (`inHand`, `weapon`, `shield`,
`torch`, `spell(source)`, `shout`, `ammo`), wears (`worn`, `armorInSlot`), the stats
(`armorRating`, `pieceRating`, `weaponDamage`, `weaponStats(hand)`: damage, shot damage, speed,
reach, stagger, critical damage, skill, ammunition, the world and first-person models, and the
skeleton nodes it hangs on: sheathed by its type as the weapon models' "Prn" name them —
WeaponSword, WeaponDagger, WeaponAxe, WeaponMace, WeaponBack, WeaponBow; vanilla's skeleton has
no WeaponStaff or left-hand sheath nodes — drawn WEAPON in the right hand and SHIELD in the
left; arrows on QUIVER), and equips (`equip`, `unequip`, `equipSpell`, `equipShout`, `use`).

### Conditions

GetEquipped (a form list: any of its forms), GetEquippedItemType (by casting source: 0 left, 1
right; the codes of `Actor.GetEquippedItemType`: 0 hand to hand .. 8 staff, 9 a spell, 10 a
shield, 11 a torch, 12 a crossbow), GetEquippedShout, HasEquippedSpell, WornHasKeyword,
WornApparelHasKeywordCount, GetClothingValue (the worn items' value), IsTorchOut and
IsActorUsingATorch (a torch in the left hand), and of the right hand's weapon GetWeaponAnimType,
IsWeaponSkillType, IsWeaponInList, HasTwoHandedWeaponEquipped; HasBoundWeaponEquipped by hand.
IsShieldOut and IsWeaponOut need the weapon drawn (TODO(M10) 5.1).

TODO(M11): warmth (Survival Mode); TODO(M12): the loadout in the save.
