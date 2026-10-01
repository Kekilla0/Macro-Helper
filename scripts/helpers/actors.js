import { module } from '../module.js';
import { tokenOf, actorOf } from './tokens.js';

/* ---------- Hit points ----------
 * On dnd5e's own actor.applyDamage : the same path as the chat card APPLY trays, so resistances, immunities,
 * vulnerabilities and damage modification apply per damage type, and temp HP soaks first.
 * On an unlinked token they change that token only, on a linked actor the actor.
 * Values can be numbers or dice formulas ("2d6 + 3"), rolled with the actor's roll data.
 */

/* A number, or a formula rolled with the actor's data */
async function amountOf(value, actor){
  if(Number.isNumeric(value)) return Number(value);
  const roll = await new Roll(String(value), actor.getRollData()).evaluate();
  return roll.total;
}

/* The actor, if it has hit points and the user may change them */
function hpActor(thing){
  const actor = actorOf(thing);
  if(!actor?.system?.attributes?.hp) return null;
  if(!actor.isOwner){
    ui.notifications.warn(module.format("helpers.hp.notOwner", { name : actor.name }));
    return null;
  }
  return actor;
}

/**
 * Damage an actor / token.
 * @param {Actor|Token|TokenDocument} thing
 * @param {number|string|object[]} value   amount or formula, or several parts [{ value, type, properties }]
 * @param {string} [type]                   damage type key ("fire", "slashing"...), none = untyped
 * @param {object} [options]
 * @param {string[]} [options.properties]   e.g. ["mgc"] (magical), for resistances that care
 * @param {number} [options.multiplier=1]   e.g. 0.5 for half damage
 * @param {boolean|object} [options.ignore] dnd5e : ignore resistances etc. (true, or { resistance : true }...)
 * @returns {Promise<number>}  the damage asked for, before resistances
 */
export async function damage(thing, value, type, { properties = [], multiplier = 1, ignore } = {}){
  const actor = hpActor(thing);
  if(!actor) return 0;

  const parts = Array.isArray(value) ? value : [{ value, type, properties }];
  const damages = [];
  for(const part of parts){
    damages.push({
      value : Math.max(0, await amountOf(part.value, actor)),
      type : part.type ?? undefined,
      properties : new Set(part.properties ?? []),
    });
  }

  const options = { multiplier, isDelta : true };
  if(ignore !== undefined) options.ignore = ignore;
  await actor.applyDamage(damages, options);
  return damages.reduce((total, d) => total + d.value, 0);
}

/**
 * Heal an actor / token (up to its max HP).
 * @param {Actor|Token|TokenDocument} thing
 * @param {number|string} value  amount or formula
 * @returns {Promise<number>}    the healing asked for
 */
export async function heal(thing, value){
  const actor = hpActor(thing);
  if(!actor) return 0;
  const amount = Math.max(0, await amountOf(value, actor));
  await actor.applyDamage([{ value : amount, type : "healing" }], { isDelta : true });
  return amount;
}

/**
 * Give temporary hit points. They don't stack (5e) : the higher of the current and new amount is kept.
 * @param {Actor|Token|TokenDocument} thing
 * @param {number|string} value   amount or formula
 * @param {string|Document} [source]  where they came from ("False Life", or an item / actor : its name is used),
 *                                    kept in actor.flags["macro-helper"].tempHP = { value, source } when applied
 * @returns {Promise<boolean>}    true if the temp HP was applied (it beat the current amount)
 */
export async function tempHP(thing, value, source){
  const actor = hpActor(thing);
  if(!actor) return false;

  const amount = Math.max(0, Math.floor(await amountOf(value, actor)));
  const current = Number(actor.system.attributes.hp.temp) || 0;
  if(amount <= current) return false;

  const update = { "system.attributes.hp.temp" : amount };
  if(source !== undefined) update[`flags.${module.id}.tempHP`] = { value : amount, source : source?.name ?? String(source) };
  await actor.update(update);
  return true;
}

/* ---------- Dropping to 0 HP ----------
 * For "reduced to 0 hit points but not killed outright" features (Relentless Endurance, Undead Fortitude...).
 * `amount` is the damage after resistances, as dnd5e's "dnd5e.preApplyDamage" hook gives it : temp HP soak first.
 */

/**
 * Would this much damage drop a creature that is still up to 0 HP ?
 * @param {Actor|Token|TokenDocument} thing
 * @param {number} amount
 * @returns {boolean}
 */
export function dropsToZero(thing, amount){
  const hp = actorOf(thing)?.system?.attributes?.hp;
  if(!hp || (hp.value <= 0)) return false;
  return (amount - (Number(hp.temp) || 0)) >= hp.value;
}

/**
 * Would this much damage kill a creature outright : 5e's massive damage, what's left after reaching 0 HP is at least its HP max ?
 * @param {Actor|Token|TokenDocument} thing
 * @param {number} amount
 * @returns {boolean}
 */
export function isKilledOutright(thing, amount){
  const hp = actorOf(thing)?.system?.attributes?.hp;
  if(!hp || !dropsToZero(thing, amount)) return false;
  const left = amount - (Number(hp.temp) || 0) - hp.value;
  return left >= (hp.effectiveMax ?? hp.max);
}

/**
 * Inside a "dnd5e.preApplyDamage" hook : leave the creature on `hp` instead of 0. Changes dnd5e's `updates` in place,
 * so call it before any await. Nothing changes (false) if it isn't dropping to 0, is already down, or (unless
 * massiveDamage is false) is killed outright.
 * @param {Actor|Token|TokenDocument} thing
 * @param {number} amount    the hook's amount
 * @param {object} updates   the hook's updates
 * @param {object} [options]
 * @param {number} [options.hp=1]               HP to stay on
 * @param {boolean} [options.massiveDamage=true] massive damage still kills (see isKilledOutright)
 * @returns {boolean}  true if it kept them up
 */
export function preventDropToZero(thing, amount, updates, { hp = 1, massiveDamage = true } = {}){
  const key = "system.attributes.hp.value";
  if(!updates || !(key in updates) || (updates[key] > 0)) return false;
  if(!dropsToZero(thing, amount)) return false;
  if(massiveDamage && isKilledOutright(thing, amount)) return false;
  updates[key] = Math.max(1, hp);
  return true;
}

/* ---------- Items ---------- */

/**
 * Find one of an actor's items by id, uuid, identifier ("relentless-endurance") or name (any case).
 * Several queries : the first that matches wins, so ["Relentless Endurance", "Relentless"] covers both wordings.
 * @param {Actor|Token|TokenDocument|Item} thing
 * @param {string|string[]|Function} query  name / identifier / id / uuid, several, or (item) => boolean
 * @param {object} [options]
 * @param {string} [options.type]           only items of this type ("feat", "weapon", "spell"...)
 * @returns {Item|null}
 */
export function findItem(thing, query, { type } = {}){
  const actor = actorOf(thing);
  if(!actor?.items || (query === undefined) || (query === null)) return null;
  const items = type ? actor.items.filter(i => i.type === type) : actor.items.contents;
  if(typeof query === "function") return items.find(query) ?? null;

  for(const q of [query].flat()){
    const text = String(q).trim();
    const lower = text.toLowerCase();
    const slug = text.slugify({ strict : true });
    const found = items.find(i => (i.id === text) || (i.uuid === text))
      ?? items.find(i => i.name.toLowerCase() === lower)
      ?? items.find(i => (i.identifier ?? i.system.identifier) === slug);
    if(found) return found;
  }
  return null;
}

/* ---------- Conditions & combat ---------- */

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
