/**
 * Dust Mephit : Blinding Breath  (Recharge 6)
 *   "Dexterity Saving Throw: DC 10, each creature in a 15-foot Cone. Failure: The target has the Blinded condition
 *    until the end of the mephit's next turn."
 *
 * Setup : Item Macro on Blinding Breath, mode "Macro only".
 * Uses  : item.roll(), applyCondition (duration "endOfMyNextTurn" : the mephit's next turn)
 */

const card = await item.roll();
if(!card) return;

card.remove("blinded");
card.append(applyCondition({ when : "fail", type : "blinded", duration : "endOfMyNextTurn" }));
