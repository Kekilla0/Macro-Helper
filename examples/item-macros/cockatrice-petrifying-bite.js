/**
 * Cockatrice : Petrifying Bite
 *   "Melee Attack Roll: +3, reach 5 ft. Hit: 3 (1d4 + 1) Piercing damage. If the target is a creature, it is subjected
 *    to the following effect. Constitution Saving Throw: DC 11. First Failure: The target has the Restrained condition.
 *    The target repeats the save at the end of its next turn if it is still Restrained, ending the effect on itself on
 *    a success. Second Failure: The target has the Petrified condition, instead of the Restrained condition, for 24 hours."
 *
 * Setup : Item Macro on Petrifying Bite, mode "Macro only".
 * Uses  : item.roll(), applyCondition (when "fail" on the bite's save, save.fail)
 */

const card = await item.roll();
if(!card) return;

card.remove("Petrifying Bite");                            // Plutonium's : Restrained and Petrified at once
card.append(applyCondition({ when : "fail", type : "restrained",
  save : { ability : "con", dc : 11, repeat : "end", fail : { type : "petrified", duration : { seconds : 86400 } } } }));
