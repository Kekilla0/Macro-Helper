/**
 * Ettercap : Reel  (Bonus Action)
 *   "The ettercap pulls one creature within 30 feet of itself that is Restrained by its Web Strand up to 25 feet
 *    straight toward itself."
 *
 * Setup : Item Macro on Reel, mode "Macro only".
 * Uses  : MacroHelper.affectedBy(item), MacroHelper.pickTargets({ filter }), item.roll({ targets }), token.pull
 */

const webbed = MacroHelper.affectedBy(actor.items.getName("Web Strand"));
const [target] = await MacroHelper.pickTargets(token, { count : 1, range : 30, disposition : "any", filter : t => webbed.includes(t) });
if(!target || !await item.roll({ targets : [target] })) return;
await token.pull(target, 25);
