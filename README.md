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
| `token.endCondition("poisoned", { from })` | A condition taken off a creature (Lay on Hands' Remove Poison). Any creature that isn't your own (your character and its summons; the GM's: no player owns it): the GM's button. |
| `MacroHelper.onFailedTest({ id, source, formula })` | A die a creature adds to its missed attack or failed save or check (Bardic Inspiration). |
| `MacroHelper.markSpell({ id, spell, free, hours, damage })` | A spell that marks one creature and hurts it more on every attack, ending with Concentration (Hunter's Mark, Hex). |
| `MacroHelper.weaponUses(id, { applies, abilities, die })` | The abilities and damage die a weapon attacks with while a rule applies (Martial Arts, Pact of the Blade). |
| `MacroHelper.endsWhen(match, { incapacitated, damaged, heavyArmor, combatEnd, attacks, casts, sourceZeroHP, apart, recast })` | What a rule's effects end on (Rage, Turned, Invisibility, Warding Bond). |
| `MacroHelper.sharesDamage(match, { fraction, keep })` | While a creature has the effect, the creature it came from takes part of its damage too (Warding Bond: all of it). |
| `MacroHelper.giveEffect(target, data, { save, dc, from, until })` | An effect on a creature, after its save; the GM's button when it isn't yours (Goaded, Seared). |
| `MacroHelper.onMiss({ formula })`, `MacroHelper.addRow({ run, withDamage })` | Damage on a miss (Graze), and a GM button on a hit creature's card row (Topple, Sap). |
| `MacroHelper.onAttacked({ when, within, run })`, `MacroHelper.onTurnStart({ run })` | A creature's Reaction button when one near it is attacked or hit (Interception, Protection), and something at the start of its turns. |
| `MacroHelper.bonusOnlyWhen(match, key, test)` | An effect's bonus only where a check holds (Rage's Strength attacks, Dueling, Defense in armor). |
| `MacroHelper.cantUseWhile(id, rule)`, `MacroHelper.freeUseWhile(id, rule)` | What can't be used, or is free, while something holds (no spells while raging; Rage extended). |
| `MacroHelper.itemEffectOn(item)`, `MacroHelper.itemEffectOff(actor, match)` | An item's own effect turned on and off for its creature (Rage, Innate Sorcery). |
| `MacroHelper.payCasting(actor, spell, { free })`, `MacroHelper.cardSave(card, spell)` | A spell cast outside its use, paid with a free casting or a slot, and its save put on an attack card (smites, marks). |
| `MacroHelper.countedUses(id, { max })`, `MacroHelper.damageTypeChoice(id, rule)`, `MacroHelper.excludeTargets(id, rule)` | Uses counted on the creature, a choice of damage types on the card, creatures an item can't target. |
| `MacroHelper.conjureItem(actor, source)`, `MacroHelper.linkItems(parent, items)`, `MacroHelper.pickFromCompendium(filter)`, `MacroHelper.summon(activity, creature)` | An item conjured into the hands, items that go with another, a compendium pick, a summoned creature. |
| `MacroHelper.sustain(id, { use, scaled })`, `MacroHelper.saveModeAgainst(match, conditions)`, `MacroHelper.spendHitDice(actor, { max })` | A spell used again while its Concentration lasts does its later part, no slot (Witch Bolt, Heat Metal, Flame Blade); advantage on saves to avoid or end conditions (Dwarven Resilience, Protection from Poison); Hit Point Dice rolled and expended (Arcane Vigor). |
| `MacroHelper.rollModeFrom(match, { by, against })`, `MacroHelper.actionTracker.modify(actor, kind, n)` | Advantage or disadvantage from an effect on attacks by or against its creature (Reckless Attack); more or fewer Actions, Bonus Actions, Reactions or attacks this turn (Action Surge). |
| `MacroHelper.useDefaultAction(actor, id)`, `MacroHelper.askToUse(activity, ctx, { text })` | A Default Action used as part of something else (Cunning Action's Hide), and a use that waits for the GM's Allow / Decline (Hide). |
| `MacroHelper.emanation(id, rule)`, `MacroHelper.transform(actor, form)`, `MacroHelper.revert(form)` | Every matching creature round the user targeted with no pick (Turn Undead); another creature's form taken and left (Wild Shape). |
| `MacroHelper.castOnHit(rule)`, `MacroHelper.onInitiative(rule)`, `MacroHelper.addSense(id, rule)` | Spells cast onto a weapon hit's card (the smites), a button on the initiative roll (Uncanny Metabolism), a sense on a creature's tokens (Devil's Sight). |
| `MacroHelper.pickOwned(actor, filter)`, `MacroHelper.enchant(source, target)` | One of the creature's own items chosen, and an item's enchantment put on it (Agonizing Blast on a cantrip). |
| `MacroHelper.isMetal(item)`, `MacroHelper.heldItems(actor)`, `MacroHelper.dropHeld(actor, item)` | Whether an item is metal (Heat Metal's object; a flag overrides), what a creature holds, and it letting go of one (Heat Metal's failed save, Disarming Attack). |
| `MacroHelper.castingChoice(rule)`, `MacroHelper.extendDurations(actor, item)` | A choice made as a spell is cast, paid from a pool once it's cast (Metamagic); an item's Concentration and effects made to last longer (Extended Spell). |
| `MacroHelper.saveRowToggle(rule)`, `MacroHelper.rerollButton(rule)` | Toggles on a save card's rows: the chosen succeed without rolling, or roll at advantage or disadvantage (Careful, Heightened Spell); a paid button that rolls a card's lowest damage dice or a missed attack again (Empowered, Seeking Spell). |
| `MacroHelper.willingSave(rule)`, `MacroHelper.changeSize(thing, steps, data)` | A save only an unwilling target makes: the GM says who's willing, and willing ones get the effect with no save (Enlarge/Reduce); a size larger or smaller, the creature's tokens moved to where they fit and back afterwards (Enlarge/Reduce, any effect that changes size). |
| `MacroHelper.actFrom(activity, token)`, `MacroHelper.actFromPlace(id, fn)` | A use measured from another token's space, its range and picks counted from there (Invoke Duplicity: spells cast from the illusion's space); a place a use can be made from, offered as it's used. |
| `MacroHelper.summon(activity, uuid, { controlled })`, `MacroHelper.controllerOf(actor)`, `MacroHelper.moveFirst(match, { feet, stopAt })` | A summoned creature that acts with its summoner's actions and has no turn of its own (Spiritual Weapon's force, Flaming Sphere); a use whose creature moves up to N ft first, stopping at the first creature in its way when asked (the force's Move and Attack, the Sphere's ram). Summons from a Concentration spell go when it ends. |
| `token.push(target, 10)`, `token.pull(target, 10)`, `token.teleport(30, { item })`, `token.leap(30, { item })`, `token.moveUpTo(20, { stopAt })`, `token.trample(feet)` | Movement. |
| `token.damage(value, type)`, `token.heal(value)`, `item.useAndApply()` | Hit points, through dnd5e's damage rules. |
| `item.spendUses(n)`, `token.useReaction(name)`, `actor.usedThisTurn(key)`, `actor.slotsLeft(level)`, `actor.addSpellSlot(level, n)` | Resources and the action economy (a slot made past the maximum: Font of Magic). |
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
