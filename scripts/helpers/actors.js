import { tokenOf, actorOf } from './tokens.js';

/**
 * Turn a status (condition) on or off, only if it isn't already : unlike toggleStatusEffect it never flips.
 * On an unlinked token it lands on that token only, on a linked actor on the actor (all its tokens).
 * @param {Actor|Token|TokenDocument} thing
 * @param {string} status              e.g. "dead", "unconscious", "prone", CONFIG.specialStatusEffects.DEFEATED
 * @param {boolean} [active=true]
 * @param {object} [options]
 * @param {boolean} [options.overlay=false]  show it as the large icon over the token
 * @returns {Promise<boolean>}  true if it changed
 */
export async function setStatus(thing, status, active = true, { overlay = false } = {}){
  const actor = actorOf(thing);
  if(!actor || (actor.statuses.has(status) === active)) return false;
  await actor.toggleStatusEffect(status, { active, overlay });
  return true;
}

/**
 * Mark a creature defeated (or not) in the current combat, only if it is in it and not already in that state.
 * @param {Actor|Token|TokenDocument} thing
 * @param {boolean} [defeated=true]
 * @returns {Promise<boolean>}  true if a combatant changed
 */
export async function setDefeated(thing, defeated = true){
  const actor = actorOf(thing);
  const token = (thing?.documentName === "Actor") ? null : tokenOf(thing)?.document;
  const combatants = game.combat?.combatants.filter(c =>
    (token ? (c.tokenId === token.id) : (c.actor === actor)) && (c.defeated !== defeated)
  ) ?? [];
  for(const combatant of combatants) await combatant.update({ defeated });
  return combatants.length > 0;
}

/**
 * dnd5e size of an actor / token : { key : "med", value : 2, label : "Medium" }. value : tiny 0, sm 1, med 2, lg 3, huge 4, grg 5.
 * @param {Actor|Token|TokenDocument} thing
 * @returns {{ key : string, value : number, label : string }|null}
 */
export function getSize(thing){
  const actor = thing?.documentName === "Actor" ? thing : thing?.actor;
  const key = actor?.system?.traits?.size;
  const config = CONFIG.DND5E?.actorSizes?.[key];
  if(!config) return null;
  return { key, value : config.numerical, label : game.i18n.localize(config.label) };
}

/**
 * A dnd5e size key a number of steps away : stepSize("lg", -1) = "med".
 * @param {string} key
 * @param {number} [steps=-1]
 * @returns {string}
 */
export function stepSize(key, steps = -1){
  const sizes = Object.keys(CONFIG.DND5E.actorSizes);
  const index = sizes.indexOf(key);
  if(index < 0) return key;
  return sizes[Math.clamp(index + steps, 0, sizes.length - 1)];
}

/**
 * Replace a token with copies of itself, sharing its HP (Ochre Jelly / Black Pudding Split). GM only.
 * Copies keep the token's data (conditions, effects, elevation...), land inside the original's space
 * and keep its place in combat. The original is deleted once the copies exist.
 * @param {Token|TokenDocument|Actor} thing
 * @param {object} [options]
 * @param {number} [options.copies=2]
 * @param {number} [options.hp=0.5]          fraction of current HP each copy gets (rounded down), also its max HP
 * @param {number} [options.scale=0.5]       token width / height multiplier
 * @param {boolean} [options.stepSize=true]  also one dnd5e size category smaller
 * @param {boolean} [options.chat=true]      post a line to chat
 * @returns {Promise<TokenDocument[]>}
 */
export async function splitToken(thing, { copies = 2, hp = 0.5, scale = 0.5, stepSize : step = true, chat = true } = {}){
  const source = tokenOf(thing);
  if(!source) return warn("Split : no token to split.");
  if(!game.user.isGM) return warn("Split : only the GM can create and delete tokens.");

  const doc = source.document;
  if(doc.actorLink) return warn(`Split : ${doc.name} is linked to its actor, the copies would share one HP pool. Unlink it first.`);

  const value = Math.floor((source.actor.system.attributes?.hp?.value ?? 0) * hp);
  if(value < 1) return warn(`Split : ${doc.name} doesn't have enough HP to split.`);

  const width = doc.width * scale, height = doc.height * scale;
  const size = source.actor.system.traits?.size;
  const newSize = (step && size) ? stepSize(size, -1) : size;

  /* Spread the copies over the original's space : corners first, then side by side */
  const gs = canvas.grid.size;
  const spots = [
    { x : doc.x, y : doc.y },
    { x : doc.x + (doc.width - width) * gs, y : doc.y + (doc.height - height) * gs },
    { x : doc.x + (doc.width - width) * gs, y : doc.y },
    { x : doc.x, y : doc.y + (doc.height - height) * gs },
  ];
  const positions = [];
  for(let i = 0; i < copies; i++){
    let spot = spots[i] ?? spots[0];
    if(positions.some(p => p.x === spot.x && p.y === spot.y)) spot = { x : doc.x + width * gs * i, y : doc.y };
    positions.push(spot);
  }

  const data = doc.toObject();
  delete data._id;
  const tokens = positions.map(pos => {
    const token = foundry.utils.deepClone(data);
    Object.assign(token, pos, { width, height });
    foundry.utils.setProperty(token, "delta.system.attributes.hp.value", value);
    foundry.utils.setProperty(token, "delta.system.attributes.hp.max", value);
    foundry.utils.setProperty(token, "delta.system.attributes.hp.temp", 0);
    if(newSize) foundry.utils.setProperty(token, "delta.system.traits.size", newSize);
    return token;
  });

  /* Keep its place in combat */
  const combatant = game.combat?.combatants.find(c => c.tokenId === doc.id && c.sceneId === doc.parent.id);

  /* dnd5e would re-roll unlinked NPC HP on creation otherwise */
  const created = await doc.parent.createEmbeddedDocuments("Token", tokens, { dnd5e : { autoRollNPCHP : "no" } });
  if(combatant) await game.combat.createEmbeddedDocuments("Combatant", created.map(t => ({
    tokenId : t.id, sceneId : t.parent.id, actorId : t.actorId,
    initiative : combatant.initiative, hidden : combatant.hidden,
  })));
  await doc.delete();

  if(chat) ChatMessage.implementation.create({
    speaker : ChatMessage.implementation.getSpeaker({ actor : source.actor }),
    content : `<p><strong>${doc.name}</strong> splits into ${copies} creatures with <strong>${value} HP</strong> each.</p>`,
  });
  return created;
}

function warn(message){
  ui.notifications.warn(message);
  return [];
}
