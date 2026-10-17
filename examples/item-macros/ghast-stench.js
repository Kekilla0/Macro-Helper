/**
 * Ghast : Stench
 *   "Constitution Saving Throw: DC 10, any creature that starts its turn in a 5-foot Emanation originating from the
 *    ghast. Failure: The target has the Poisoned condition until the start of its next turn. Success: The target is
 *    immune to this ghast's Stench for 24 hours."
 *
 * Setup : Item Macro on Stench, Run on Hooks : "Any creature's turn starts", not only about itself, Run For : Active GM (once).
 * Uses  : token.distanceTo, target.isImmuneTo(item), item.roll({ targets }), applyCondition, immunity
 */

const [, other] = args;
const near = other && (other.uuid !== token.document.uuid) && (MacroHelper.distanceBetween(token, other.object ?? other) <= 5);
if(!near || other.actor?.isImmuneTo?.(item)) return;
const card = await item.roll({ targets : [other.object ?? other], cost : "free" });
if(!card) return;

card.remove("poisoned");
card.append(applyCondition({ when : "fail", type : "poisoned", duration : "startOfNextTurn" }));
card.append(immunity({ when : "save", duration : "24h" }));
