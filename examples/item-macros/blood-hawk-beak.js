/**
 * Blood Hawk : Beak
 *   "Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d4 + 2) Piercing damage, or 6 (1d8 + 2) Piercing damage if the
 *    target is Bloodied."
 *
 * Setup : Item Macro on Beak, mode "Macro only". Plutonium's Beak has two attacks : 1d4 (first), 1d8 (second).
 * Uses  : MacroHelper.pickTargets, item.roll({ activity, targets })   Bloodied : dnd5e's own condition, judged at the attack
 */

const [target] = await MacroHelper.pickTargets(item, { count : 1 });   // its reach, from the item
if(!target) return;
await item.roll({ activity : target.actor.statuses.has("bloodied") ? 1 : 0, targets : [target] });
