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
| Paladin, Ranger | Smite and strike spells (Divine Smite, Ensnaring Strike, Hail of Thorns) | a weapon hit | one button for every smite spell prepared; pay with a free use or a slot; damage box; the spell's save on the card; Bonus Action, once a turn | `castOnHit` (on `payCasting`, `cardSave`), `countedUses` (free Divine Smite) |
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

## Level 2

The Sorcerer's Font of Magic and Metamagic come in their own round (L2b).

| Class | Feature | Trigger | Steps | Built on |
|---|---|---|---|---|
| Barbarian | Danger Sense | a DEX save | advantage, not while Incapacitated | `bonusOnlyWhen` (its effect switched off while Incapacitated) |
| Barbarian | Reckless Attack | its use, on its turn | Reckless until its turn starts; advantage on its STR attacks and on attacks against it | `cantUseWhile` (not its turn), `addTimedEffect`, `rollModeFrom` |
| Bard | Expertise, Jack of All Trades | - | - | data |
| Cleric | Channel Divinity, Divine Spark | - | - | data |
| Cleric | Turn Undead | its use | every Undead within 30 ft not on its side targeted, no pick; circle shown until the turn ends; Turned ends on damage or the Cleric Incapacitated | `emanation`, `endsWhen`; the "is Undead" filter is its own |
| Druid | Wild Shape | its use | a known form (one swap a Long Rest); the form taken on the GM's client; effects shared; uses spent in the form kept; ends at 0 time, Incapacitated or dead; no spells in a form (leave it, then cast) | `transform` / `revert`, `addRestChoice` (`count`), `cantUseWhile` (`instead`); the forms its level allows, the Leave / New form choice and the shared effects are its own |
| Druid | Wild Companion | its use | the familiar | `summon`, `summonKind`; paying for it is data |
| Fighter | Action Surge | its use | one more Action this turn | `actionTracker.modify` |
| Fighter | Tactical Mind | a failed ability check | +1d10; Second Wind spent only if it then succeeds | `onFailedTest` (`cost`, `pay: "success"`) |
| Monk | Flurry of Blows | its use | a Focus Point; the Unarmed Strike 2 or 3 times, together a Bonus Action; cards tagged for Open Hand | `spendUses`, `multiattack` (`economy`, `tag`); 2 or 3 by level |
| Monk | Patient Defense, Step of the Wind | its use | Disengage (Dash), with a Focus Point also Dodge (Disengage) | `useDefaultAction`; which ones is its own |
| Monk | Unarmored Movement | armor, shield, hands change | its speed only while unarmored | `bonusOnlyWhen`, `isUnarmored` |
| Monk | Uncanny Metabolism | the initiative roll | a button while its use is left (the first roll with Initiative Each Round) | `onInitiative` |
| Paladin | Paladin's Smite (and the smite spells) | a melee weapon hit | one button for every smite prepared; free Divine Smite or a slot; damage box; its save on the card; Bonus Action, once a turn | `castOnHit` (on `payCasting`, `cardSave`), `countedUses`; Divine Smite's +1d8 against a Fiend or Undead is its own |
| Paladin, Ranger | Fighting Style | - | the L1 row; Blessed / Druidic Warrior: Plutonium asks for the cantrips | data |
| Ranger | Deft Explorer | - | - | data |
| Ranger | Ensnaring Strike, Hail of Thorns | a weapon hit (Hail : ranged) | its save on the card (Hail : everyone within 5 ft of the target) | `castOnHit` (the smites' button) |
| Rogue | Cunning Action | its use | Dash, Disengage or Hide as the Bonus Action | `useDefaultAction` |
| (anyone) | Hide (Default Action) | its use | the GM's Allow / Decline, nothing spent before; Stealth DC 15; Invisible | `askToUse`, `setStatus` |
| Warlock | Magical Cunning | its use | not while every Pact slot is full | `cantUseWhile` |
| Warlock | Agonizing Blast, Eldritch Spear, Repelling Blast | the invocation picked | which known Warlock cantrip; its enchantment on it; moved on a level | `pickOwned`, `enchant`, `addRestChoice` (`count`); which cantrips qualify is its own |
| Warlock | Repelling Blast (push) | its cantrip's hit | the GM's push 10 ft, Large or smaller | the card's moves (as the Push mastery) |
| Warlock | Devil's Sight | its token | its detection mode | `addSense` (its detection mode is its own) |
| Warlock | Fiendish Vigor, Mask of Many Faces, Otherworldly Leap, Misty Visions | - | - | data (Misty Visions: see plutonium-notes) |
| Wizard | Scholar | - | - | data |

## Still to become legos

Parts still written inside one feature's code. Each one becomes a generic lego (named for what it does, not for the feature), and the feature is moved onto it.

| Part | Where | What it does | Could be shared with |
|---|---|---|---|
| Rage keeps going | barbarian.js `keep`, `onTurnEnd` | ends at the end of a turn unless it made an attack roll or forced a save | other "lasts while you keep attacking" effects |
| Pact weapon one at a time | warlock-pacts.js `onPactFormed` | forming a pact weapon ends the last (a bonded weapon's enchantment, a conjured one) | `conjureItem`'s `key` covers conjured ones only |
| Book of Shadows pool | warlock-pacts.js `openBook` | fill empty places from the compendiums, one swap a level | Wizard's spellbook count (S4) |
| Bonus Unarmed Strike | monk.js (the action tracker) | a Bonus Action attack after the Attack action | Two-Weapon Fighting's extra attack |
| Roll modes for saves and checks | (none yet) | advantage on saves or checks "while X" from code, not an effect | Extended Spell's Concentration advantage (L2b). Danger Sense now switches its effect with `bonusOnlyWhen` |
| Shared form effects | druid.js `linkNew`, `endPartner` | an effect on a form goes on its original too, and ends on both | other transformations (Polymorph keeps none : only `transform` users that share) |
