/**
 * Trampling Charge : the creature moves up to its Speed in a straight line through the spaces of Medium or smaller
 * creatures, without provoking Opportunity Attacks, and makes one attack against each creature it moved through.
 *
 * Setup : Item Macro on the attack, mode "Macro only".
 * Uses  : token.trample(feet, { size, disengage }) (pick a space, move through creatures; returns them),
 *         token.useMovement(feet) (more movement this turn, like a Dash), item.roll({ targets })
 *
 * Other moves work the same way : token.teleport(30, { item }), token.leap(30, { item }), token.push(target, 10),
 * token.pull(target, 25).
 */

const speed = token.actor.system.attributes.movement.walk;
const trampled = await token.trample(speed, { size : "medium", disengage : true });
if(!trampled) return;                    // Esc : nothing moved, nothing used

await token.useMovement(speed);          // "moves up to its Speed" : that much more this turn
if(trampled.length) await item.roll({ targets : trampled });
