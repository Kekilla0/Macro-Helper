/**
 * Brass Dragon Wyrmling : Sleep Breath
 *   "Constitution Saving Throw: DC 11, each creature in a 15-foot Cone. Failure: The target has the Incapacitated
 *    condition until the end of its next turn, at which point it repeats the save. Second Failure: The target has
 *    the Unconscious condition for 1 minute. This effect ends for the target if it takes damage or a creature within
 *    5 feet of it takes an action to wake it."
 *
 * Setup : Item Macro on Sleep Breath, mode "Macro only".
 * Uses  : item.roll({ uses }) (it shares Fire Breath's Recharge 5–6), applyCondition (when "fail", save.repeat, save.fail : the second failure)
 */

const card = await item.roll({ uses : "Fire Breath" });    // the shared Recharge 5–6
if(!card) return;

card.remove("Sleep Breath");                               // Plutonium's : Incapacitated and Unconscious at once
card.append(applyCondition({ when : "fail", type : "incapacitated",
  save : { ability : "con", dc : 11, repeat : "end",
           fail : { type : "unconscious", duration : { seconds : 60 }, endsOn : ["damage", "wake"] } } }));
