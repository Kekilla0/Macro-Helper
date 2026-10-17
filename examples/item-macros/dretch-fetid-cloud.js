/**
 * Dretch : Fetid Cloud  (1/Day)
 *   "Constitution Saving Throw: DC 11, each creature in a 10-foot Emanation originating from the dretch. Failure: The
 *    target has the Poisoned condition until the end of its next turn. While Poisoned, the creature can take either an
 *    action or a Bonus Action on its turn, not both, and it can't take Reactions."
 *
 * Setup : Item Macro on Fetid Cloud, mode "Macro only".
 * Uses  : item.roll(), applyCondition (noReactions, oneAction, duration "endOfNextTurn")
 */

const card = await item.roll();
if(!card) return;

card.remove("poisoned");
card.append(applyCondition({ when : "fail", type : "poisoned", duration : "endOfNextTurn", noReactions : true, oneAction : true }));
