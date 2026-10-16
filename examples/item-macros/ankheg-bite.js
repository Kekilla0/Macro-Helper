/**
 * Ankheg : Bite
 *   "Melee Attack Roll: +5 (with Advantage if the target is Grappled by the ankheg), reach 5 ft. Hit: 10 (2d6 + 3)
 *    Slashing damage plus 3 (1d6) Acid damage. If the target is a Large or smaller creature, it has the Grappled
 *    condition (escape DC 13)."
 *
 * Setup : Item Macro on the Bite, mode "Macro only".
 * Uses  : item.roll({ advantage }), token.grappling(), applyCondition (escape), target.isSmaller
 */

const card = await item.roll({ advantage : target => token.grappling().includes(target) });
if(!card) return;

card.remove("grappled");                         // the item's own Grappled would land on any hit, any size
card.append(applyCondition({ when : ["hit", target => target.isSmaller("large")], type : "grappled", escape : 13 }));
