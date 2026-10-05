# Plutonium item notes

Differences found between Plutonium's imported 2024 items and the rules, as we test each class. Each entry says
whether the module covers it or you need to edit the item.

| Item | Issue | What to do |
|---|---|---|
| **Reckless Attack** (Barbarian 2) | No activity at all; its "Reckless Attack" effect has no changes. | Run [upgrade-items.js](../examples/item-macros/upgrade-items.js) on the character: it copies Reckless Attack from the Actions compendium and keeps it under Barbarian. |
| **Tavern Brawler** (feat) | Its 1d4 + STR "Enhanced Unarmed Strike" is a separate attack on the feat; the Unarmed Strike itself is unchanged. | Nothing: the module makes the Unarmed Strike roll 1d4 + STR (rerolling 1s). The feat's own attack can be deleted. |
| **Divine Order: Thaumaturge** (Cleric 1) | Its effects add WIS to Arcana / Religion with the old keys `system.skills.arc.bonuses.check` / `system.skills.rel.bonuses.check`, which dnd5e 6 doesn't apply (it moved skill check bonuses to `check.roll.bonus`). | **Edit (confirmed):** change both effect keys to `system.skills.arc.check.roll.bonus` and `system.skills.rel.check.roll.bonus` (the key field's list has them). |
| **Draconic Flight** (Dragonborn) | Given at level 1 with a use; the rule gives it at character level 5. | Delete it on characters below level 5. |
| **Turn Undead** (Cleric 2) | Targets "creature", with "Undead of your choice" only in the text. | Nothing: the module targets the Undead within 30 ft by identifier and shows the circle. |
| **Bless** (spell) | Target count is the formula `2 + @item.level`. | Nothing: the module works the formula out at the cast level. |
| **Divine Spark** (Cleric 2) | Damage is necrotic *or* radiant (both listed). | Nothing: the module asks which before rolling. |
| **Wild Companion** (Druid 2), **Trance** (Elf) | Each has 1 use per Long Rest that the rule doesn't give. It looks like Plutonium adds one to any feature whose text mentions a Long Rest. Nothing spends them. | Nothing: harmless. Clear the item's uses if the counter bothers you. |
| **Elven Lineage (Wood Elf)** | Longstrider (character level 3) and Pass without Trace (level 5) are added at level 2. | Delete them on characters below those levels. |
| **Wild Companion** (Druid 2) | Its summons don't have *Match Disposition* ticked, so the familiar keeps the beast's hostile side. | Nothing: the module puts summons on the summoner's side. |
| **Weapon Mastery** (Fighter 1, and Barbarian / Paladin / Ranger / Rogue) | Plutonium never asks which weapons: the mastery list stays empty. | Nothing: choose them in Rest Choices (the sheet header's button). |
| **Defense** (Fighting Style) | Its +1 AC effect is always on; the rule only gives it while wearing armor. | Nothing: the module switches it off and on with armor. |
| **Dueling** (Fighting Style) | Its +2 melee damage effect is always on, even two-handed or with a second weapon. | Nothing: the module takes the +2 off attacks that don't qualify. |
| **Archery** (Fighting Style) | dnd5e counts a thrown melee weapon as a ranged weapon attack, so it gets the +2. | Nothing: the module takes it off thrown melee weapons. |
| **Great Weapon / Thrown Weapon / Two-Weapon Fighting** | No data, only text. | Nothing: the module does them. |
| **Unarmed Fighting** (Fighting Style) | Comes as two extra attacks on the feat (weapon in hand / empty hand) plus a Grappled Damage activity. | Nothing: the module upgrades your own Unarmed Strike; the feat's attacks aren't needed. Its Grappled Damage is used at the start of your turn. |
| **Fighting Style swaps** | Swapping on level-up needs the other styles, which come from Plutonium. | Drag them into the **Fighting Styles** compendium (Macro Helper); they're corrected as they land. |
| **Monster attacks** (Wild Shape forms, NPCs) | A conditional bonus (the Elk's charge damage) is a second activity on the attack item, so using it asks which activity. | Nothing: the item is used as its attack, and the bonus is rolled onto the card (its APPLY shows on a hit; the GM applies it when it applies). |
| **Torch** (gear) | Its attack activity spends one of the item's uses, but a torch has none (only a quantity), so dnd5e says "No uses of Torch available". | Nothing: the module's attack with a light source spends nothing (burning down is what uses a torch up, with Held Light's burn time). |
| **Martial Arts** (Monk) | An enchantment you apply to each weapon by hand: it forces the Martial Arts die even when the weapon's is bigger, and stays on in armor or with a shield. | Not used: the module changes the weapon as dnd5e prepares it (better of STR/DEX, the bigger die, unarmored and no shield only), so the sheet shows it. |
| **Flurry of Blows** (Monk) | Its own attack activity (DEX fixed, a 0 ft range: "no target in range"). | Not used: the module spends the Focus Point and uses the character's Unarmed Strike twice (Attack, Grapple or Shove each time). |
| **Step of the Wind** (Monk) | Only the Focus Point activity, no free Dash; uses of its own (@scale.monk.focus) shown on the sheet. | Changed when added (and on load): its own uses removed, a free activity added beside the Focus Point one, like Patient Defense. |
| **Unarmored Movement** (Monk) | Its speed effect is always on. | Switched off while wearing armor or holding a shield. |
| **Starting equipment** | Every weapon, shield and container arrives equipped. | With Hands on, weapons and shields arrive unequipped (and are tidied the first time the hands show). |
| **Uncanny Metabolism** (Monk) | A heal activity you use by hand; nothing ties it to the initiative roll. | A button on the Monk's initiative roll while its use is left. |
| **Paladin's Smite** (Paladin) | A "cast" activity with an Action activation; its use is on both the item (shown on the sheet) and the activity; nothing ties it to a hit. | The Smite button on a melee hit's attack card offers it as Divine Smite's free casting, spending the item's use; used from the sheet, it smites the latest melee hit. |
| **Divine Smite** (spell) | Two damage activities (normal, and "Unholy Creature Damage" 3d8), each an Action; nothing ties them to a hit. A Paladin gets two copies: one always prepared, one from Paladin's Smite. | Not used: the Smite button rolls 2d8 (+1d8 a level, +1d8 Fiend/Undead) onto the card. The two copies show once. |
| **Wrathful / Thunderous / Searing Smite** (spells) | Action activations; the hit damage sits on a save activity (Wrathful) or beside one; Searing's start-of-turn save carries damage too. | The Smite button adds the hit damage to the card; Wrathful's and Thunderous's save go on the card as its on-hit save. Searing's ongoing burn waits for the spell batch. |
| **Lay on Hands** (Paladin) | Both activities have "Self" range (no target pick); Remove Poison only spends 5 points (nothing ends Poisoned). | Both get Touch range when added (and on load). Remove Poison ends Poisoned on your own creature, or gives the GM an End Poisoned button. |
| **Fighting Style feats on a character** | Picked at level-up, Plutonium's own: Protection and Interception keep their activity and effect, Dueling and Archery their always-on effect, Unarmed Fighting its attacks. | Corrected like the compendium's copies, when added and once on load. |
| **Spell slots after import** | A new character can arrive with 0 slots left. | Nothing: take a Long Rest. |
| **Giant Insect (Centipede)** (the *Giant Insect* spell's summon) | Venomous Spew is a utility activity with a Poisoned effect and Self range: no saving throw, no target, though its description is a CON save against your spell save DC. | Not yet (spell batch): Roll Item can only offer the effect's Apply. |
