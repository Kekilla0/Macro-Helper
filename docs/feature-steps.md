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
| Warlock | Pact of the Tome | the book | Book of Shadows item; its spells come and go with it; swaps | `linkItems`, `addRestChoice` (`count`), `addSpellPool` |
| Warlock | Armor of Shadows, Eldritch Mind | - | - | data |
| Wizard | Arcane Recovery | after a Short Rest, or its use | slots back up to half the level | `recoverSpellSlots`, `restChoices` |
| Wizard | Ritual Adept | casting a ritual from the book | - | casting.js (rituals), `isClassSpell` |
| Wizard | Spellbook | a Wizard level, Add a Spell | 6 + 2 a level free places (Savant school places), spell scrolls copied for 50 GP a level | `addSpellPool` (`extra`), `payCoins`, `addRestChoice`; reading a scroll's spell is its own |

## Level 2

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
| Sorcerer | Font of Magic | its use | a window: a slot into Sorcery Points, or points into a slot (2024 costs and levels), the slot past the maximum, gone on a Long Rest | `spellSlots`, `addSpellSlot`, `spendUses`; the window and its costs are its own |
| Sorcerer | Metamagic (cast-time options) | casting a spell | which option (or none), paid in Sorcery Points once cast; Distant: range x2 (Touch 30 ft); Quickened: a Bonus Action, no other level 1+ spell that turn; Subtle: no V, S or uncosted M; Twinned: +1 target; Transmuted: the damage type; Extended: durations x2 (24 h), advantage on its Concentration saves | `castingChoice`, `cantUseWhile` (after Quickened), `onDamage` (`setType`), `extendDurations`; which spells each option fits is its own |
| Sorcerer | Careful Spell, Heightened Spell | the save card | toggles on its rows: up to the CHA modifier succeed, no damage where a success takes half / one creature's first save at disadvantage | `saveRowToggle` |
| Sorcerer | Empowered Spell, Seeking Spell | the card, after the roll | the lowest CHA-modifier damage dice / a missed spell attack rolled again, paid, once | `rerollButton` |
| Sorcerer | Metamagic (swap) | gaining a Sorcerer level | one option replaced per level, from the compendiums | `addRestChoice` (`count`), `pickFromCompendium` (`key`), `replaceItem` |
| Warlock | Magical Cunning | its use | not while every Pact slot is full | `cantUseWhile` |
| Warlock | Agonizing Blast, Eldritch Spear, Repelling Blast | the invocation picked | which known Warlock cantrip; its enchantment on it; moved on a level | `pickOwned`, `enchant`, `addRestChoice` (`count`); which cantrips qualify is its own |
| Warlock | Repelling Blast (push) | its cantrip's hit | the GM's push 10 ft, Large or smaller | the card's moves (as the Push mastery) |
| Warlock | Devil's Sight | its token | its detection mode | `addSense` (its detection mode is its own) |
| Warlock | Fiendish Vigor, Mask of Many Faces, Otherworldly Leap, Misty Visions | - | - | data (Misty Visions: see plutonium-notes) |
| Wizard | Scholar | - | - | data |

## Feats

| Feat | Trigger | Steps | Built on |
|---|---|---|---|
| Sharpshooter | a ranged weapon attack | ignores Half and Three-Quarters Cover (thrown too); a Ranged weapon: no threatened or long-range disadvantage | `ignoresCover`, `ignoresDisadvantage` |
| Spell Sniper | a spell attack | ignores Half and Three-Quarters Cover; no threatened disadvantage; +60 ft (range 10 ft or more) | `ignoresCover`, `ignoresDisadvantage`, `addRange` |
| Crossbow Expert | a crossbow attack | no Loading limit; loads with no free hand; no threatened disadvantage; a Light crossbow's extra attack adds the modifier | `ignoresProperty`, `ignoresDisadvantage`, `onDamage` |
| Elemental Adept | adding it; its spells' damage | a damage type per copy; that type ignores Resistance; 1s count as 2s | `itemChoice` (`unique`), `ignoresResistance`, `damage.minDie` (`types`) |
| Poisoner | Poison damage | ignores Resistance | `ignoresResistance` |
| Crusher | a hit dealing Bludgeoning; a critical one | once a turn a 5 ft push (one size larger at most); critical: attacks against it have advantage until the attacker's next turn | `onHitMove` (`once`, `larger`), `addRow` (`withDamage`), `giveEffect` (rule `attackersMode`) |
| Piercer | a hit dealing Piercing; a critical one | once a turn reroll a damage die; critical: one more Piercing die | `rerollButton` (`once`), `onDamage` (`critDice`) |
| Slasher | a hit dealing Slashing; a critical one | once a turn -10 ft Speed until the attacker's next turn; critical: disadvantage on its attacks until then | `addRow` (`once`, `withDamage`), `giveEffect` (rule `attacksMode`) |
| Great Weapon Master | a Heavy weapon's damage | + PB, Attack action on its turn | `onDamage`, `isAttackAction` |
| Shield Master | a melee weapon hit within 5 ft; a DEX save for half | once a turn: STR save, then push 5 ft or Prone (the attacker's choice); Interpose Shield: a Reaction after a success, no damage | `onHit` (no formula, `attackAction`, `within`), `rollSave`, `forcedMove` / `giveCondition`, `saveDamage` (`reaction`) |
| Charger | a melee hit after a straight run | 10 ft or more straight toward it: once a turn 1d8 or a 10 ft push | `chargedAt`, `onHit` (`attackAction`), `onHitMove` |
| Defensive Duelist | hit by a melee attack | holding a Finesse weapon: a Reaction, + PB AC against melee until its next turn, the hit judged again | `onAttacked` (`self`), `raiseCardAC`, `giveEffect` (rule `acOnlyAgainst`) |
| Speedy | the Dash action; an Opportunity Attack at it | Dashed: Difficult Terrain costs nothing extra this turn; OAs at it have disadvantage | `ignoresTerrain` (`when` Dashing), `rollModeFrom` (`trait`, `tags.opportunity` / `rollItem.usedTags`) |
| Athlete | always; standing up | Climb Speed = Speed; standing costs 5 ft | `speedAs`, `standUpCost` |
| Grappler | an Unarmed Strike hit; attacking someone it holds; dragging | once a turn its Grapple too (nothing spent); advantage; no extra cost for its size or smaller | `onHit` (no formula, `attackAction`), `rollModeFrom` (`trait`), `dragsFreely` |
| Keen Mind, Observant | Study / Search | a Bonus Action instead (its choice) | `actionAs` |
| Charger (Improved Dash) | the Dash action | 10 ft more movement | `onDefaultAction`, `useMovement` |
| Heavy Armor Master | an attack's B / P / S damage | in Heavy armor, PB less (Plutonium's always-on effect off) | `reducesDamage` (`attacks`), `wearsArmor`, `itemFixes` |
| Chef | Replenishing Meal; a Hit Point Die spent | up to 4 + PB eaters get an effect: their first Hit Die before their rest ends heals 1d8 more | a use step, `pickTargets`, `giveEffect` (rule `hitDieBonus` + `hitDieBonusOnce`, dnd5e's `shortRest` expiry) |
| Inspiring Leader | a Short or Long Rest | up to six allies within 30 ft gain level + WIS / CHA temp HP | `itemChoice` (ability), `addRestChoice`, `pickTargets`; Plutonium's activities |
| Mage Slayer | its damage to a Concentrating creature; a failed INT / WIS / CHA save | that Concentration save at disadvantage; Guarded Mind: succeed instead, once a Short Rest | `concentrationModeFrom`, `onFailedTest` (`when`, `succeed`) |
| Ritual Caster | adding it, the Proficiency Bonus growing; casting a Ritual | PB level 1 Rituals always prepared (its chosen ability); Quick Ritual: normal time, no slot, once a Long Rest | `itemChoice`, `addSpellPool`, `addRestChoice` (`classes: "any"`), `quickRitual` |
| Skulker | always; the Hide action in combat | Blindsight 10 ft; advantage on Hide's Stealth (Plutonium's always-on advantage off) | `addSense`, `actionRollMode`, `itemFixes` |
| Telekinetic | its Mage Hand; Telekinetic Shove's failed save | no V or S, 30 ft more range; a 5 ft push or pull (the GM picks) | `addRange`, `dropsComponents`, `onSaveMove` (two directions) |
| Medium Armor Master | wearing Medium armor, DEX 16+ | AC adds up to +3 DEX (Plutonium's wrong-key effect off) | `acDexCap`, `itemFixes` |
| Weapon Master | a Long Rest | one more weapon mastery, a kind it's proficient with | `extraMasteries` (Weapon Mastery's Rest Choices) |
| Poisoner (Brew Poison) | Apply Poison; the weapon's damage; the rider save | a dose spent; the poison ends with the damage (or 1 minute); Poisoned until the end of its next turn | `itemFixes`, effect rule `endsOnDamage`, the card's effect flag `until` |
| Durable | death saves; a Bonus Action | advantage; spend a Hit Die | Plutonium's data |
| Savage Attacker | a weapon hit | once a turn its damage rolled again, either applied | `rerollButton` (`roll: "again"`, `once`) |
| Lucky | its own D20 Test; an attack roll against it | a Luck Point: a second d20, the higher kept; against it the lower (the GM's change) | `d20Button` (`keep`, `against`, `cost`) |
| Tavern Brawler | its Unarmed Strike; a hit with it | 1d4 + modifier, 1s rerolled; once a turn a 5 ft push | `unarmedDamage`, `onHitMove` |
| Alert | its initiative rolled | swap with a willing ally before a turn passes | `initiativeSwap` |
| Healer | a healing spell; using the feat | 1s on its healing dice rerolled; Battle Medic: a creature within 5 ft spends a Hit Die, sized by what it has | `onDamage` (`reroll`); Battle Medic its own code |

## Still to become legos

Parts still written inside one feature's code. Each one becomes a generic lego (named for what it does, not for the feature), and the feature is moved onto it.

| Part | Where | What it does | Could be shared with |
|---|---|---|---|
| Rage keeps going | barbarian.js `keep`, `onTurnEnd` | ends at the end of a turn unless it made an attack roll or forced a save | other "lasts while you keep attacking" effects |
| Pact weapon one at a time | warlock-pacts.js `onPactFormed` | forming a pact weapon ends the last (a bonded weapon's enchantment, a conjured one) | `conjureItem`'s `key` covers conjured ones only |
| Pool conversion window | sorcerer.js `font` | one resource turned into another at set rates (spell slots and Sorcery Points, both ways) | homebrew pools traded for slots or uses |
| Cast-time damage type | sorcerer.js `chooseFor` / `transmute` | a damage type chosen as it's cast, used for its damage (and a reroll within the minute) | `damageTypeChoice` with a type chosen before the roll |
| Level 1+ spells this turn | sorcerer.js (`leveledSpell` on `dnd5e.postUseActivity`) | marks a level 1+ spell cast this turn, slot or not | casting.js's one-slot-a-turn mark (slots only) |
| Card AC raised (Shield, monster Parry) | spell-actions.js `shieldAsGM`, creature-traits.js `parryAsGM`, subclasses/common.js `changeRollAsGM` (`ac`) | a creature's AC higher on a card that's out, once | `raiseCardAC` (Defensive Duelist) : move them onto it |
| A push after a hit (mastery Push) | masteries.js `pushMove` | the GM's push button, once per attack, a size limit | `onHitMove` (Crusher, Charger, Tavern Brawler) : move it onto it |
| Battle Medic | feats.js `battleMedic`, `battleMedicKit`, `battleMedicHitDie` | heals by a Hit Die the healed creature spends (its player picks the size), a Healer's Kit use paid | a monster's "spend a Hit Die to heal", Chef-like Hit Die riders |
| Shared form effects | druid.js `linkNew`, `endPartner` | an effect on a form goes on its original too, and ends on both | other transformations (Polymorph keeps none : only `transform` users that share) |
