/**
 * Gelatinous Cube : Engulf
 *   "The cube moves up to its Speed without provoking Opportunity Attacks. The cube can move through the spaces of
 *    Large or smaller creatures if it has room inside itself to contain them. Dexterity Saving Throw: DC 12, each
 *    creature whose space the cube enters for the first time during this move. Failure: 10 (3d6) Acid damage, and the
 *    target is engulfed. An engulfed target is suffocating, can't cast spells with a Verbal component, has the
 *    Restrained condition, and takes 10 (3d6) Acid damage at the start of each of the cube's turns. When the cube moves,
 *    the engulfed target moves with it. An engulfed target can try to escape by taking an action to make a DC 12
 *    Strength (Athletics) check. On a successful check, the target escapes and enters the nearest unoccupied space.
 *    Success: Half damage, and the target moves to an unoccupied space within 5 feet of the cube."
 *
 * Setup : Item Macro on Engulf, mode "Macro only".
 * Uses  : token.trample, item.roll({ targets }), engulf (inside it, its acid at the start of its turns, Escape /
 *         Pull out), push (out of the way on a success)
 */

const engulfed = await token.trample(token.actor.system.attributes.movement.walk, { size : "large", disengage : true, endInside : true });
if(!engulfed) return;
const card = await item.roll({ activity : 0, targets : engulfed });
if(!card) return;

card.remove("restrained");                                 // the item's own : engulf brings its Restrained
card.append(engulf({ when : "fail", escape : 12, damage : "3d6", type : "acid" }));
card.append(push(5, { when : "save" }));
