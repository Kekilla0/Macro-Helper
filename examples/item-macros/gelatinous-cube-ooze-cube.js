/**
 * Gelatinous Cube : Ooze Cube
 *   "Other creatures can enter that space, but a creature that does so is subjected to the cube's Engulf and has
 *    Disadvantage on the saving throw. ... As an action, a creature within 5 feet of the cube can pull a creature or an
 *    object out of the cube by succeeding on a DC 12 Strength (Athletics) check, and the puller takes 10 (3d6) Acid damage."
 *
 * Setup : Item Macro on Ooze Cube, Run on Hooks : "A creature enters its space", Run For : Active GM (once).
 *         (Pull out : the engulf's own button, on the action bar of creatures beside the cube.)
 * Uses  : item.roll({ targets, saveDisadvantage }) on the Engulf, engulf
 */

const [, mover] = args;
if(!mover || mover.actor?.effects?.some?.(e => e.getFlag("macro-helper", "engulfedBy"))) return;
const engulfItem = actor.items.getName("Engulf");
const card = await engulfItem.roll({ activity : 0, targets : [mover.object ?? mover], saveDisadvantage : true, cost : "free" });
if(!card) return;
card.remove("restrained");                                 // the item's own : engulf brings its Restrained
card.append(engulf({ when : "fail", escape : 12, damage : "3d6", type : "acid" }));
card.append(push(5, { when : "save" }));
