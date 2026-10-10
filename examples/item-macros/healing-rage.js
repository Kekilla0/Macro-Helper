/**
 * Healing Rage (Orc Warrior) : heal 11 hit points as a bonus action, once a day. Works for any "heal yourself" feature.
 * The amount is read from the item : a Heal activity's healing, a Utility activity's roll formula, or its description
 * ("can heal 11 hit points", "regains 10 (3d6) hit points" rolls 3d6). Edit the item to change it.
 * dnd5e does the using (its card, the bonus action, the daily use), then the macro heals, so an orc with no uses
 * left doesn't heal.
 *
 * Setup : Item Macro on the feature, mode "Macro only". (A feature with a real Heal activity doesn't need this :
 *         dnd5e's own heal card does it, and Roll Item's Heals setting applies it straight away.)
 * Uses  : item.getHealing(), item.useActivity() (dnd5e's own use, null if it couldn't be used), actor.heal()
 */

const healing = item.getHealing();
if(!healing) return ui.notifications.warn(`${item.name} doesn't say how much it heals.`);

/* Already at full HP : keep the daily use */
const { value, max } = actor.system.attributes.hp;
if(value >= max) return ui.notifications.info(`${actor.name} is already at full health.`);

const used = await item.useActivity({ event : scope.event });
if(!used) return;

await actor.heal(healing);

/* Read back from the token : an unlinked token's actor is rebuilt by the update */
const after = (token?.actor ?? actor).system.attributes.hp.value;
ChatMessage.create({
  speaker : ChatMessage.getSpeaker({ actor, token : token?.document ?? token }),
  content : `<p><strong>${actor.name}</strong> heals ${after - value} HP (${value} → ${after}).</p>`,
});
