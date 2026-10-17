/**
 * Bronze Dragon Wyrmling : Repulsion Breath
 *   "Strength Saving Throw: DC 12, each creature in a 30-foot Cone. Failure: The target is pushed up to 30 feet
 *    straight away from the dragon and has the Prone condition."
 *
 * Setup : Item Macro on Repulsion Breath, mode "Macro only".
 * Uses  : item.roll({ uses }) (it shares Lightning Breath's Recharge 5–6), push (when "fail"), applyCondition
 */

const card = await item.roll({ uses : "Lightning Breath" });    // the shared Recharge 5–6
if(!card) return;

card.remove("prone");                                      // the item's own Prone : added again below, after the push
card.append(push(30, { when : "fail" }));
card.append(applyCondition({ when : "fail", type : "prone" }));
