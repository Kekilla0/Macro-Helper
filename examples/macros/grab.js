/**
 * Grab (a monster's homebrew action) : a creature within 5 ft makes a DC 13 Strength save. On a failure it's Grappled
 * (escape DC 13), on a success it's shoved 5 ft away instead.
 *
 * Setup : Item Macro on the feature, mode "Macro only". Run it as the GM : only a creature's owner or the GM can
 *         roll its save.
 * Uses  : token.pickTargets({ count, range }) (click a creature on the map), target.actor.save(ability, dc, { from }),
 *         token.grapple(target, { escape }), token.push(target, feet)
 */

const [target] = await token.pickTargets({ count : 1, range : 5 });
if(!target) return;                      // Esc, or nobody within 5 ft

const save = await target.actor.save("str", 13, { from : item });
if(!save) return ui.notifications.warn(`Only ${target.name}'s owner or the GM can roll its save.`);

if(save.success) await token.push(target, 5);
else await token.grapple(target, { escape : 13 });
