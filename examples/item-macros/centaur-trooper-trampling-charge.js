/**
 * Centaur Trooper : Trampling Charge  (Bonus Action, Recharge 5–6)
 *   "The centaur moves up to its Speed without provoking Opportunity Attacks and can move through the spaces of Medium
 *    or smaller creatures. Each creature whose space the centaur enters is targeted once by the following effect.
 *    Strength Saving Throw: DC 14. Failure: 7 (1d6 + 4) Bludgeoning damage, and the target has the Prone condition."
 *
 * Setup : Item Macro on Trampling Charge, mode "Macro only".
 * Uses  : token.trample(feet, { size, disengage }) : pick where it goes (Esc : nothing more), move there in a straight
 *         line through Medium or smaller creatures, no Opportunity Attacks; the enemies it ran through, in order.
 *         token.useMovement(50) : 50 ft more movement this turn (the charge's own, like a Dash);
 *         item.roll({ targets }) : the save card for exactly those.
 */

const speed = token.actor.system.attributes.movement.walk;
const trampled = await token.trample(speed, { size : "medium", disengage : true });
if(!trampled) return;                                      // Esc : nothing moved, nothing used
await token.useMovement(speed);                            // "moves up to its Speed" : that much more this turn
await item.roll({ targets : trampled });
