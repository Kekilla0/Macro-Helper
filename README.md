# Macro Helper

The 2024 D&D rules automated for dnd5e, one-click roll cards, and small reusable pieces ("legos") for writing your own item macros and hook macros in Foundry VTT.

- **Foundry:** v14 (verified 14.368)
- **System:** dnd5e 6.x for Roll Item, System Automation and most helpers. Item Macro, Hook Macros and the basic helpers work in any system.
- **Recommended:** [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper)

## Install

In Foundry's **Add-on Modules** tab, click **Install Module** and paste this manifest URL:

```
https://github.com/Kekilla0/Macro-Helper/releases/latest/download/module.json
```

## What it does

**Configure Settings → Macro Helper** has one page per feature. Every page and option is described in [docs/settings.md](docs/settings.md).

- **Roll Item:** one card per use, built on dnd5e's own. You pick targets on the map, the attack and damage roll together, and each target gets a row with its save, cover and **Apply**. A miss hides its damage until it becomes a hit. Saves, heals, multiple rays and on-hit saves get the same cards. **DM Screen** hides NPC numbers from players.
- **System Automation:** the rules dnd5e leaves to the table. That covers conditions, vision and cover, weapon handling (Heavy, Versatile, two hands), masteries, Grapple and Shove, Dash, Dodge and Help, Opportunity Attacks, the **Action Tracker**, **Hands** (what each creature holds), class features at levels 1–3, the 2024 subclasses' level 3 features, species traits and feats. **Rule Limits** (*Off*, *Warn*, *Block*) decides what happens when something breaks the rules, and **Rule Fixes** offers to put it right.
- **Roll Requests:** the GM asks for checks, saves and Skill Challenges with the DC set before anyone rolls.
- **Item Macro:** a macro on any item or activity, run when it's used or when a hook fires.
- **Hook Macros:** a world macro run when something happens in the game.
- **Homebrew:** table rules that aren't in the books, such as Flanking, Initiative Each Round and Push Into Obstacles. All off by default.

## Writing macros

**Item Macros** go on an item from the **</>** button in its sheet's title bar. Choose when it runs: **Default only**, **Macro only**, or **Macro, then Default**. The macro gets `item`, `activity`, `actor`, `token`, `scope` and `usage`. A GM can also set it to **Run on Hooks**, for a passive feature. It then gets `hook` and `args` too, and only listens while the creature is on the scene.

**Hook Macros** are world macros. Open **Run on Hooks** under the macro's Type line, pick a hook, and choose **Run For** (*Active GM (once)* for most). The macro gets `hook` and `args`.

**Card macros** keep the item's normal use and only add what's different:

```js
const card = await item.roll();                       // targets, attack, damage, its card
if(!card) return;
card.append(applyCondition({ type : "prone", when : "hit" }));
card.append(push(10, { when : "hit" }));
```

### The legos

The main pieces, as methods on tokens, actors and items. Most also exist as `MacroHelper` functions that take the token or item first. The full list, with every option, is in [docs/api.md](docs/api.md).

| Piece | What it does |
|---|---|
| `item.roll({ targets, use, advantage, ... })` | The item's normal use and its card. Returns the card. `use: false` makes an attack that's part of something else, so nothing of the item's is spent. |
| `item.target()` | Who the item is for, picked the way a use picks: self, an area, an attack, a heal or a save. Nothing is rolled. |
| `item.pickTargets({ count, within, numberAllowed })`, `token.getTokensWithin(feet)` | Pick creatures on the map, or find them near a token. |
| `card.append(part)`, `card.remove("prone")` | Add a part to a card, or take one of the item's own effects off. |
| `applyCondition`, `applyEffect`, `push`, `extraDamage`, `followUp` | Card parts. Each is shown on a target's row, `when` its result calls for it (`"hit"`, `"fail"`, or a check per target). |
| `MacroHelper.onHit({ feature, when, formula, once, cost })` | A button after a qualifying hit that adds damage in its own box (Divine Fury, Hand of Harm, a Battle Master maneuver). |
| `card.system.addHealing(activity, tokens)` | A second activity's healing on a save card, under the saves, with its own row and Apply (Land's Aid). |
| `MacroHelper.cutDamage(card, token, { amount, label })` | A card's damage to one creature made lower when applied (Interception, Deflect Attacks, Protective Field). |
| `token.actor.save("con", 13, { from : item })` | The save lego: one save, rolled the way every rule rolls it. |
| `token.applyCondition("prone", { save, dc, duration, repeat })`, `token.grapple(target)` | A condition, or a grapple, straight on a creature with no card. |
| `token.endCondition("poisoned", { from })` | A condition taken off a creature (Lay on Hands' Remove Poison). Someone else's creature: the GM's button. |
| `MacroHelper.onFailedTest({ id, source, formula })` | A die a creature adds to its missed attack or failed save or check (Bardic Inspiration). |
| `MacroHelper.markSpell({ id, spell, free, hours, damage })` | A spell that marks one creature and hurts it more on every attack, ending with Concentration (Hunter's Mark, Hex). |
| `MacroHelper.weaponUses(id, { applies, abilities, die })` | The abilities and damage die a weapon attacks with while a rule applies (Martial Arts, Pact of the Blade). |
| `MacroHelper.endsWhen(match, { incapacitated, damaged, heavyArmor, combatEnd })` | What a rule's effects end on (Rage, Turned). |
| `token.push(target, 10)`, `token.pull(target, 10)`, `token.teleport(30, { item })`, `token.leap(30, { item })`, `token.trample(feet)` | Movement. |
| `token.damage(value, type)`, `token.heal(value)`, `item.useAndApply()` | Hit points, through dnd5e's damage rules. |
| `item.spendUses(n)`, `token.useReaction(name)`, `actor.usedThisTurn(key)`, `actor.slotsLeft(level)` | Resources and the action economy. |
| `token.poolBar("grit", { item, flag, color })` | A pool of points (an item's uses, or a flag) as a coloured bar on the token, hidden when empty (Arcane Ward). |
| `token.reactionMove({ feet, noOA })`, `token.reactionAttack({ extraDamage })` | A creature's Reaction spent moving (without Opportunity Attacks) or on one weapon attack, on anyone's turn (Mantle of Inspiration, Commander's Strike, Riposte). |
| `target.isType("undead")`, `target.isSmaller("large")`, `token.canSee(other)`, `token.distanceTo(other)`, `token.isEnemy(other)` | Facts about a creature, for `when` checks. |

The [examples](examples/README.md) show these working together: a weapon with a rider, a group attack, a bonus attack, a Multiattack, Frightful Presence, a grab, a trample, an aura and an "Undead only" filter.

## More

- [docs/settings.md](docs/settings.md): every setting and rule, page by page.
- [docs/api.md](docs/api.md): every helper, method, card part and hook.
- [docs/feature-steps.md](docs/feature-steps.md): each class feature's steps and the lego it's built on, and the parts that aren't legos yet.
- [examples](examples/README.md): example macros, GM tools and importable items.

## License

MIT, see [LICENSE](LICENSE).
