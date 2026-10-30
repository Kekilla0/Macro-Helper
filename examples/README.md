# Examples

Short macros that show how Macro Helper's pieces fit together. Copy a file's contents into a macro; the comment at its top says where it goes and how to set it up. Each one is written for a generic case, so change the numbers and names to fit your feature.

## Macros

| File | Kind | Shows |
|---|---|---|
| [card-macro.js](macros/card-macro.js) | Item Macro | A weapon with a rider: `item.roll()`, then `card.append()` / `card.remove()` with `applyCondition`, `push` and `extraDamage`, `when` checks per target, and `choice` (one part or the other). |
| [group-attack.js](macros/group-attack.js) | Item Macro | A group pick on the map (`item.pickTargets` with `within` and `numberAllowed`), then `item.roll({ targets })`: one attack each. |
| [bonus-attack.js](macros/bonus-attack.js) | Item Macro | A feature that makes an attack: `item.useActivity()` for the feature's own use, then `weapon.roll({ use: false })`. |
| [multiattack.js](macros/multiattack.js) | Item Macro | A Multiattack written out: `actor.multiattack([{ weapon, count }])`, weapon by weapon. |
| [frightful-presence.js](macros/frightful-presence.js) | Item Macro | Conditions straight on creatures, no card: `token.getTokensWithin()`, `target.giveCondition("frightened", { save, dc, duration, repeat })`. |
| [grab.js](macros/grab.js) | Item Macro | `token.pickTargets()`, the save lego `target.actor.save()`, then `token.grapple()` or `token.push()`. |
| [trample.js](macros/trample.js) | Item Macro | Movement: `token.trample()`, `token.useMovement()`, then `item.roll({ targets })`. |
| [aura.js](macros/aura.js) | Item Macro, on a hook | A passive feature on *Its turn ends*: `hook`, `token.getTokensWithin()`, `item.roll({ targets })`. |
| [targets-filter.js](macros/targets-filter.js) | Item Macro, on a hook | "Undead only": the *Targets picked* hook drops creatures before the card is made; `target.isType()`. |
| [turn-announce.js](macros/turn-announce.js) | Hook Macro | A world macro on *Turn changed*: `args`. |

**One-liners** (Item Macro, mode *Macro only*):

```js
return item.useAndApply();                                         // Second Wind : use it, the healing lands on you
return actor.recoverSpellSlots({ levels : 3, maxLevel : 5, item }); // Arcane Recovery : choose spent slots to recover
await token.teleport(40, { item });                                // Misty Step : pick a space you can see, then go
if(!await token.leap(30, { item })) return; await token.useMovement(-10);  // a Leap that costs 10 ft of movement
token.hasLight("light") ? await token.removeLight({ key : "light" })       // Light on something you carry
                        : await token.addLight({ bright : 20, dim : 40 }, { key : "light" });
```

Reacting to damage you just took (Stone's Endurance), on the feature's own use:

```js
const last = actor.getLastDamage();                // { amount, message, at }
if(!last) return;
if(await item.useAndApply({ max : last.amount }) !== null) await actor.clearLastDamage();
```

**Item Macros** go on an item: the **</>** button in its sheet's title bar, then the mode the file says. Inside you have `item`, `actor`, `token`, `scope`, the card parts (`applyCondition`, `push`, `extraDamage`...) and, on a hook, `hook` and `args`. **Hook Macros** are world macros with **Run on Hooks** opened under their Type line. See [the macro reference](../docs/api.md) for every method.

The examples use the methods on tokens, actors and items (`token.push()`). With those turned off in the **Helpers** settings, use the `MacroHelper` versions: `MacroHelper.pushAway(target, token, 10)`.

## GM tools

Script macros, run by the GM.

| File | What it does |
|---|---|
| [upgrade-items.js](tools/upgrade-items.js) | Puts the Macro Helper items (Dash, Dodge, Help, Unarmed Strike, Reckless Attack...) on the selected creatures *in place*: items they already have keep their spot on the sheet, only the activities and text change. Class features that ended up under "Other features" go back under their class. |
| [fix-summons.js](tools/fix-summons.js) | Fixes summoning spells imported without their creatures (Plutonium's Dancing Lights, Find Familiar, Light) from dnd5e's 2024 spells. Run once. |
| [zero-hp.js](tools/zero-hp.js) | A Hook Macro on *Actor changed*: at 0 HP, NPCs are Dead and defeated, PCs Unconscious and dying; healing clears it. |
| [reset-actor.js](tools/reset-actor.js) | For testing builds: the selected token's actor is remade blank (same name, image, folder, ownership), with a linked token on the same spot. |

## Items to import

Right-click an item in the Items sidebar, **Import Data**, and pick the file. Then run [upgrade-items.js](tools/upgrade-items.js) with the character selected, rather than dragging the item on: a dragged-in class feature lands under "Other features" instead of its class. Macro Helper's **Actions** compendium is filled from these too.

| File | What it is |
|---|---|
| [items/dash.json](items/dash.json) | **Dash**: extra movement equal to your Speed until the end of the turn. |
| [items/disengage.json](items/disengage.json) | **Disengage**: no Opportunity Attacks from your movement until the end of the turn. |
| [items/dodge.json](items/dodge.json) | **Dodge**: Dodging until the start of your next turn. |
| [items/help.json](items/help.json) | **Help**: Assist Attack, Assist Check, Stabilize. |
| [items/unarmed-strike.json](items/unarmed-strike.json) | dnd5e's 2024 **Unarmed Strike** with separate Damage, Grapple and Shove activities, so the choice comes before any roll. |
| [items/reckless-attack.json](items/reckless-attack.json) | Barbarian **Reckless Attack** with an activity (dnd5e's has none): using it makes you Reckless until the start of your next turn. |
