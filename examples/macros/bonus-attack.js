/**
 * Follow-up Strike (a homebrew feature) : as a Bonus Action, attack once with the weapon you're holding.
 * The attack is part of the feature, so the feature's use is spent, not the weapon's.
 *
 * Setup : Item Macro on the feature, mode "Macro only". Its activity is a Utility with the Bonus Action (and any
 *         uses or recharge) : the macro uses it first.
 * Uses  : item.useActivity() (the feature's own dnd5e use), item.roll({ use : false }) (an attack that's part of
 *         something else : picked like any attack, nothing of the weapon's spent, not counted as an Attack action)
 */

const weapon = actor.items.find(i => (i.type === "weapon") && i.system.equipped && (i.system.identifier !== "unarmed-strike"));
if(!weapon) return ui.notifications.warn(`${actor.name} isn't holding a weapon.`);

if(!await item.useActivity()) return;    // no use left, or closed : no attack
return weapon.roll({ use : false });
