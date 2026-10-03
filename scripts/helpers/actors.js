import { module } from '../module.js';
import { tokenOf, actorOf } from './tokens.js';
import { gm } from '../gm.js';

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
  const max = Number(hp.effectiveMax) || Number(hp.max) || 0;
  return (max > 0) && (left >= max);
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

/* ---------- Saves & effects ---------- */

/**
 * Roll a saving throw for a creature against a DC, without dnd5e's dialog.
 * @param {Actor|Token|TokenDocument} thing
 * @param {string} ability   "con", "dex"...
 * @param {number} dc
 * @returns {Promise<{ success : boolean, total : number, roll : Roll }|null>}  null if it wasn't rolled
 */
export async function rollSave(thing, ability, dc){
  const actor = actorOf(thing);
  if(!actor?.rollSavingThrow || !actor.isOwner) return null;
  const token = tokenOf(thing);
  const speaker = ChatMessage.implementation.getSpeaker({ actor, token : token?.document });
  const [roll] = await actor.rollSavingThrow({ ability, target : dc }, { configure : false }, { data : { speaker } }) ?? [];
  if(!roll) return null;
  return { success : roll.total >= dc, total : roll.total, roll };
}

/**
 * Put an effect on a creature that lasts until the start or end of someone's next turn (a weapon mastery, a spell's
 * "until the start of your next turn"). The active GM removes it then; out of combat it stays until removed or used up.
 * Needs permission to change the creature (its owner or the GM).
 * @param {Actor|Token|TokenDocument} thing   who gets the effect
 * @param {object} data                       ActiveEffect data (name, img, system.changes, statuses, flags...)
 * @param {object} [options]
 * @param {Actor|Token} [options.of]                    whose turn it waits for (default : the creature itself)
 * @param {"turnStart"|"turnEnd"} [options.until="turnStart"]
 * @returns {Promise<ActiveEffect|null>}
 */
export async function addTimedEffect(thing, data, { of, until = "turnStart" } = {}){
  const actor = actorOf(thing);
  if(!actor?.isOwner) return null;
  const expires = gm.stamp(actorOf(of) ?? actor, until);
  /* Shown on the token : Foundry only shows effects with a duration unless told to */
  const effect = foundry.utils.mergeObject({ showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2, flags : { [module.id] : { expires } } }, data, { inplace : false });
  const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [effect]);
  return created ?? null;
}

/* ---------- Last damage ---------- */

/**
 * The last damage a creature took (through dnd5e's damage application) and the card that dealt it.
 * For "reduce the damage you take" reactions (Stone's Endurance, Uncanny Dodge...).
 * @param {Actor|Token|TokenDocument} thing
 * @returns {{ amount : number, message : ChatMessage|null, at : number }|null}
 */
export function getLastDamage(thing){
  const last = actorOf(thing)?.getFlag(module.id, "lastDamage");
  if(!last) return null;
  return { amount : last.amount, message : last.message ? (game.messages.get(last.message) ?? null) : null, at : last.at };
}

/**
 * Forget the last damage a creature took (see getLastDamage) : once a reaction has used it, so the same hit can't be
 * reduced twice. Rests forget it too.
 * @param {Actor|Token|TokenDocument} thing
 * @returns {Promise<void>}
 */
export async function clearLastDamage(thing){
  const actor = actorOf(thing);
  if(actor?.isOwner && actor.getFlag(module.id, "lastDamage")) await actor.unsetFlag(module.id, "lastDamage");
}

/* ---------- Once per turn ---------- */

/**
 * Has a creature already used something this turn (Savage Attacker, Sneak Attack, Cleave...) ? In combat only :
 * out of combat there are no turns to count, so it's never "used".
 * @param {Actor|Token|TokenDocument} thing
 * @param {string} key   what it is ("savage")
 * @returns {boolean}
 */
export function usedThisTurn(thing, key){
  const actor = actorOf(thing);
  const now = gm.stamp(actor, "turnEnd");
  const last = actor?.getFlag(module.id, `turn.${key}`);
  return !!(now && last && (last.combat === now.combat) && (last.round === now.round) && (last.turn === now.turn));
}

/**
 * Mark something as used this turn (see usedThisTurn). Does nothing out of combat.
 * @param {Actor|Token|TokenDocument} thing
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function markUsedThisTurn(thing, key){
  const actor = actorOf(thing);
  const now = gm.stamp(actor, "turnEnd");
  if(now && actor?.isOwner) await actor.setFlag(module.id, `turn.${key}`, { combat : now.combat, round : now.round, turn : now.turn });
}

/* ---------- Spell slots ---------- */

/**
 * Choose expended spell slots to get back, up to a combined level (Arcane Recovery, Natural Recovery).
 * A dialog lists the spent slots up to `maxLevel` with the running total; the slots are restored on confirm.
 * With `item`, it needs a use left, and one is spent once something is recovered.
 * @param {Actor|Token|TokenDocument} thing
 * @param {object} options
 * @param {number} options.levels               combined slot levels allowed (Arcane Recovery : half the Wizard level, rounded up)
 * @param {number} [options.maxLevel=5]          highest slot level that can come back (both features : 5th)
 * @param {Item} [options.item]                  the feature, for its name and its use
 * @param {boolean} [options.chat=true]          post what was recovered
 * @returns {Promise<Record<number, number>|null>}  { slot level : slots recovered }, null if cancelled / nothing to do
 */
export async function recoverSpellSlots(thing, { levels, maxLevel = 5, item, chat = true } = {}){
  const actor = actorOf(thing);
  const name = item?.name ?? module.i18n("helpers.slots.title");
  if(!actor?.system?.spells || !actor.isOwner) return null;
  const uses = item?.system?.uses;
  if(item && (Number(uses?.max) > 0) && !(Number(uses.value) > 0)){
    ui.notifications.warn(module.format("helpers.uses.none", { name }));
    return null;
  }

  /* Spent slots per level, up to maxLevel */
  const spent = [];
  for(let level = 1; level <= Math.min(maxLevel, 9); level++){
    const slot = actor.system.spells[`spell${level}`];
    const missing = (Number(slot?.max) || 0) - (Number(slot?.value) || 0);
    if(missing > 0) spent.push({ level, missing, value : Number(slot.value) || 0 });
  }
  if(!spent.length){
    ui.notifications.info(module.format("helpers.slots.none", { name : actor.name }));
    return null;
  }

  const esc = Handlebars.escapeExpression;
  const rows = spent.map(s => `
    <div class="form-group">
      <label>${esc(game.i18n.localize(CONFIG.DND5E.spellLevels[s.level] ?? `Level ${s.level}`))}</label>
      <div class="form-fields">
        <input type="number" name="slot${s.level}" data-level="${s.level}" value="0" min="0" max="${s.missing}" step="1">
        <span class="hint">/ ${s.missing}</span>
      </div>
    </div>`).join("");
  const read = form => Object.fromEntries(spent.map(s => [s.level, Math.max(0, Math.min(s.missing, Math.floor(Number(form.elements[`slot${s.level}`]?.value) || 0)))]));
  const total = picks => Object.entries(picks).reduce((sum, [level, n]) => sum + (Number(level) * n), 0);

  const picks = await foundry.applications.api.DialogV2.prompt({
    window : { title : name, icon : "fa-solid fa-book-sparkles" },
    content : `<p class="hint">${esc(module.format("helpers.slots.hint", { levels, maxLevel }))}</p>${rows}
      <p class="${module.id}-slot-total"></p>`,
    ok : { label : "helpers.slots.confirm", icon : "fa-solid fa-check", callback : (_event, button) => read(button.form) },
    render : (_event, dialog) => {
      const form = dialog.element.querySelector("form") ?? dialog.element;
      const status = dialog.element.querySelector(`.${module.id}-slot-total`);
      const confirm = dialog.element.querySelector("button[data-action=ok]");
      const refresh = () => {
        const sum = total(read(form));
        status.textContent = module.format("helpers.slots.total", { sum, levels });
        if(confirm) confirm.disabled = (sum === 0) || (sum > levels);
      };
      form.addEventListener("input", refresh);
      refresh();
    },
    rejectClose : false,
  });
  if(!picks || !total(picks) || (total(picks) > levels)) return null;

  const update = {};
  for(const s of spent) if(picks[s.level]) update[`system.spells.spell${s.level}.value`] = s.value + picks[s.level];
  await actor.update(update);
  if(item && (Number(uses?.max) > 0)) await item.update({ "system.uses.spent" : (Number(uses.spent) || 0) + 1 });

  const recovered = Object.fromEntries(Object.entries(picks).filter(([, n]) => n > 0));
  /* A card in dnd5e's style : the feature's header and a "Recovery" list, like a rest card */
  if(chat){
    const content = await foundry.applications.handlebars.renderTemplate(`${module.path}/templates/recovery-card.hbs`, {
      name, img : item?.img ?? "icons/svg/book.svg",
      subtitle : actor.name,
      rows : Object.entries(recovered).map(([level, n]) => ({
        label : game.i18n.localize(CONFIG.DND5E.spellLevels[level] ?? level),
        value : `+${n}`,
      })),
    });
    await ChatMessage.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }), content });
  }
  return recovered;
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
 * Stabilize a creature at 0 HP : its death saves reset and it's Stable (no more death saves until it takes damage or
 * regains HP). Help's Stabilize, a Healer's Kit... The GM does it when you don't own the creature.
 * @param {Actor|Token|TokenDocument} thing
 * @returns {Promise<boolean>}  true if it's now stable
 */
export async function stabilize(thing){
  const actor = actorOf(thing);
  if(!actor || (Number(actor.system?.attributes?.hp?.value) > 0)) return false;
  if(!actor.isOwner) return !!(await gm.run("stabilize", { actor : actor.uuid }));
  await actor.update({ "system.attributes.death.success" : 0, "system.attributes.death.failure" : 0 });
  await setStatus(actor, "stable", true);
  ui.notifications.info(module.format("actions.stabilize.done", { name : actor.name }));
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
