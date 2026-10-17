/**
 * Death Dog : Bite
 *   "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d4 + 2) Piercing damage. If the target is a creature, it is subjected
 *    to the following effect. Constitution Saving Throw: DC 12. First Failure: The target has the Poisoned condition.
 *    While Poisoned, the target's Hit Points maximum doesn't return to normal when finishing a Long Rest, and it
 *    repeats the save every 24 hours that elapse, ending the effect on itself on a success. Subsequent Failures: The
 *    Poisoned target's Hit Points maximum decreases by 5 (1d10)."
 *
 * Setup : Item Macro on Bite, mode "Macro only".
 * Uses  : item.roll(), applyDisease (stages : what each failure brings; past the last, the last again)
 */

const card = await item.roll();
if(!card) return;

card.remove("Bite");                                       // Plutonium's own effect
card.append(applyDisease({ when : "fail", name : "Death Dog Disease", ability : "con", dc : 12, every : "24h",
  stages : [{ type : "poisoned" }, { hpMax : "-1d10" }], removal : ["save", "magical"] }));
