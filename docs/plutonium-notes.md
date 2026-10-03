# Plutonium item notes

Differences found between Plutonium's imported 2024 items and the rules, as we test each class. Each entry says
whether the module covers it or you need to edit the item.

| Item | Issue | What to do |
|---|---|---|
| **Reckless Attack** (Barbarian 2) | No activity at all; its "Reckless Attack" effect has no changes. | Import [examples/items/reckless-attack.json](../examples/items/reckless-attack.json) and run [upgrade-items.js](../examples/item-macros/upgrade-items.js) on the character (keeps it under Barbarian). |
| **Tavern Brawler** (feat) | Its 1d4 + STR "Enhanced Unarmed Strike" is a separate attack on the feat; the Unarmed Strike itself is unchanged. | Nothing: the module makes the Unarmed Strike roll 1d4 + STR (rerolling 1s). The feat's own attack can be deleted. |
| **Divine Order: Thaumaturge** (Cleric 1) | Its effects add WIS to Arcana / Religion with the old keys `system.skills.arc.bonuses.check` / `system.skills.rel.bonuses.check`, which dnd5e 6 doesn't apply (it moved skill check bonuses to `check.roll.bonus`). | **Edit (confirmed):** change both effect keys to `system.skills.arc.check.roll.bonus` and `system.skills.rel.check.roll.bonus` (the key field's list has them). |
| **Draconic Flight** (Dragonborn) | Given at level 1 with a use; the rule gives it at character level 5. | Delete it on characters below level 5. |
| **Turn Undead** (Cleric 2) | Targets "creature", with "Undead of your choice" only in the text. | Nothing: the module targets the Undead within 30 ft by identifier and shows the circle. |
| **Bless** (spell) | Target count is the formula `2 + @item.level`. | Nothing: the module works the formula out at the cast level. |
| **Divine Spark** (Cleric 2) | Damage is necrotic *or* radiant (both listed). | Nothing: the module asks which before rolling. |
