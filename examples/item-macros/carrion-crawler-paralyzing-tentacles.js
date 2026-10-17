/**
 * Carrion Crawler : Paralyzing Tentacles
 *   "Constitution Saving Throw: DC 12, one creature the carrion crawler can see within 10 feet. Failure: The target
 *    has the Poisoned condition and repeats the save at the end of each of its turns, ending the effect on itself on
 *    a success. After 1 minute, it succeeds automatically. While Poisoned, the target has the Paralyzed condition."
 *
 * Setup : Item Macro on Paralyzing Tentacles, mode "Macro only".
 * Uses  : item.roll(), applyCondition (when "fail", with, duration, save.repeat)
 */

const card = await item.roll();
if(!card) return;

card.remove("poisoned");                                   // Plutonium's : Poisoned only, no Paralyzed, no save
card.append(applyCondition({ when : "fail", type : "poisoned", with : ["paralyzed"],
  duration : { seconds : 60 }, save : { ability : "con", dc : 12, repeat : "end" } }));
