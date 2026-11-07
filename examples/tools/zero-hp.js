/**
 * 0 HP handling
 *   NPC, unlinked token -> that token is Dead (and defeated in combat)
 *   NPC, linked actor   -> the actor is Dead (all its tokens)
 *   PC, Important NPC   -> Unconscious + dying : death saves start fresh, a chat line says so (and which
 *                          Concentration ends : Macro Helper ends it without a save card). Important is the
 *                          switch on dnd5e's NPC sheet.
 *   Healed above 0      -> all of the above cleared
 *   Vehicles            -> left alone (a wagon has no hit points : 0 / 0 isn't dead)
 *
 * Setup : Hook Macro (world macro, Script). Run on Hooks : "Actor changed (HP...)" (updateActor).
 *         Run For : Active GM (once).
 *         Unlinked tokens report HP changes through updateActor too, with that token's own actor.
 * Uses  : actor.usesDeathSaves(), actor.setStatus(), actor.setDefeated()
 */

const [actor, changes, options] = args;
if(!foundry.utils.hasProperty(changes, "system.attributes.hp.value")) return;

const hp = actor.system.attributes?.hp;
if(!hp || (actor.type === "vehicle")) return;

const down = hp.value <= 0;
const dropped = down && ((options?.dnd5e?.hp?.value ?? 1) > 0);   // HP before this change, recorded by dnd5e

/* Player characters and Important NPCs : Unconscious and dying, not dead */
if(actor.usesDeathSaves()){
  await actor.setStatus("unconscious", down, { overlay : true });
  if(!down) return actor.setStatus("stable", false);
  if(dropped){
    await actor.update({ "system.attributes.death.success" : 0, "system.attributes.death.failure" : 0 });
    /* Concentration ends at 0 HP : said on the same card */
    const held = [...(actor.concentration?.effects ?? [])].map(e => e.name.replace(/^Concentrating:\s*/i, "")).filter(Boolean);
    const lost = held.length ? ` Concentration on ${held.join(", ")} ends.` : "";
    ChatMessage.create({
      speaker : ChatMessage.getSpeaker({ actor }),
      content : `<p><strong>${actor.name}</strong> drops to 0 HP and is dying.${lost} Death saving throws at the start of each turn.</p>`,
    });
  }
  return;
}

/* NPCs : Dead, and defeated in combat */
await actor.setStatus(CONFIG.specialStatusEffects.DEFEATED, down, { overlay : true });
await actor.setDefeated(down);
