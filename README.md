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

**Configure Settings → Macro Helper** has one sub-menu per feature: **Helpers**, **Item Macro**, **Hook Macros** and **Roll Item**. Each one can be turned off on its own.

## Helpers

Small functions for macros, available as `MacroHelper.x(...)` or `game.modules.get("macro-helper").api.x(...)`.

| Helper | What it does |
|---|---|
| `tokenOf(thing)` | The canvas token for a token, token document, actor or item. Falls back to your selected token. |
| `actorOf(thing)` | The actor for a token, token document, actor or item. |
| `distanceBetween(a, b)` | Feet between two tokens, edge to edge on the grid. Adjacent squares, diagonals included, are 5 ft. |
| `getRange(item, { long, thrown })` | How far an item reaches: a melee weapon's reach, a ranged weapon's range, or a spell's range. |
| `getTokensWithin(origin, feet, { disposition, includeDead, includeHidden, filter })` | Tokens within a distance, nearest first. `disposition` is `"any"`, `"enemy"` or `"ally"`. |
| `highlightRange(origin, feet, { tokens, selected })` | Shows a range, candidate tokens and selected tokens on the map, on your screen only. Returns `{ select, clear }`. |
| `isEnemy(a, b)`, `isAlly(a, b)` | Compares the two tokens' dispositions. |
| `getEnemiesWithinRange(item, { numberOfEnemies, range, long, thrown })` | Your targets in range first, then every other enemy in range, nearest first. |
| `selectTargets(tokens, { numberAllowed, within, setTargets, prompt, origin })` | Picks a group of targets standing within `within` ft of each other. `numberAllowed` is a number or `group => number`. With `prompt`, and no targets of your own, you choose the targets in a dialog, with the range and your picks shown on the map. **Async**, so use `await`. |
| `isValidGroup(tokens, { numberAllowed, within })` | Checks a group against those rules. Returns `{ valid, reason }`. |
| `setTargets(tokens)` | Replaces your targets. |
| `getSize(thing)` | dnd5e size, e.g. `{ key: "lg", value: 3, label: "Large" }`. |
| `stepSize(key, steps)` | Another size category, e.g. `stepSize("lg", -1)` → `"med"`. |
| `setStatus(thing, status, active, { overlay })` | Turns a condition on or off. It never flips a status that's already in that state. |
| `setDefeated(thing, defeated)` | Marks the creature defeated, or not, in the current combat. |
| `splitToken(thing, { copies, hp, scale, stepSize, chat })` | Replaces a token with smaller copies that share its HP (Ochre Jelly's Split). GM only. |
| `updateItem(item, changes)` | Updates an item and returns the fresh copy. Items on unlinked tokens are rebuilt when updated. |
| `setBaseDamage(item, { number, denomination, types, bonus })` | Sets a weapon's base damage, only if it's different. |
| `wait(ms)`, `waitFor(condition, { interval, timeout })` | Small async helpers. |
| `rollItem(item, { activity, count, event })` | Rolls an item as a Roll Item card (see below). |

### Methods on tokens, actors and items

The helpers are also added as methods on the things they act on. Turn this off in the **Helpers** settings.

| On | Methods |
|---|---|
| Token | `getCreatureSize()`, `distanceTo(other)`, `getTokensWithin(feet, opts)`, `isEnemy(other)`, `isAlly(other)`, `setStatus(...)`, `setDefeated(...)`, `split(opts)`, `highlightRange(feet, opts)` |
| TokenDocument | The same as Token, without `highlightRange`. |
| Actor | `getCreatureSize()`, `getTokensWithin(...)`, `isEnemy(...)`, `isAlly(...)`, `setStatus(...)`, `setDefeated(...)` |
| Item | `getRange(opts)`, `getEnemiesWithinRange(opts)`, `setBaseDamage(damage)`, `updateFresh(changes)`, `rollItem(opts)` |

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
- **The editor** is Foundry's own macro editor.
- **When it runs:** choose **Default only**, **Macro only**, or **Macro, then Default**. In the last mode, the macro can return `false` to skip the default.
- **Variables:** macros get `item`, `activity`, `actor`, `token`, `speaker`, `event`, `usage`, `dialog`, `message` and `scope`.

## Hook Macros

Run a world macro when something happens in the game, without installing a module for it.

1. Open a world macro (GM only).
2. Expand **Run on Hooks** under the Type line.
3. Pick hooks from the list, or type any hook name under **Custom Hooks**.
4. Choose **Run For**:
   - **Active GM (once):** the default, and right for most things.
   - **Every client:** runs wherever the hook fires. dnd5e roll hooks need this, because they only fire on the roller's client.

The macro gets `hook` (the hook's name) and `args` (its arguments). Only macros written by a GM run from hooks.

```js
// Run on "Turn changed" (combatTurnChange)
const [combat] = args;
ChatMessage.create({ content : `It's ${combat.combatant?.name}'s turn.` });
```

## Roll Item (dnd5e)

One card per use, built on dnd5e's own chat cards. Rerolls wait for Dice So Nice to finish.

| Activity | Card |
|---|---|
| Attack | Attack and damage rolled together. The crit range follows dnd5e and feats. Advantage and disadvantage use dnd5e's keys. |
| Multiple attack rolls | Scorching Ray, Eldritch Blast and Magic Missile count their rolls from the cast level. Each one gets its own target, damage and APPLY tray. |
| Attack + on-hit save | Giant Spider, Ghoul and similar. Separate base and save damage, a save button, and a tray that halves damage for targets that saved. |
| Save | Damage is rolled up front. Targets roll their own saves. Half damage on a save is applied automatically. |
| Heal | Healing or temporary HP, rolled with its apply tray. |
| Damage only | Damage is rolled up front, with its apply tray. |
| Utility | The activity's roll formula is rolled onto the card. |

Damage shows one box per damage type. The APPLY trays use dnd5e's own resistance, immunity and vulnerability handling.

Choose which activity types use Roll Item cards in the **Roll Item** settings. Any item can also be rolled from a macro:

```js
MacroHelper.rollItem(item);                 // first attack, save, damage, heal or utility activity
MacroHelper.rollItem(item, { count : 3 });  // force the number of attack rolls
```

## License

MIT, see [LICENSE](LICENSE).
