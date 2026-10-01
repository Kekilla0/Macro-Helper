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

**Advantage on Saves Against Conditions** (in **Helpers**, on by default): features like Brave (Frightened), Fey Ancestry (Charmed) and Dwarven Resilience (Poisoned) give advantage on saves rolled from a card whose activity applies that condition. The condition is read from the feature's text. A save rolled straight from the sheet can't be told apart, so it stays normal.

**Conditions on Attack Rolls** (in **Helpers**, dnd5e, on by default): Poisoned gives disadvantage on attack rolls, as does Exhaustion 3 with 2014 rules and Heavily Encumbered on Strength and Dexterity attacks. dnd5e 6 lists these but only applies them to ability checks. This covers every dnd5e attack, and it works the same whether the creature has the Poisoned condition or an effect whose Statuses include Poisoned.

## Helpers

Small functions for macros, available as `MacroHelper.x(...)` or `game.modules.get("macro-helper").api.x(...)`.

| Helper | What it does |
|---|---|
| `tokenOf(thing)` | The canvas token for a token, token document, actor or item. Falls back to your selected token. |
| `actorOf(thing)` | The actor for a token, token document, actor or item. |
| `distanceBetween(a, b)` | Feet between two tokens, edge to edge on the grid. Adjacent squares, diagonals included, are 5 ft. Further out it follows the **Range Shape** setting: *Circle* (true distance, the default) or *Square* (5e: every diagonal step is 5 ft). |
| `getRange(item, { long, thrown })` | How far an item reaches: a melee weapon's reach, a ranged weapon's range, or a spell's range. |
| `pushDestination(thing, from, feet)`, `pushAway(thing, from, feet)` | Push a token straight away from another, square by square, stopping at walls (Push mastery, Shove, Thunderwave). It's measured by the **Range Shape** setting. `pushAway` needs permission to move the token, and returns how many feet it moved (0 if blocked straight away). |
| `getTokensWithin(origin, feet, { disposition, includeDead, includeHidden, filter })` | Tokens within a distance, nearest first. `disposition` is `"any"`, `"enemy"` or `"ally"`. |
| `highlightRange(origin, feet, { normal, tokens, selected })` | Shows a range on the map, on your screen only: blue within `normal`, red from there out to `feet` (long range), orange candidates and green picks. Returns `{ select, clear }`. |
| `isEnemy(a, b)`, `isAlly(a, b)` | Compares the two tokens' dispositions. |
| `getFlanker(attacker, target)`, `isFlanking(attacker, target)` | The attacker's ally flanking the target with them (DMG rule: both next to it, on opposite sides or corners), or `null`. |
| `isThreatened(thing, { range, includeIncapacitated, includeHidden })` | Whether an enemy (opposite disposition) is within 5 ft, not counting incapacitated, dead or GM-hidden ones. In 5e, ranged attacks made while threatened have disadvantage. |
| `getThreats(thing, { range, includeIncapacitated, includeHidden })` | Those enemies, nearest first. |
| `getEnemiesWithinRange(item, { numberOfEnemies, range, long, thrown })` | Your targets in range first, then every other enemy in range, nearest first. |
| `selectTargets(tokens, { numberAllowed, within, setTargets, prompt, origin })` | Picks a group of targets standing within `within` ft of each other. `numberAllowed` is a number or `group => number`. With `prompt`, and no targets of your own, you choose the targets in a dialog, with the range and your picks shown on the map. **Async**, so use `await`. |
| `isValidGroup(tokens, { numberAllowed, within })` | Checks a group against those rules. Returns `{ valid, reason }`. |
| `setTargets(tokens)` | Replaces your targets. |
| `getSize(thing)` | dnd5e size, e.g. `{ key: "lg", value: 3, label: "Large" }`. |
| `stepSize(key, steps)` | Another size category, e.g. `stepSize("lg", -1)` → `"med"`. |
| `setStatus(thing, status, active, { overlay })` | Turns a condition on or off. It never flips a status that's already in that state. |
| `setDefeated(thing, defeated)` | Marks the creature defeated, or not, in the current combat. |
| `damage(thing, value, type, { properties, multiplier, ignore })` | Damages a creature through dnd5e, so resistances, immunities and temp HP apply. `value` can be a number, a formula (`"2d6 + 3"`), or parts `[{ value, type }]`. |
| `heal(thing, value)` | Heals a creature, up to its max HP. `value` can be a number or a formula. |
| `tempHP(thing, value, source)` | Gives temp HP. The higher of the current and new amount is kept (they don't stack). `source` is recorded in `flags["macro-helper"].tempHP` when applied. |
| `dropsToZero(thing, amount)` | Whether this much damage drops a creature that's still up to 0 HP (temp HP soak first). |
| `isKilledOutright(thing, amount)` | Whether it's massive damage: what's left after reaching 0 HP is at least the creature's HP max. |
| `preventDropToZero(thing, amount, updates, { hp, massiveDamage })` | For "reduced to 0 but not killed outright" features. Use it in a `dnd5e.preApplyDamage` Hook Macro, before any `await`: it changes dnd5e's pending update so the creature stays on `hp` (1). Massive damage still kills unless `massiveDamage: false`. Returns whether it kept them up. |
| `getSaveAdvantages(thing)` | The conditions a creature has advantage on saves against, read from its features ("...to avoid or end the Frightened condition"), e.g. `Set { "frightened" }`. |
| `rollSave(thing, ability, dc)` | Rolls a saving throw against a DC, with no dialog. Returns `{ success, total, roll }`. |
| `addTimedEffect(thing, effectData, { of, until })` | Adds an effect that lasts until the start (`"turnStart"`) or end (`"turnEnd"`) of someone's next turn in combat (`of`, default the creature itself). The active GM removes it then. Out of combat it stays until removed. |
| `findItem(thing, query, { type })` | One of the actor's items by name (any case), identifier, id or uuid. `query` can be several (`["Relentless Endurance", "Relentless"]`, first match wins) or a function. |
| `splitToken(thing, { copies, hp, scale, stepSize, chat })` | Replaces a token with smaller copies that share its HP (Ochre Jelly's Split). GM only. |
| `pickAndAttack(item, { count, repeat, disposition, within, long, confirm, clearTargets, strict, threatened, event })` | The whole attack in one call: clears your targets, you pick on the map, then one attack roll per pick. With `repeat`, a target can be picked more than once (Multiattack: both attacks at one foe). Fewer picks than `count` is fine: press Enter. Targets beyond reach get thrown at when the weapon can be thrown, targets at long range are attacked with disadvantage, and so are ranged or thrown attacks while the attacker is threatened (melee attacks aren't). Nobody attacks with what they don't have (quantity 0, not enough to throw or shoot) unless `strict: false`. Problems show as notifications. |
| `pickAttack(item, { count, repeat, activity, used, ... })` | The picking half of `pickAndAttack`: checks, the map pick, and the ammunition and throw checks. Returns `{ attack, targets, attackMode, disadvantage }` to pass to `rollItem`, or `null`. For when you want to pick now and roll your own way. |
| `attackModeFor(item, target, { long })` | For weapons that can be thrown: `"thrown"` beyond reach (within thrown range), otherwise the melee mode, e.g. `"oneHanded"`. `null` for weapons that can't be thrown. |
| `isLongRange(item, target)` | Whether a target is beyond the weapon's normal range but within its long range (ranged or thrown), where 5e attacks have disadvantage. |
| `isRangedItem(item)` | Whether the item is a ranged attack by nature: a ranged weapon or a ranged spell attack. A Dagger isn't. |
| `isRangedAttack(item, target)` | Whether attacking this target is a ranged attack: a ranged item, or a thrown weapon thrown at it. |
| `canThrow(item)` | Whether the weapon has the Thrown property. |
| `getAmmunition(item)` | The ammunition item dnd5e would use for the weapon's attack, or `null`. |
| `pickTargets(origin, { count, range, disposition, numberAllowed, within, confirm, useTargets, repeat, filter })` | Pick targets by clicking them on the map, with the range and candidates shown. Enter confirms, Esc cancels. With `repeat`, clicking a picked token picks it again and right click takes one away; the picks come back once per pick (`[A, A, B]`). Targets you already have in range are used as they are; `useTargets: false` clears them and always asks. **Async**. |
| `getMultiattack(item, { feature, fallback })` | How many attacks this item gets in its owner's Multiattack (see `getMultiattackPlan`): Hand Axe in "two attacks with its hand axes" gives 2. `fallback` (1) when the Multiattack doesn't include it. |
| `getMultiattackPlan(thing, { feature })` | A creature's Multiattack, read from the feature's text, as `[{ items, count, choice }]` in order. "one with its bite and two with its claws" gives Bite ×1, then Claw ×2. "two attacks, using Shortsword or Longbow" gives one entry of 2 with both items (`choice`). `thing` is the creature or the Multiattack feature. |
| `multiattack(thing, { repeat, event, attack })` | The whole Multiattack in one click: for each weapon in turn, pick on the map and attack (`pickAndAttack`, one card per weapon). A choice asks how to split the attacks first. `repeat` (default `true`) lets a target take more than one of a weapon's attacks, which is allowed but never required. Enter stops with fewer picks, Esc skips that weapon. `attack` passes more `pickAndAttack` options. |
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
| Token | `getCreatureSize()`, `distanceTo(other)`, `getTokensWithin(feet, opts)`, `isEnemy(other)`, `isAlly(other)`, `isThreatened()`, `getThreats()`, `setStatus(...)`, `setDefeated(...)`, `damage(value, type)`, `heal(value)`, `tempHP(value, source)`, `dropsToZero(amount)`, `isKilledOutright(amount)`, `preventDropToZero(amount, updates, opts)`, `findItem(query, opts)`, `split(opts)`, `highlightRange(feet, opts)`, `pickTargets(opts)` |
| TokenDocument | The same as Token, without `highlightRange`. |
| Actor | `getCreatureSize()`, `getTokensWithin(...)`, `isEnemy(...)`, `isAlly(...)`, `isThreatened()`, `getThreats()`, `setStatus(...)`, `setDefeated(...)`, `damage(...)`, `heal(...)`, `tempHP(...)`, `dropsToZero(...)`, `isKilledOutright(...)`, `preventDropToZero(...)`, `findItem(...)`, `getMultiattackPlan()`, `multiattack(opts)` |
| Item | `pickAndAttack(opts)`, `pickAttack(opts)`, `getRange(opts)`, `getEnemiesWithinRange(opts)`, `pickTargets(opts)`, `attackModeFor(target)`, `isLongRange(target)`, `isRangedItem()`, `isRangedAttack(target)`, `canThrow()`, `getAmmunition()`, `getMultiattack(opts)`, `getMultiattackPlan()`, `multiattack(opts)`, `getHealing(opts)`, `getUses()`, `hasUses(amount)`, `spendUses(amount)`, `useActivity(opts)`, `setBaseDamage(damage)`, `updateFresh(changes)`, `rollItem(opts)` |

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
| Heal | Healing or temporary HP, rolled with its apply tray. Healing that can only affect yourself (Second Wind) is applied straight away, with no tray. |
| Damage only | Damage is rolled up front, with its apply tray. |
| Utility | The activity's roll formula is rolled onto the card. |

Damage shows one box per damage type. The APPLY trays use dnd5e's own resistance, immunity and vulnerability handling.

**Advantage / Disadvantage** (GM setting) has three choices:
- *Hold dnd5e's keys while rolling* (default Alt / Ctrl).
- *Ask before rolling:* an Advantage / Normal / Disadvantage prompt after targets are picked, once per card and once per reroll.
- *Neither:* only what the rules give.

Either way the choice is combined with long range, being threatened, conditions and masteries, and advantage and disadvantage cancel out.

**Damage After the Attack** (world setting, on by default): attack and damage are both still rolled automatically, but the card shows the attack first. The damage dice roll once the attack dice have landed, so crit damage dice don't give away a natural 20 early. This mostly matters with Dice So Nice; without it the damage follows straight away.

**Pick Targets** (a setting for each player): attacks rolled by Roll Item let you click your targets on the map first. It works like `pickAndAttack`: the range is shown, targets beyond reach are thrown at, and long range or a ranged attack while threatened gives disadvantage. It also checks you have enough ammunition or weapons to throw. The pick happens after dnd5e's use, so Scorching Ray knows its ray count from the cast level, and rays or attacks can pick a target again. If you pick fewer targets than rays, the rays are spread over your picks. Esc after casting still spends the slot.
- *Off* uses your targets as they are.
- *When you have no targets in range* picks only then.
- *Always* clears your targets and picks every time.

It needs your token on the scene you're viewing; without one, the attack rolls against your targets as usual.

**Weapon Mastery** (world setting, on by default): attack cards use the 2024 weapon mastery dnd5e gives the attack. It only gives one when the actor has mastered that kind of weapon (Weapon Proficiencies → Mastery on the sheet). Each mastery button can be used once per attack. A player's buttons are carried out by the active GM's client, which checks the card first.

| Mastery | On the card |
|---|---|
| Graze | On a miss: damage equal to the attack's ability modifier, with the weapon's damage type and its own APPLY tray. Multiple-attack cards apply it to misses with the "apply hits" button. |
| Topple | On a hit: a button. The target makes a CON save (DC 8 + ability modifier + proficiency) and falls Prone on a failure. |
| Push | On a hit: a button that pushes the target 10 ft straight away, stopping at walls. It doesn't work on Huge or larger creatures. |
| Sap | On a hit: a button. The target has disadvantage on its next attack roll before the start of the attacker's next turn. |
| Slow | On a hit: a button. The target's speed drops 10 ft until the start of the attacker's next turn. It doesn't stack. |
| Vex | On a hit: a button. The attacker has advantage on their next attack roll against that target before the end of their next turn. |
| Cleave | On a hit: a button, once per turn. Pick a second creature within 5 ft of the first and in reach, and attack it. Its damage leaves out a positive ability modifier. |
| Nick | Nothing to roll. It only changes when the Light extra attack happens. |

Sap and Vex are used up by the next attack roll they affect, from any sheet or card.

**Homebrew** (GM sub-menu, everything off by default): table rules that aren't in the books.
- **Flanking:** *Off* (rules as written), *Advantage*, or *+2 to the attack roll*. It uses the DMG optional rule: a melee attack against a creature with one of the attacker's allies on its opposite side, both next to it. A line between the two must pass through opposite sides or corners of its space, and allies who are down or incapacitated don't count. It applies to every attack roll, not only Roll Item's.
- **Push Into Obstacles:** a Push cut short by a wall. If the target travels only part of the way (5 of 10 ft), it falls Prone. If it can't move at all, it falls Prone and takes 1d6 bludgeoning, rolled in chat and applied.

**Savage Attacker** (GM setting, on by default): each weapon attack that hits, made by someone with the feat, gets a **Savage Attacker** button that only they see, so they choose which attack to use it on. It rolls that attack's damage again, crits included, next to the first roll. Each roll has its own APPLY, and applying one removes the other. It works once per turn in combat; out of combat, there are no turns to count.

**Multiattack** (world setting): using a Multiattack feature makes all of its attacks (see `multiattack`), with a pick and a card per weapon, instead of dnd5e's card for the feature.

Choose which activity types use Roll Item cards in the **Roll Item** settings. Any item can also be rolled from a macro:

```js
MacroHelper.rollItem(item);                 // first attack, save, damage, heal or utility activity
MacroHelper.rollItem(item, { count : 3 });  // force the number of attack rolls
```

## Examples

Ready-made macros are in the [examples](examples) folder: Split, Pseudopod, Greataxe cleave, 0 HP handling and a turn announcer. Each file says how to set it up.

## License

MIT, see [LICENSE](LICENSE).
