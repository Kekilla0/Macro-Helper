/**
 * Copper Dragon Wyrmling : Slowing Breath  (shares Acid Breath's Recharge 5–6)
 *   "Constitution Saving Throw: DC 11, each creature in a 15-foot Cone. Failure: The target can't take Reactions; its
 *    Speed is halved; and it can take either an action or a Bonus Action on its turn, not both. This effect lasts
 *    until the end of its next turn."
 *
 * Setup : Item Macro on Slowing Breath, mode "Macro only".
 * Uses  : item.roll({ uses }), applyEffect (speed, noReactions, oneAction, duration "endOfNextTurn")
 */

const card = await item.roll({ uses : "Acid Breath" });    // the shared Recharge 5–6
if(!card) return;

card.append(applyEffect({ when : "fail", duration : "endOfNextTurn", speed : 0.5, noReactions : true, oneAction : true }));
