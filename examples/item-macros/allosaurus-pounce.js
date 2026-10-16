/**
 * Allosaurus : Claws (Pounce)
 *   "If the target is a Large or smaller creature and the allosaurus moved 30+ feet straight toward it immediately
 *    before the hit, the target has the Prone condition, and the allosaurus can make one Bite attack against it."
 *
 * Setup : Item Macro on the Claws, mode "Macro instead of the item's use" (it runs that use itself : item.roll()).
 *         Put it on the actor in the sidebar : tokens placed from it carry it.
 * Uses  : item.roll(), card.remove / card.append, applyCondition, followUp, target.isSmaller, token.chargedAt
 */

const card = await item.roll();          // the normal Claws use : targets, attack, damage, its card
if(!card) return;                        // the target pick was closed : nothing rolled

// Per target : Large or smaller, and charged straight at it (30+ ft, just before)
const pounce = target => target.isSmaller("large") && token.chargedAt(target, 30);

card.remove("prone");                    // the Claws' own Prone would show on every hit
card.append(applyCondition({ type : "prone", when : ["hit", pounce] }));
card.append(followUp("Bite", { when : ["hit", pounce] }));
