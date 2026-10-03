/**
 * Stone's Endurance (Goliath, Giant Ancestry) : as a reaction when you take damage, roll 1d12 + CON and reduce the
 * damage by that much. Done after the damage lands : the roll heals you back, but never more than that hit dealt.
 *
 * Setup : Item Macro on Stone's Endurance, mode "Macro only".
 * Uses  : actor.getLastDamage() (the last damage taken, and the card that dealt it), item.useAndApply({ max }),
 *         actor.clearLastDamage() (the same hit can't be reduced twice; rests clear it too)
 */

const last = actor.getLastDamage();
if(!last) return ui.notifications.warn(`${actor.name} hasn't taken any damage to reduce.`);
const healed = await item.useAndApply({ max : last.amount, event : scope.event });
if(healed !== null) await actor.clearLastDamage();
return healed;
