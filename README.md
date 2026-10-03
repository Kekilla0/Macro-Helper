# Macro Helper

Small reusable helpers for macros, item macros, hook macros and one-click roll cards for Foundry VTT.

- **Foundry:** v14 (verified 14.368)
- **System:** Helpers, Item Macro and Hook Macros work in any system. Roll Item and the size, status and damage helpers need dnd5e 6.x.
- **Recommended:** [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper)

## Install

In Foundry's **Add-on Modules** tab, click **Install Module** and paste this manifest URL:

```
https://github.com/Kekilla0/Macro-Helper/releases/latest/download/module.json
```

## Settings

**Configure Settings → Macro Helper** has one sub-menu per feature: **Helpers**, **Item Macro**, **Hook Macros** and **Roll Item**. Each one can be turned off on its own. Settings are the GM's and apply to everyone. The one exception is Roll Item's **Pick Targets**, which each player sets for themselves, so players only see the Roll Item sub-menu, with just that setting.

**Weapon Property Rules** (in **Helpers**, default *Warn*): weapon properties are applied from the weapon's data, following dnd5e's **Rules Version** setting (Modern 2024 / Legacy 2014). Like the other settings here, they apply to every attack roll.
- **Heavy:** disadvantage below STR 13 (melee) or DEX 13 (ranged). With 2014 rules, Small and Tiny creatures instead.
- **Versatile:** two-handed when the other hand is free (no shield and no other weapon equipped), otherwise one-handed. The card shows which was used.
- **Allowed-use checks:**
  - A character's weapon must be equipped. Natural weapons and Unarmed Strike always count as in hand.
  - Two hands: a Two-Handed weapon (a bow, a greatsword) takes both, and any other weapon or a shield takes one. What else is equipped has to leave room for the weapon being used.
  - One Loading shot per turn.
  - A Light off-hand attack needs a Light main-hand attack first that turn.
  - Loading and Light are only tracked in combat.
- **Handling:**
  - *Warn* lets the roll happen.
  - *Block* stops it.
  - *Change* fixes what can be fixed, then rolls: it equips the weapon, puts away what's in the way (two-handed weapons first, then other weapons, then shields), and holds a Versatile weapon one-handed when the other hand is busy. Loading and Light can't be fixed, so they warn.
  - *Off* turns all of the above off, Heavy included.

**Species & Feat Rules** (in **Helpers**, on by default): traits and feats dnd5e has no data for, recognised by the item's identifier.
- **Brave** (Frightened), **Fey Ancestry** (Charmed) and **Dwarven Resilience** (Poisoned) give advantage on saves rolled from a card whose activity applies that condition.
- **Savage Attacker:** each weapon hit gets a button for its owner that rolls the damage again. Each roll has its own APPLY, and applying one hides the other. Once per turn in combat.
- **Alert:** right after the character's initiative is rolled, their player and the GM get a card listing allies in the combat. Clicking one asks that ally's player to agree, then the GM swaps the two initiatives. There's no question when you own both characters or no other player owns the ally. **Do not swap** closes the offer. It isn't available while either of them is Incapacitated, and the offer closes once a turn passes.
- **Lucky:** after an attack roll, the attacker's owner can spend a Luck Point to roll a second d20 and keep the higher. The owner of an attacked Lucky character can spend one to roll a second d20 and keep the lower; the GM carries that out, since it changes someone else's card. Advantage and disadvantage don't stack, and they cancel. If the new die changes whether it's a crit, the damage is rerolled to match.
- **Tavern Brawler:** your Unarmed Strike's own damage becomes 1d4 + STR, rerolling 1s (Enhanced Unarmed Strike and Damage Rerolls), unless it already rolls a die (a Monk's Martial Arts). Once per turn, an Unarmed Strike hit also gets a GM button to push the target 5 ft (homebrew obstacle rule included).
- **Healer:**
  - *Healing Rerolls:* 1s on a spell's healing dice are rolled again.
  - *Battle Medic:* using the feat picks a creature within 5 ft, reads its remaining Hit Dice (when it has several sizes, the creature's player picks which one; for an NPC or your own character, you pick), and rolls the matching "Heal dX". It needs a Healer's Kit with a use left, and spends one. The target's owner spends that Hit Die when they apply it from the card. Traits dnd5e does have data for, like Gnomish Cunning, Luck and Powerful Build, work through dnd5e as usual.

**Condition & Downed Rules** (in **Helpers**, on by default): the 5e condition rules dnd5e doesn't apply to attacks.
- **Attacks against** a Blinded, Paralyzed, Petrified, Restrained, Stunned or Unconscious creature have advantage. Against a Prone one, advantage within 5 ft and disadvantage beyond (so a ranged attack on a downed character is a normal roll: advantage and disadvantage cancel). Against an Invisible one, disadvantage.
- **Attackers** who are Blinded, Prone or Restrained have disadvantage; attackers who are Invisible have advantage.
- **Auto-crit:** a hit on a Paralyzed or Unconscious creature from within 5 ft is a critical hit, and its damage rolls as one.
- **Death saves:** a character at 0 HP who takes damage fails a death save, or two on a crit. A hit of at least their max HP, or massive damage while they're still up, is three failures. Applying the same card twice adds no more failures. At three failures the character is marked Dead, in or out of combat.
- **Why advantage or disadvantage:** the browser console (F12) logs one line per attack that had either, like "Goblin, Scimitar → Downed : Advantage : target Prone, within 5 ft · Disadvantage : Heavy weapon : they cancel out". That covers conditions, long range, being threatened, Heavy, flanking, Sap, Vex, the mode you chose, and held keys. Anything else shows as "another rule". Each player's console shows their own attacks.
- **Pick map:** when the attacker's own condition gives every attack disadvantage (Prone, Blinded, Restrained, Poisoned...), the whole range shows red, with a note in the banner.

- **Automatic save failures:** a Paralyzed, Petrified, Stunned or Unconscious creature fails STR and DEX saves. Its row skips the roll and shows "Auto-fail (Paralyzed)" with Apply sized as a failure. A Grapple card grapples it straight away.
- **Dodging:** attacks against a Dodging creature have disadvantage, if it can see the attacker (Vision Rules). dnd5e already gives the DEX save advantage.
- **Stable:** a Stable creature makes no death saves. It stops being Stable when it takes damage or regains HP.

**Vision Rules** (in **Helpers**, on by default): uses each token's own sight, the way Foundry works it out: walls, light and darkness, darkvision and other senses, Blinded and Invisible. When the GM attacks with an NPC, it's what the NPC sees, not what the GM's screen shows.
- **Picking targets:** you can't pick a creature your token can't see. Areas (Fireball, Burning Hands) aren't limited.
- **Attacks:** attacking a creature you can't see has disadvantage, and attacking one that can't see you has advantage. The console log line says which.
- **Threatened** (ranged attacks within 5 ft of an enemy) and **Dodging** both need that creature to see you.
- A token with sight turned off (or a scene without token vision) still follows the conditions: it sees nothing while Blinded, and never sees an Invisible creature. Otherwise it sees everything, with a warning in the console so you can spot tokens missing vision.

**Dodge & Help** (in **Helpers**, on by default): two items to import from [examples/items](examples/items) (right-click an item in the Items sidebar, Import Data), recognised by identifier. Each activity carries its own text, so the card shows only the one used:
- **Dodge:** Dodging until the start of your next turn.
- **Help** asks which of its three activities:
  - *Assist Attack:* pick an enemy within 5 ft. The next attack roll against it by one of your allies (not you) has advantage. The mark shows on the enemy and ends when used, or at the start of your next turn.
  - *Assist Check:* choose one of your skill or tool proficiencies from a list, then pick an ally within 30 ft who can hear you (not Deafened). Their next check with it has advantage. It ends when used, or at the start of your next turn; out of combat, only when used.
  - *Stabilize:* pick a creature at 0 HP within 5 ft and roll WIS (Medicine) against DC 10. On a success it's Stable.
  - The choice and the pick come first, so the card targets who was picked and says what for ("Assist Check: Bob has advantage on their next Athletics check"), on dnd5e's own card too.
- [examples/items/unarmed-strike.json](examples/items/unarmed-strike.json) is dnd5e's 2024 Unarmed Strike with separate Damage, Grapple and Shove activities.

**Equipment changes in combat** (with Weapon Property Rules on): equipping, unequipping, adding an equipped item or deleting one during a running combat whispers the GM a short table: **Round** (two digits, and whose turn it is), **Who**, **Equipped** (the item), **Status** (Equipped, Unequipped or Removed) and, for armor and shields, **Time** in bold: the 2024 time it takes (light 1 / 1 min, medium 5 / 1 min, heavy 10 / 5 min to don / doff; a shield a Utilize action). Nothing is blocked.

**Elevation:** distances count the height gap between tokens from their elevation, which you set by hand for flying or climbing. Each token is as tall as it is wide, so a Medium creature flying 5 ft up is still adjacent to one on the ground, and one 30 ft up is out of a sword's reach.

**Class Rules** (in **Helpers**, on by default): class features at levels 1-2, on top of what the items' own data does. So far:
- **Barbarian, Rage:** dnd5e's Rage effect already gives the resistances, the STR advantage and the Rage damage. The module adds:
  - *Turning it on:* using Rage turns its effect on and ends your Concentration. Using it again while raging extends it without spending a use (the Bonus Action extension).
  - *Rage damage:* only on attacks using Strength. A DEX melee attack doesn't get it, and a STR thrown attack does.
  - *How long:* until the end of your next turn. On each of your turns, an attack roll against an enemy, or posting a card that makes an enemy save (Grapple, Shove, any save aimed at an enemy), keeps it going. Otherwise it ends at the end of that turn, with a chat line saying why. Out of combat, dnd5e's 10 minutes apply.
  - *Ends early:* when you're Incapacitated, or equip heavy armor. You can't start a Rage in heavy armor.
  - *No spells:* casting a spell while raging is refused.
- **Barbarian, Danger Sense:** no DEX save advantage while Incapacitated. The save hover now names advantage from item effects ("Advantage : Danger Sense").
- **Barbarian, Reckless Attack:** dnd5e's item has no activity, so import [examples/items/reckless-attack.json](examples/items/reckless-attack.json) into the Items sidebar and run [upgrade-items.js](examples/item-macros/upgrade-items.js) on the character: it gives their own Reckless Attack the activity and keeps it under Barbarian. Using it on your turn makes you Reckless until the start of your next turn: your STR attacks have advantage and attacks against you have advantage. The attack pick map colours follow.

**Compact Initiative** (in **Helpers**, off by default): instead of one chat message per combatant, one card per round lists everyone's initiative, highest first. Hover a total for its dice. The combatant's owner and the GM get a Reroll button on its row, which follows the Advantage setting and moves the combatant in the tracker. Hidden combatants go on a second card only the GM sees. Players' own initiative rolls land on the same card. Dice So Nice still shows the dice. The card follows the tracker: after a swap or an edit it shows the new initiative and order (the roll stays in the hover). An **Alert** character's swap offer appears here instead of its own card: its owner gets a swap button on each ally's row, previewing where both would end up ("Bob would go 2nd (15), Aria 5th (9)"), and **Do not swap** on its own row. The buttons go once a turn passes. With dnd5e's ability score tie-breaker on, only the rolled initiative swaps: each creature keeps its own DEX decimal.

**Auto-Roll Initiative** (in **Helpers**, off by default): when combat begins, everyone who hasn't rolled initiative rolls, and the first turn goes to the top of the order. Anyone added to the combat later rolls as they join, without moving the current turn.

**Conditions on Attack Rolls** (in **Helpers**, dnd5e, on by default): Poisoned gives disadvantage on attack rolls, as does Exhaustion 3 with 2014 rules and Heavily Encumbered on Strength and Dexterity attacks. dnd5e 6 lists these but only applies them to ability checks. This covers every dnd5e attack, and it works the same whether the creature has the Poisoned condition or an effect whose Statuses include Poisoned.

## Helpers

Small functions for macros, available as `MacroHelper.x(...)` or `game.modules.get("macro-helper").api.x(...)`.

| Helper | What it does |
|---|---|
| `tokenOf(thing)` | The canvas token for a token, token document, actor or item. Falls back to your selected token. |
| `actorOf(thing)` | The actor for a token, token document, actor or item. |
| `distanceBetween(a, b)` | Feet between two tokens, edge to edge on the grid, including the height gap from their elevation. Adjacent squares, diagonals included, are 5 ft. Further out it follows the **Range Shape** setting: *Circle* (true distance, the default) or *Square* (5e: every diagonal step is 5 ft). |
| `canSee(viewer, target)` | Whether one token can see another by its own sight (Vision Rules): walls, light, darkvision, Blinded, Invisible. Without sight to work it out (vision off on the token or the scene), only the conditions count: Blinded sees nothing, Invisible can't be seen. Always true when the setting is off. |
| `getRange(item, { long, thrown })` | How far an item reaches: a melee weapon's reach, a ranged weapon's range, or a spell's range. |
| `pushDestination(thing, from, feet)`, `pushAway(thing, from, feet)` | Push a token straight away from another, square by square, stopping at walls and other creatures (Push mastery, Shove, Thunderwave). It's measured by the **Range Shape** setting. `pushAway` needs permission to move the token, and returns how many feet it moved (0 if blocked straight away). |
| `addLight(thing, light, { key })`, `removeLight(thing, { key })`, `hasLight(thing, key)` | Give a token light (`{ bright, dim, color, animation }`) and take it away again. The token's original light comes back when the last source (`key`: "light", "torch"…) is removed. |
| `getTokensInArea(area, { includeHidden, filter })` | The tokens inside a template (a Region in v14). A token counts when any square of its space is inside. |
| `getTokensWithin(origin, feet, { disposition, includeDead, includeHidden, filter, includeSelf })` | Tokens within a distance, nearest first. `disposition` is `"any"`, `"enemy"` or `"ally"`. |
| `highlightRange(origin, feet, { normal, tokens, selected })` | Shows a range on the map, on your screen only: blue within `normal`, red from there out to `feet` (long range), orange candidates and green picks. Returns `{ select, clear }`. |
| `isEnemy(a, b)`, `isAlly(a, b)` | Compares the two tokens' dispositions. |
| `getFlanker(attacker, target)`, `isFlanking(attacker, target)` | The attacker's ally flanking the target with them (DMG rule: both next to it, on opposite sides or corners), or `null`. |
| `isThreatened(thing, { range, includeIncapacitated, includeHidden })` | Whether an enemy (opposite disposition) is within 5 ft, not counting incapacitated, dead or GM-hidden ones. In 5e, ranged attacks made while threatened have disadvantage. |
| `getThreats(thing, { range, includeIncapacitated, includeHidden })` | Those creatures (Hostile or Neutral, not Incapacitated, able to see it), nearest first. |
| `getEnemiesWithinRange(item, { numberOfEnemies, range, long, thrown })` | Your targets in range first, then every other enemy in range, nearest first. |
| `selectTargets(tokens, { numberAllowed, within, setTargets, prompt, origin })` | Picks a group of targets standing within `within` ft of each other. `numberAllowed` is a number or `group => number`. With `prompt`, and no targets of your own, you choose the targets in a dialog, with the range and your picks shown on the map. **Async**, so use `await`. |
| `isValidGroup(tokens, { numberAllowed, within })` | Checks a group against those rules. Returns `{ valid, reason }`. |
| `setTargets(tokens)` | Replaces your targets. |
| `getSize(thing)` | dnd5e size, e.g. `{ key: "lg", value: 3, label: "Large" }`. |
| `stepSize(key, steps)` | Another size category, e.g. `stepSize("lg", -1)` → `"med"`. |
| `setStatus(thing, status, active, { overlay })` | Turns a condition on or off. It never flips a status that's already in that state. |
| `setDefeated(thing, defeated)` | Marks the creature defeated, or not, in the current combat. |
| `stabilize(thing)` | A creature at 0 HP: resets its death saves and makes it Stable. The GM does it when you don't own the creature. Returns true when it worked. |
| `damage(thing, value, type, { properties, multiplier, ignore })` | Damages a creature through dnd5e, so resistances, immunities and temp HP apply. `value` can be a number, a formula (`"2d6 + 3"`), or parts `[{ value, type }]`. |
| `heal(thing, value)` | Heals a creature, up to its max HP. `value` can be a number or a formula. |
| `tempHP(thing, value, source)` | Gives temp HP. The higher of the current and new amount is kept (they don't stack). `source` is recorded in `flags["macro-helper"].tempHP` when applied. |
| `dropsToZero(thing, amount)` | Whether this much damage drops a creature that's still up to 0 HP (temp HP soak first). |
| `isKilledOutright(thing, amount)` | Whether it's massive damage: what's left after reaching 0 HP is at least the creature's HP max. |
| `preventDropToZero(thing, amount, updates, { hp, massiveDamage })` | For "reduced to 0 but not killed outright" features. Use it in a `dnd5e.preApplyDamage` Hook Macro, before any `await`: it changes dnd5e's pending update so the creature stays on `hp` (1). Massive damage still kills unless `massiveDamage: false`. Returns whether it kept them up. |
| `getLastDamage(thing)`, `clearLastDamage(thing)` | The last damage a creature took through dnd5e's damage application, and the card that dealt it: `{ amount, message, at }`. For reactions that reduce damage, like Stone's Endurance. A reaction clears it once it's used it, and any rest clears it. |
| `usedThisTurn(thing, key)`, `markUsedThisTurn(thing, key)` | "Once per turn" in combat (Savage Attacker, Sneak Attack): whether it's been used this turn, and marking it used. Out of combat there are no turns, so it's never used. |
| `rollSave(thing, ability, dc)` | Rolls a saving throw against a DC, with no dialog. Returns `{ success, total, roll }`. |
| `addTimedEffect(thing, effectData, { of, until })` | Adds an effect that lasts until the start (`"turnStart"`) or end (`"turnEnd"`) of someone's next turn in combat (`of`, default the creature itself). The active GM removes it then. Out of combat it stays until removed. |
| `recoverSpellSlots(thing, { levels, maxLevel, item, chat })` | A dialog to choose expended spell slots to recover, up to a combined level, and none above `maxLevel` (5). Used for Arcane Recovery and Natural Recovery. With `item`, it needs a use left and spends one. Returns `{ level: recovered }`. |
| `findItem(thing, query, { type })` | One of the actor's items by name (any case), identifier, id or uuid. `query` can be several (`["Relentless Endurance", "Relentless"]`, first match wins) or a function. |
| `splitToken(thing, { copies, hp, scale, stepSize, chat })` | Replaces a token with smaller copies that share its HP (Ochre Jelly's Split). GM only. |
| `pickAndAttack(item, { count, repeat, disposition, within, long, confirm, clearTargets, strict, threatened, event })` | The whole attack in one call: clears your targets, you pick on the map, then one attack roll per pick. With `repeat`, a target can be picked more than once (Multiattack: both attacks at one foe). Fewer picks than `count` is fine: press Enter. Targets beyond reach get thrown at when the weapon can be thrown, targets at long range are attacked with disadvantage, and so are ranged or thrown attacks while the attacker is threatened (melee attacks aren't). Nobody attacks with what they don't have (quantity 0, not enough to throw or shoot) unless `strict: false`. Problems show as notifications. |
| `pickAttack(item, { count, repeat, activity, used, ... })` | The picking half of `pickAndAttack`: checks, the map pick, and the ammunition and throw checks. Returns `{ attack, targets, attackMode, disadvantage }` to pass to `rollItem`, or `null`. For when you want to pick now and roll your own way. |
| `isOtherHandFree(item)`, `hasShieldEquipped(thing)` | From what's equipped: whether the hand not holding this weapon is free (no shield, no other weapon), and whether a shield is equipped. |
| `attackModeFor(item, target, { long })` | The attack mode: Versatile weapons `"twoHanded"` when the other hand is free, else `"oneHanded"`; weapons that can be thrown, `"thrown"` beyond reach (within thrown range), otherwise the melee mode. `null` when dnd5e's usual mode is fine. |
| `isLongRange(item, target)` | Whether a target is beyond the weapon's normal range but within its long range (ranged or thrown), where 5e attacks have disadvantage. |
| `isRangedItem(item)` | Whether the item is a ranged attack by nature: a ranged weapon or a ranged spell attack. A Dagger isn't. |
| `isRangedAttack(item, target)` | Whether attacking this target is a ranged attack: a ranged item, or a thrown weapon thrown at it. |
| `canThrow(item)` | Whether the weapon has the Thrown property. |
| `getAmmunition(item)` | The ammunition item dnd5e would use for the weapon's attack, or `null`. |
| `pickTargets(origin, { count, range, disposition, numberAllowed, within, confirm, useTargets, repeat, filter })` | Pick targets by clicking them on the map, with the range and candidates shown. Enter confirms, Esc cancels. With `repeat`, clicking a picked token picks it again and right click takes one away; the picks come back once per pick (`[A, A, B]`). Targets you already have in range are used as they are; `useTargets: false` clears them and always asks. **Async**. |
| `multiattack(thing, plan, { repeat, event, attack })` | A Multiattack written out, e.g. `[{ weapon: "Bite", count: 1 }, { weapon: "Claw", count: 2 }]`, made weapon by weapon: a pick on the map and a card per weapon. `weapon: ["Shortsword", "Longbow"]` asks how to split the attacks first. `repeat` (default `true`) lets a target take more than one of a weapon's attacks. Enter stops with fewer picks, and Esc skips that weapon. |
| `useAndApply(item, { activity, to, max, event })` | Uses the item the dnd5e way, then applies the healing or damage it rolled to `to` (default yourself), never more than `max`. A two-line Second Wind: `return item.useAndApply();` |
| `getAppliedConditions(card)` | The conditions a chat card's activity applies (its effects' statuses, and an on-hit rider's), e.g. `Set { "frightened" }`. Used by Brave: is this save against Frightened? |
| `getHealing(item, { average })` | How much an item heals, as a formula: its Heal activity, else its Utility roll formula, else its description ("heal 11 hit points" gives `"11"`, "regains 10 (3d6) hit points" gives `"3d6"`, or `"10"` with `average`). `null` if it doesn't say. |
| `getUses(item)` | The item's limited uses `{ value, max, spent }`, or `null` if it has none. |
| `hasUses(item, amount)` | Whether it has that many uses left. Items without limited uses always do. |
| `spendUses(item, amount, { warn })` | Uses up `amount` (1) uses, or gives them back if negative. Returns the fresh item, or `null` if there weren't enough (with a warning). |
| `useActivity(item, { activity, configure, event })` | Uses the item the dnd5e way (its card, uses, spell slot, action, effects) from inside its own Item Macro, with no dialog unless `configure`. Returns dnd5e's results, or `null` if it couldn't be used, so the macro can stop there. |
| `updateItem(item, changes)` | Updates an item and returns the fresh copy. Items on unlinked tokens are rebuilt when updated. |
| `setBaseDamage(item, { number, denomination, types, bonus })` | Sets a weapon's base damage, only if it's different. |
| `wait(ms)`, `waitFor(condition, { interval, timeout })` | Small async helpers. |
| `rollItem(item, { activity, count, targets, attackMode, disadvantage, event })` | Rolls an item as a Roll Item card (see below). `targets` gives one attack per token, in order (the same token twice is two attacks at it), instead of spreading `count` over your targets. `attackMode` is a dnd5e mode (`"thrown"`…), or a function `target => mode` that picks one per target. `disadvantage` is `true`, or `target => boolean` per target. Thrown attacks and ammunition are used up, as with dnd5e's own attacks. |

### Methods on tokens, actors and items

The helpers are also added as methods on the things they act on. Turn this off in the **Helpers** settings.

| On | Methods |
|---|---|
| Token | `getCreatureSize()`, `distanceTo(other)`, `getTokensWithin(feet, opts)`, `isEnemy(other)`, `isAlly(other)`, `isThreatened()`, `getThreats()`, `canSee(other)`, `setStatus(...)`, `setDefeated(...)`, `stabilize()`, `damage(value, type)`, `heal(value)`, `tempHP(value, source)`, `dropsToZero(amount)`, `isKilledOutright(amount)`, `preventDropToZero(amount, updates, opts)`, `findItem(query, opts)`, `split(opts)`, `highlightRange(feet, opts)`, `pickTargets(opts)` |
| TokenDocument | The same as Token, without `highlightRange`. |
| Actor | `getCreatureSize()`, `getTokensWithin(...)`, `isEnemy(...)`, `isAlly(...)`, `isThreatened()`, `getThreats()`, `canSee(...)`, `setStatus(...)`, `setDefeated(...)`, `stabilize()`, `damage(...)`, `heal(...)`, `tempHP(...)`, `dropsToZero(...)`, `isKilledOutright(...)`, `preventDropToZero(...)`, `findItem(...)`, `usedThisTurn(key)`, `markUsedThisTurn(key)`, `multiattack(plan, opts)` |
| Item | `pickAndAttack(opts)`, `pickAttack(opts)`, `getRange(opts)`, `getEnemiesWithinRange(opts)`, `pickTargets(opts)`, `attackModeFor(target)`, `isLongRange(target)`, `isRangedItem()`, `isRangedAttack(target)`, `canThrow()`, `getAmmunition()`, `multiattack(plan, opts)`, `useAndApply(opts)`, `getHealing(opts)`, `getUses()`, `hasUses(amount)`, `spendUses(amount)`, `useActivity(opts)`, `setBaseDamage(damage)`, `updateFresh(changes)`, `rollItem(opts)` |

A method is never added over an existing one from Foundry, the system or another module. That's why size is `getCreatureSize()`: Foundry's own `getSize()` is the token's size in pixels.

```js
// Greataxe: hit up to 2 Medium, or 3 Small, targets within 5 ft of each other
const enemies = item.getEnemiesWithinRange();
const numberAllowed = group => {
  const sizes = group.map(t => t.getCreatureSize()?.value ?? 2);
  return sizes.some(s => s >= 3) ? 1 : sizes.some(s => s === 2) ? 2 : 3;
};
const group = await MacroHelper.selectTargets(enemies, { numberAllowed, within : 5, setTargets : true, prompt : true, origin : item });
if(group.length) return item.rollItem({ count : group.length });
```

## Item Macro

- **Storing a macro:** store a macro on any item, or on a dnd5e activity, from the **</>** button in its sheet's title bar. The button turns gold once a macro is set.
- **The editor** is Foundry's own macro editor. Players need Foundry's script macro permission, and the GM can stop players editing item macros altogether with **Players Can Edit Item Macros**. Items with a macro still run it for everyone.
- **When it runs:** choose **Default only**, **Macro only**, or **Macro, then Default**. In the last mode, the macro can return `false` to skip the default.
- **Variables:** macros get `item`, `activity`, `actor`, `token`, `speaker`, `event`, `usage`, `dialog`, `message` and `scope`, plus `hook` and `args` (below; `null` and `[]` when the item is used).
- **Run on Hooks (GMs, items):** a passive feature's macro can also run when a hook fires, e.g. Relentless Endurance on *Damage about to apply*. It only listens while the creature has a token on the scene you're viewing, so nothing is left behind when it isn't on the battlefield.
  - **Only About This Creature** (on by default) runs it only when the hook is about this creature: the damaged actor, its token, its item, or its turn.
  - **Run For** is *Owner, where it happens*, meaning the client where the hook fires if that user owns the creature. Use *Active GM (once)* for hooks that fire for everyone, like *Actor changed* or *Combat turn*.
  - Only macros saved by a GM run from hooks. If a player changes one, its hooks stop until a GM saves it again.
  - The macro runs inside the hook, so until its first `await` it can change what the hook passed.

## Hook Macros

Run a world macro when something happens in the game, without installing a module for it.

1. Open a world macro (GM only).
2. Expand **Run on Hooks** under the Type line.
3. Pick hooks from the list, or type any hook name under **Custom Hooks**.
4. Choose **Run For**:
   - **Active GM (once):** the default, and right for most things.
   - **Every client:** runs wherever the hook fires. dnd5e roll hooks need this, because they only fire on the roller's client.

The macro gets `hook` (the hook's name) and `args` (its arguments). Only macros written by a GM run from hooks.

The macro runs inside the hook, so until its first `await` it can still change what the hook passed, such as the pending update in *Damage about to apply*. Returning `false` doesn't cancel the hook. For a feature that belongs to one creature, use an item macro's **Run on Hooks** instead (see Item Macro): it only listens while that creature is on the scene.

```js
// Run on "Turn changed" (combatTurnChange)
const [combat] = args;
ChatMessage.create({ content : `It's ${combat.combatant?.name}'s turn.` });
```

## Roll Item (dnd5e)

One card per use, built on dnd5e's own chat cards. Rerolls wait for Dice So Nice to finish.

| Activity | Card |
|---|---|
| Attack | Attack and damage rolled together. The crit range follows dnd5e and feats. Advantage and disadvantage follow the **Advantage / Disadvantage** setting. |
| Multiple attack rolls | Scorching Ray, Eldritch Blast and Magic Missile count their rolls from the cast level. Each one gets its own target, damage and APPLY tray. |
| Attack + on-hit save | Giant Spider, Ghoul and similar. Separate base and save damage, a save button, and a tray that halves damage for targets that saved. |
| Save | Damage is rolled up front. Targets roll their own saves. Half damage on a save is applied automatically. |
| Heal | Healing or temporary HP, rolled with its apply tray. |
| Damage only | Damage is rolled up front, with its apply tray. |
| Utility | The activity's roll formula is rolled onto the card. |

Damage shows one box per damage type. The APPLY trays use dnd5e's own resistance, immunity and vulnerability handling.

**Advantage / Disadvantage** (GM setting) has three choices:
- *Hold dnd5e's keys while rolling* (default Alt / Ctrl).
- *Ask before rolling:* an Advantage / Normal / Disadvantage prompt after targets are picked, once per card and once per reroll.
- *Neither:* only what the rules give.

Either way the choice is combined with long range, being threatened, conditions and masteries, and advantage and disadvantage cancel out.

**Damage After the Attack** (world setting, on by default): attack and damage are both still rolled automatically, but the card shows the attack first. The damage dice roll once the attack dice have landed, so crit damage dice don't give away a natural 20 early. This mostly matters with Dice So Nice; without it the damage follows straight away.

**Pick Targets** (a setting for each player, default *Always*): attacks rolled by Roll Item let you click your targets on the map first. Each creature is coloured by how the attack would roll against it: green advantage, yellow normal (or both cancelling), red disadvantage. The squares show the range: blue normal, red long range. Your own space stays plain when you can't pick yourself. It works like `pickAndAttack`: the range is shown, targets beyond reach are thrown at, and long range or a ranged attack while threatened gives disadvantage. It also checks you have enough ammunition or weapons to throw. The pick happens after dnd5e's use, so Scorching Ray knows its ray count from the cast level, and rays or attacks can pick a target again. If you pick fewer targets than rays, the rays are spread over your picks. Esc after casting still spends the slot.
- *Off* uses your targets as they are.
- *When you have no targets in range* picks only then.
- *Always* clears your targets and picks every time.

It needs your token on the scene you're viewing; without one, the attack rolls against your targets as usual.

**Weapon Mastery** (world setting, on by default): attack cards use the 2024 weapon mastery dnd5e gives the attack. It only gives one when the actor has mastered that kind of weapon (Weapon Proficiencies → Mastery on the sheet). Graze and the Sap / Vex advantage are part of the rolls. The buttons that change a target (Topple, Push, Slow, Sap, Vex) are outcomes, so only the GM sees and clicks them; nothing happens on its own. Cleave is another attack, so it's the roller's button. Each can be used once per attack, and only on targets the card shows were hit.

| Mastery | On the card |
|---|---|
| Graze | On a miss: damage equal to the attack's ability modifier, with the weapon's damage type and its own APPLY tray. Multiple-attack cards apply it to misses with the "apply hits" button. |
| Topple | On a hit: a button. The target makes a CON save (DC 8 + ability modifier + proficiency) and falls Prone on a failure. |
| Push | On a hit: a button that pushes the target 10 ft straight away, stopping at walls and other creatures. It doesn't work on Huge or larger creatures. |
| Sap | On a hit: a button. The target has disadvantage on its next attack roll before the start of the attacker's next turn. |
| Slow | On a hit: a button. The target's speed drops 10 ft until the start of the attacker's next turn. It doesn't stack. |
| Vex | On a hit: a button. The attacker has advantage on their next attack roll against that target before the end of their next turn. |
| Cleave | On a hit: a button, once per turn. Pick a second creature within 5 ft of the first and in reach, and attack it. Its damage leaves out a positive ability modifier. |
| Nick | Nothing to roll. It only changes when the Light extra attack happens. |

Sap and Vex are used up by the next attack roll they affect, from any sheet or card.

**Homebrew** (GM sub-menu, everything off by default): table rules that aren't in the books.
- **Flanking:** *Off* (rules as written), *Advantage*, or *+2 to the attack roll*. It uses the DMG optional rule: a melee attack against a creature with one of the attacker's allies on its opposite side, both next to it. A line between the two must pass through opposite sides or corners of its space, and allies who are down or incapacitated don't count. It applies to every attack roll, not only Roll Item's.
- **Initiative Each Round:** at the start of every new round, everyone rolls initiative again and the round starts from the top of the new order. Going back a round doesn't reroll. Effects lasting "until the start of your next turn" (Dodging, Help, Vex) end for whoever starts the new order, not whoever was first before the reroll.
- **Push Into Obstacles:** a Push cut short by a wall. If the target travels only part of the way (5 of 10 ft), it falls Prone. If it can't move at all, it falls Prone and takes 1d6 bludgeoning, rolled in chat and applied.

**Cover** (GM only): a small row of chips at the top of attack and save cards, one group per target: – (none), ½ (+2), ¾ (+5), ✕ (total).
- On an attack card, it raises that target's AC on the card and on its attack roll, from the AC it had before cover, so hit or miss, the tray, Apply and masteries all follow. ✕ makes the attack miss, even on a natural 20.
- On a save card, ½ and ¾ add +2 or +5 to that target's DEX save, including one already rolled: its total and success update. ✕ leaves the target out: no save and nothing applied.

**Save and heal cards** have one row per target:
- **Self only:** an activity that targets Self, or has Range Self with no area (Second Wind), is always for the caster. Your targets are cleared.
- **Save button:** shown to the token's owner and the GM. It rolls with the keys you hold, with no prompt. A choice of abilities (STR or DEX) gets a button each. Hovering shows what the roll will add before you click, for example "Bonus: +5 (Advantage: Dodging) = DEX (+3) + Prof (+2)". That includes cover and species traits against the card's condition.
- **Result:** shown once rolled, as the total and ✓ or ✗. Hovering it shows the dice behind it, for example "d20 : 2, 12 (Advantage, kept 12) · 12 + 2 = 14", plus any cover added since.
- **Apply button:** applies that target's damage, sized by its save (full, half or none), or its healing. Only the token's owner and the GM can use it, so a player can apply healing to their own character but not someone else's.
- **Applied:** once applied, the row shows the amount instead of the button, such as −7 in red or +5 in green. For an NPC behind the DM screen, players see ✓. Attack cards show the amount beside each target.
- **Once per card:** a card's damage or healing applies to each creature once (its rows, its hits and dnd5e's damage tray each count once). A second click warns instead. After rerolling damage that was already applied, change HP by hand.
- **Reroll and Lucky:** on each row with a save. dnd5e hides those save messages under the card, so the buttons are here instead.

On attack cards, damage is always rolled, but the APPLY tray only shows on a hit. A reroll that hits brings it back.

**Saves, ability checks, skills and initiative** (dnd5e's own roll messages) get buttons:
- **No dialog:** checks, skills, tools, saves, death saves and initiative from the sheet roll straight away, using the Roll Item **Advantage** setting: held keys count on *keys*, nothing counts on *neither*, and on *ask* dnd5e's own dialog opens.
- **Reroll:** for the roller and the GM; replaces the roll. Advantage or disadvantage is chosen the same way (keys held when you click, or the prompt).
- **Lucky (n):** for the owner of a creature with the Lucky feat and a point left. It adds a second d20 and keeps the higher, once per roll.
- **Saves linked to a card:** a save rolled from a card's row, or an on-hit save, updates that card when it changes, including its ✓/✗, its Apply sizes, and the on-hit save's halving. Reroll before applying: damage already applied isn't taken back.
- **Initiative:** a rerolled initiative moves the combatant in the tracker too.

**Clear Instant Templates** (GM setting, on by default): at the end of a creature's turn in combat, the areas its instantaneous spells and features placed (Fireball, Burning Hands) are removed. Areas that last (a duration, or Concentration) stay.

**No template question:** when a use's only question would be "place the template?" (no spell slot level or scaling to choose, like a monster's innate Fireball), dnd5e's dialog is skipped and the template is placed straight away.

**Collapse Card Descriptions** (GM setting, on by default): every chat card, dnd5e's and Roll Item's (attack cards included, which now carry the item's description), shows its description folded for everyone, the way dnd5e's own *Collapse Item Cards in Chat* does for one player. Click the card's title to open it.

**DM Screen** (GM setting, off by default):
- **NPC cards:** players see the cards but no numbers (no d20, totals or damage), only whether it hit or saved.
- **NPC saves** rolled from a card are private GM rolls.
- **Hidden targets:** GM-hidden or Invisible targets show as *Unknown*.

**Template Targeting** (GM setting, on by default): a template with a range (Fireball, 150 ft) can only be placed with its centre within that range of the caster, along a clear path: it stops at the first wall that blocks movement (a window stops it, an open door doesn't). Somewhere the caster can't see is fine. When a use places a template (Burning Hands, Fireball, Sleep), everyone inside it becomes the targets, the caster too if they're in it. The exception is the caster's own cone or line, since its point isn't part of its area. A "Range: Self" cone or line (Burning Hands, Lightning Bolt) stays pinned to the caster's token while you place it, and the mouse only aims it. The card, its save buttons and its trays are then for exactly them.

**Pick Targets** also covers damage-only activities (Magic Missile: one pick per dart once the cast level is known; the same target can be picked again), and heal, save and effect activities aimed at creatures (Healing Hands, Grapple, Shove, Mage Armor, Cure Wounds). The pick happens *before* dnd5e uses them, so closing it spends nothing. The count, range and who can be picked come from the activity:
- *willing* or *ally* targets: your allies and yourself, so Mage Armor can't land on an enemy
- saves and *enemy* targets: enemies
- anything else (a heal): anyone, yourself included

Areas (their template does it), self-only activities and activities without a range aren't picked for.

**Grapple & Shove** (GM setting, on by default): for Unarmed Strike's Grapple and Shove saves.
- **Grapple:** a failed save applies Grappled straight away.
- **Shove:** a failed save gives the shover **Prone** and **Push 5 ft** buttons for that target, on Roll Item's save card (Roll Item's **Saves** setting). Homebrew Push Into Obstacles applies to the push.
- **Size limit:** both only work on creatures up to one size larger.

Unarmed Strike keeps dnd5e's Attack / Grapple / Shove choice, made before rolling: in 2024 rules Grapple and Shove have no attack roll, the target only saves. Grapple and Shove are never on-hit riders on the attack's card. An Unarmed Strike with one "Grapple/Shove" activity asks *Grapple or Shove?* when used, and its card is that one: a failed save Grapples, or offers Shove's Prone / Push buttons.

### Stage hooks: how feats plug in

Roll Item does four things: **Target**, **Attack**, **Save** and **Damage**, all on one card. It knows nothing about anyone's feats. A feat that changes a roll is an item macro on the feat, set to **Run on Hooks** (see Item Macro), using these hooks:

| Hook | Arguments | Use it to |
|---|---|---|
| `macro-helper.targets` | `activity, tokens` | The targets picked or found in an area. Remove some from `tokens` (splice it) to drop them, e.g. Humanoids only. What's left becomes the targets. |
| `macro-helper.preAttack` | `activity, rollConfig` | Change an attack before it's rolled (`rollConfig.advantage` / `.disadvantage`). Return `false` to stop it. `rollConfig["macro-helper"].target` is the target's token uuid. |
| `macro-helper.attack` | `activity, roll` | React to an attack roll. |
| `macro-helper.preDamage` | `activity, config, attack` | Change damage before it's rolled. Return `false` to skip it. |
| `macro-helper.damage` | `activity, rolls, attack` | React to a damage roll. |
| `macro-helper.cardButtons` | `message, buttons, { ray }` | Add a button to an attack on the card: push `{ id, label, icon }`. Runs every time the card is drawn. |
| `macro-helper.cardButton` | `message, id, { ray, event }` | Your button was clicked. |

The card's `message.system` gives a macro what it needs:
- `isHitOn(ray)`: did that attack hit?
- `rollDamage(ray)`: roll its damage again, the way the card did, crits included.
- `addDamage(rolls, { key, label, ray, alternative })`: add damage in its own labelled box with its own APPLY. With `alternative`, it replaces the attack's damage rather than adding to it, and applying one hides the other.
- `extraRolls(ray, key)`: damage a macro already added.

`ray` is the attack's number on a card with several attacks, or `null` for a single attack.

The hooks only run until the macro's first `await`, so change rolls before awaiting anything. The built-in Savage Attacker in [scripts/rules/feats.js](scripts/rules/feats.js) is the model: it uses the same two card-button hooks a macro would.

Choose which activity types use Roll Item cards in the **Roll Item** settings. Any item can also be rolled from a macro:

```js
MacroHelper.rollItem(item);                 // first attack, save, damage, heal or utility activity
MacroHelper.rollItem(item, { count : 3 });  // force the number of attack rolls
```

## Examples

Ready-made macros are in the [examples](examples) folder: Split, Pseudopod, Greataxe cleave, 0 HP handling and a turn announcer. Each file says how to set it up.

## License

MIT, see [LICENSE](LICENSE).
