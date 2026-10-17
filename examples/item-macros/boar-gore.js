/**
 * Boar : Gore
 *   "Melee Attack Roll: +3, reach 5 ft. Hit: 4 (1d6 + 1) Piercing damage. If the target is a Medium or smaller
 *    creature and the boar moved 20+ feet straight toward it immediately before the hit, the target takes an extra
 *    3 (1d6) Piercing damage and has the Prone condition."
 *
 * Setup : Item Macro on Gore, mode "Macro only".
 * Uses  : item.roll({ activity }), token.chargedAt, target.isSmaller, extraDamage, applyCondition
 */

const card = await item.roll({ activity : 0 });
if(!card) return;

const charge = target => token.chargedAt(target, 20) && target.isSmaller("medium");
card.remove("prone");                                      // the item's own Prone would land on any hit
card.append(extraDamage("1d6", { type : "piercing", when : ["hit", charge] }));
card.append(applyCondition({ when : ["hit", charge], type : "prone" }));
