/**
 * Ghast : Claw
 *   "Melee Attack Roll: +5, reach 5 ft. Hit: 10 (2d6 + 3) Slashing damage. If the target is a non-Undead creature, it
 *    is subjected to the following effect. Constitution Saving Throw: DC 10. Failure: The target has the Paralyzed
 *    condition until the end of its next turn."
 *
 * Setup : Item Macro on Claw, mode "Macro only".
 * Uses  : item.roll(), target.isType, applyCondition (duration "endOfNextTurn")
 */

const card = await item.roll();
if(!card) return;

card.remove("paralyzed");
card.append(applyCondition({ when : ["fail", target => !target.isType("undead")], type : "paralyzed", duration : "endOfNextTurn" }));
