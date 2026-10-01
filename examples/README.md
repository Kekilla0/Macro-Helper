# Examples

Macros built with Macro Helper. To use one, copy the file's contents into a macro. The comment at the top of each file says where it goes and how to set it up.

| File | Kind | What it does |
|---|---|---|
| [split.js](split.js) | Item Macro | Ochre Jelly / Black Pudding **Split**: two copies with half the HP, a size smaller, same space and initiative. |
| [pseudopod.js](pseudopod.js) | Item Macro | Pseudopod damage follows the creature's size (2d8 / 1d8 / 1d4 acid), so it shrinks with each split. |
| [greataxe-cleave.js](greataxe-cleave.js) | Item Macro | Orc Soldier Greataxe: one attack roll each against up to 2 Medium or 3 Small targets within 5 ft of each other. Lets the player choose targets on the map. |
| [pick-and-attack.js](pick-and-attack.js) | Item Macro | Click your targets on the map (range shown), then one attack each. Targets beyond reach get a thrown attack when the weapon can be thrown. Checks there are enough to throw, or enough ammunition, before attacking. Settings for count, who can be picked, spacing, long range. Checks the item, attacker and range first. |
| [multiattack-hand-axe.js](multiattack-hand-axe.js) | Item Macro | Orc Warrior Hand Axe: as many attacks as its **Multiattack** gives it, and the same target can be picked twice (both axes at one foe, or one each). |
| [multiattack.js](multiattack.js) | Item Macro | **Multiattack** in one click, from its text: a pick on the map and a card per weapon ("one with its bite and two with its claws" gives Bite, then Claws). "Shortsword or Longbow" asks how to split the attacks. |
| [healing-rage.js](healing-rage.js) | Item Macro | Orc Warrior **Healing Rage**: dnd5e uses it (card, bonus action, daily use), then it heals the amount it reads from the item ("heal 11 hit points"). Nothing happens without a use left, or at full HP. |
| [arcane-recovery.js](arcane-recovery.js) | Item Macro | Wizard **Arcane Recovery**, and Druid **Natural Recovery** with one line changed. Choose spent spell slots up to half the class level, rounded up, none above 5th. Spends the feature's daily use. |
| [light.js](light.js) | Item Macro | **Light** on something you carry: your token sheds dnd5e's Light (20 / 40 ft, flickering). Cast it again to put it out and get the token's own light back. |
| [fix-summons.js](fix-summons.js) | Script macro (GM, once) | Fixes summoning spells imported without their creatures (Plutonium's Dancing Lights, Find Familiar, Light) by copying the summon profiles from dnd5e's 2024 spells. |
| [overdraw.js](overdraw.js) | Item Macro | Orc Archer **Overdraw**: an effect on the bow adding 1d4 to its next attack's damage, which removes itself after that damage roll. |
| [zero-hp.js](zero-hp.js) | Hook Macro | At 0 HP: NPCs are Dead and defeated, PCs are Unconscious and dying. Healing clears it. |
| [relentless-endurance.js](relentless-endurance.js) | Item Macro, on a hook | **Relentless Endurance**: damage that would drop the creature to 0 HP leaves it on 1 instead, once a day, unless it's killed outright (massive damage). It sits on the feature and runs on *Damage about to apply*, only while the creature is on the scene. |
| [turn-announce.js](turn-announce.js) | Hook Macro | Posts whose turn it is when the combat turn changes. |

**Item Macros** go on an item: use the **</>** button in its sheet's title bar, then choose the mode the file says. Inside the macro you have `item`, `actor`, `token` and `scope`. A GM can also set an item macro to **Run on Hooks** (in the editor), for passive features. It then gets `hook` and `args` too, and only runs while the creature is on the scene.

**Hook Macros** are world macros: open the macro, expand **Run on Hooks**, and pick the hook and **Run For** the file says. Inside the macro you have `hook` and `args`. Only macros written by a GM run from hooks. A Hook Macro runs inside the hook, so until its first `await` it can still change what the hook passed (how Relentless Endurance changes the damage about to be applied).

The examples use the helper methods, e.g. `token.split()` and `actor.setStatus()`. If those are turned off in the **Helpers** settings, use the `MacroHelper` versions instead: `MacroHelper.splitToken(token)`, `MacroHelper.setStatus(actor, ...)`.
