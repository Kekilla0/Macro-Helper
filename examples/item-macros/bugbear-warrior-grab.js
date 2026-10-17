/**
 * Bugbear Warrior : Grab
 *   "Melee Attack Roll: +4, reach 10 ft. Hit: 9 (2d6 + 2) Bludgeoning damage. If the target is a Medium or smaller
 *    creature, it has the Grappled condition (escape DC 12)."
 *
 * Setup : Item Macro on Grab, mode "Macro only".
 * Uses  : item.roll(), target.isSmaller, applyCondition (escape)
 */

const card = await item.roll();
if(!card) return;

card.remove("grappled");                                   // the item's own Grappled would land on any size
card.append(applyCondition({ when : ["hit", target => target.isSmaller("medium")], type : "grappled", escape : 12 }));
