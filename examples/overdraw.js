/**
 * Overdraw (Orc Archer) : "The orc archer can use a bonus action before they attack to add 1d4 to their damage
 * on a successful attack with their bow."
 * Puts an effect on the archer's bow adding 1d4 to its damage, which removes itself after the bow's next damage roll.
 *
 * Setup : Item Macro on the "Overdraw" feature, mode "Macro only". Use it (the bonus action), then attack with the bow.
 * How   : a dnd5e "enchantment" effect on the bow (an effect that changes the item it's on) :
 *         system.damage.base.bonus + 1d4, so the bow's damage becomes 1d6 + 1d4 + mod (its own damage type, doubled on a crit).
 *         It is deleted after the bow's next damage roll, and lasts 1 round at most in case the attack never happens.
 * Note  : rerolling that attack's damage on the chat card rolls without the 1d4 (the effect is already used up).
 */

const BONUS = "1d4";
const FLAG = "macro-helper";

if(!actor) return ui.notifications.warn(`${item.name}: this feature isn't on an actor.`);

/* The bow : a Shortbow / Longbow, else any ranged weapon that uses ammunition */
const bow = actor.items.find(i => (i.type === "weapon") && ["shortbow", "longbow"].includes(i.system.type?.baseItem))
  ?? actor.items.find(i => (i.type === "weapon") && (i.system.attackType === "ranged") && i.system.properties?.has("amm"));
if(!bow) return ui.notifications.warn(`${item.name}: ${actor.name} has no bow.`);

/* Already drawn back */
if(bow.effects.some(e => e.getFlag(FLAG, "overdraw"))) return ui.notifications.info(`${item.name}: the ${bow.name} is already drawn back.`);

const [effect] = await bow.createEmbeddedDocuments("ActiveEffect", [{
  name : item.name,
  img : item.img,
  type : "enchantment",
  transfer : true,
  origin : item.uuid,
  description : `<p>+${BONUS} damage on the next attack with the ${bow.name}.</p>`,
  system : { changes : [{ key : "system.damage.base.bonus", type : "add", value : BONUS }] },
  duration : { value : 1, units : "rounds" },
  flags : { [FLAG] : { overdraw : true } },
}]);

/* Used up by the bow's next damage roll. Items on unlinked tokens are rebuilt on update, so look the bow up again by id. */
const bowUuid = bow.uuid;
const hook = Hooks.on("dnd5e.rollDamageV2", (rolls, { subject } = {}) => {
  if(subject?.item?.uuid !== bowUuid) return;
  Hooks.off("dnd5e.rollDamageV2", hook);
  actor.items.get(bow.id)?.effects.get(effect.id)?.delete();
});

ChatMessage.create({
  speaker : ChatMessage.getSpeaker({ actor }),
  content : `<p><strong>${actor.name}</strong> overdraws the ${bow.name} : +${BONUS} damage on the next attack.</p>`,
});
return effect;
