/**
 * Brown Bear : Claw
 *   "Melee Attack Roll: +5, reach 5 ft. Hit: 5 (1d4 + 3) Slashing damage. If the target is a Large or smaller
 *    creature, it has the Prone condition."
 *
 * Setup : Item Macro on Claw, mode "Macro only".
 * Uses  : item.roll(), target.isSmaller, applyCondition
 */

const card = await item.roll();
if(!card) return;

card.remove("prone");                                      // the item's own Prone would land on any size
card.append(applyCondition({ when : ["hit", target => target.isSmaller("large")], type : "prone" }));
