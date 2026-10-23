# Feature steps

One row per class feature: what sets it off, what it does, and which lego it's built on. Read this before building a new feature: if its steps match a row here, reuse that row's lego (or its own code, from the list at the end) instead of writing it again.

Legos are listed in [api.md](api.md). "Data" means the item's own dnd5e or Plutonium data does it, with no code of ours.

## Level 1

| Class | Feature | Trigger | Steps | Built on |
|---|---|---|---|---|
| Barbarian | Rage | its use | effect on; Concentration ends; extended (no use spent) when used while raging; ends early on Incapacitated, Heavy armor, the combat's end; ends at the end of a turn without an attack or a forced save; no spells | `itemEffectOn` / `itemEffectOff`, `freeUseWhile` (extended), `cantUseWhile` (spells, Heavy armor), `bonusOnlyWhen` (STR attacks only), `endsWhen`; the keep-going check is its own code |
| Barbarian | Unarmored Defense | - | - | data |
| Barbarian, Fighter, Paladin, Ranger, Rogue | Weapon Mastery | an attack with the weapon | the mastery's rider; one swap a Long Rest | masteries.js on `onMiss` (Graze), `addRow` (Topple, Sap, Slow, Vex), `addTimedEffect`, `addRollMode`, `forcedMove`, `giveCondition`, `onDamage`; `addRestChoice` |
| Bard | Bardic Inspiration | Inspire: its use; using it: a failed D20 Test | a mark with the Bard's die on another creature; its button on that creature's missed attack or failed save or check adds the die; the mark goes | dnd5e Apply (the mark), `excludeTargets` (another creature, not already Inspired), `onFailedTest` |
| Bard, Cleric, Druid, Paladin, Ranger, Sorcerer, Warlock, Wizard | Spellcasting, Pact Magic | casting | one slot a turn, components, long casts and rituals, Concentration | casting.js, components.js, prepared-spells.js |
| Cleric | Divine Order | - | Thaumaturge's skill bonus keys fixed | data, `itemFixes` |
| Druid | Druidic, Primal Order | - | - | data |
| Fighter | Fighting Style | an attack, a hit, damage | the style's bonus; one swap a level | fighting-styles.js on `bonusOnlyWhen` (Archery, Dueling, Defense), `onDamage` (Great Weapon, Thrown, Two-Weapon, Unarmed), `onAttacked` + `cutDamage` (Interception), `onAttacked` (Protection), `onTurnStart` (Unarmed's grapple damage); `pickFromCompendium`, `addRestChoice` |
| Fighter | Second Wind | its use | heal yourself | data |
| Monk | Martial Arts | the weapon prepared | no armor or shield: better of STR and DEX, the Martial Arts die | `weaponUses`, `isUnarmored` |
| Monk | Unarmored Defense | - | - | data |
| Paladin | Lay on Hands | its use | touch pick; heal from the pool; Remove Poison ends Poisoned | `item.target` (touch), `endCondition` |
| Paladin, Ranger | Smite and strike spells (Divine Smite, Ensnaring Strike, Hail of Thorns) | a weapon hit | one button for every smite spell prepared; pay with a free use or a slot; damage box; the spell's save on the card; Bonus Action, once a turn | `onHit`-like chooser (paladin.js), `castingOptions` / `payCasting`, `countedUses` (free Divine Smite), `cardSave` |
| Ranger | Favored Enemy, Hunter's Mark | the spell's or Favored Enemy's use | pay (a free casting, or a slot); pick; Concentration; GM's Mark button; 1d6 on every attack at it; ends with Concentration; moves when its creature is at 0 HP | `markSpell` (on `payCasting`), `countedUses` (Favored Enemy) |
| Rogue | Sneak Attack | a qualifying hit | Finesse or ranged, advantage or an ally by the target, no disadvantage; damage box; once a turn, counted when applied; from the sheet: the latest hit | `onHit` (`counted: "apply"`, `useOnLatestHit`), `alliesNear` |
| Rogue | Expertise, Thieves' Cant | - | - | data |
| Sorcerer | Innate Sorcery | its use | effect on; advantage on Sorcerer spell attacks; its +1 DC taken back off non-Sorcerer spells | `itemEffectOn`, `addRollMode`, `bonusOnlyWhen` (DC), `isClassSpell` |
| Warlock | Hex (a level 1 spell, handled with the class) | the spell's use | as Hunter's Mark, plus the ability whose checks get disadvantage | `markSpell` (`ask`) |
| Warlock | Pact of the Blade | the weapon prepared; forming it | CHA beside the weapon's own; one at a time; conjure or bond; damage type buttons | `weaponUses`, `damageTypeChoice`, `pickFromCompendium` + `conjureItem`; one at a time is its own code |
| Warlock | Pact of the Chain | its familiar | Find Familiar with no slot; the familiar's forms | `itemFixes`, familiars.js on `summon` |
| Warlock | Pact of the Tome | the book | Book of Shadows item; its spells come and go with it; swaps | `linkItems`, `addRestChoice`; its pool and swaps are its own code |
| Warlock | Armor of Shadows, Eldritch Mind | - | - | data |
| Wizard | Arcane Recovery | after a Short Rest, or its use | slots back up to half the level | `recoverSpellSlots`, `restChoices` |
| Wizard | Ritual Adept | casting a ritual from the book | - | casting.js (rituals), `isClassSpell` |

## Still to become legos

Parts still written inside one feature's code. Each one becomes a generic lego (named for what it does, not for the feature), and the feature is moved onto it.

| Part | Where | What it does | Could be shared with |
|---|---|---|---|
| Smite chooser | paladin.js `smite`, `choicesFor` | one button after a hit for every "cast on a hit" spell prepared, damage scaled by slot level (paid with `payCasting`, its save with `cardSave`) | Eldritch Smite (L5 invocation), any "after you hit, cast" feature |
| Rage keeps going | barbarian.js `keep`, `onTurnEnd` | ends at the end of a turn unless it made an attack roll or forced a save | other "lasts while you keep attacking" effects |
| Roll modes for saves and checks | barbarian.js `dangerSense` | changes a save's advantage when a condition holds | Danger Sense (L2), Extended Spell, anything giving advantage on saves "while X". `rollModes` covers attack rolls only |
| Can't cast while shifted | druid.js `wildShapeCast` | no spells in a Wild Shape form, with Change (leave the form, then cast) | `cantUseWhile` with an "instead" choice (L2) |
| Pact weapon one at a time | warlock-pacts.js `onPactFormed` | forming a pact weapon ends the last (a bonded weapon's enchantment, a conjured one) | `conjureItem`'s `key` covers conjured ones only |
| Book of Shadows pool | warlock-pacts.js `openBook` | fill empty places from the compendiums, one swap a level | Wizard's spellbook count (S4) |
| Bonus Unarmed Strike | monk.js (the action tracker) | a Bonus Action attack after the Attack action | Two-Weapon Fighting's extra attack |
