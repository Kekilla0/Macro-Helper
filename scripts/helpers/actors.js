import { module } from '../module.js';
import { tokenOf, actorOf, isSpaceFree } from './tokens.js';
import { gm } from '../gm.js';
import { settings } from '../settings.js';
import { idOf, warned } from './utils.js';

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

/**
 * The spend-Hit-Dice lego : a character rolls some of its unexpended Hit Point Dice and they're expended (Arcane Vigor;
 * a homebrew "spend a Hit Die to..."). How many of each size is asked (up to `max`; no question when there's only one
 * way). The roll is posted with `bonus` added; nothing is healed here (the rule does what it wants with the total).
 * @param {Actor|Token} thing
 * @param {object} [options]
 * @param {number} [options.max=1]      at most this many dice
 * @param {number} [options.min=1]      at least this many
 * @param {string} [options.bonus]      added to the roll (a formula : "@abilities.int.mod")
 * @param {string} [options.flavor]     the roll card's title
 * @returns {Promise<{ total : number, roll : Roll, dice : Object<string, number> }|null>}  null : none spent
 */
export async function spendHitDice(thing, { max = 1, min = 1, bonus = "", flavor = "" } = {}){
  const actor = actorOf(thing);
  if(!actor?.isOwner) return null;
  /* What each size has left, over every class of that size */
  const left = {};
  for(const cls of actor.items.filter(i => (i.type === "class") && (Number(i.system.hd?.value) > 0))) left[cls.system.hd.denomination] = (left[cls.system.hd.denomination] ?? 0) + Number(cls.system.hd.value);
  const sizes = Object.keys(left).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  const most = Math.min(max, Object.values(left).reduce((a, b) => a + b, 0));
  if(!sizes.length || (most < min)){
    ui.notifications.warn(module.format("helpers.hitDice.none", { name : actor.name, n : min }));
    return null;
  }
  let dice = { [sizes[0]] : most };
  if((sizes.length > 1) || (most > min)){
    const fields = sizes.map(d => `<div class="form-group"><label>${d} (${left[d]})</label><input type="number" name="${d}" min="0" max="${Math.min(left[d], most)}" value="${(d === sizes[0]) ? Math.min(left[d], most) : 0}"></div>`).join("");
    dice = await foundry.applications.api.DialogV2.wait({
      window : { title : flavor || module.i18n("helpers.hitDice.title"), icon : "fa-solid fa-dice-d20" },
      content : `<p>${module.format("helpers.hitDice.prompt", { min, max : most })}</p>${fields}`,
      buttons : [{ action : "ok", label : module.i18n("helpers.hitDice.roll"), icon : "fa-solid fa-dice", default : true,
        callback : (event, button) => Object.fromEntries(sizes.map(d => [d, Math.clamp(Math.floor(Number(button.form.elements[d].value) || 0), 0, left[d])])) }],
      rejectClose : false,
    }).catch(() => null);
    if(!dice || (dice === "ok")) return null;
    const count = Object.values(dice).reduce((a, b) => a + b, 0);
    if((count < min) || (count > most)){
      ui.notifications.warn(module.format("helpers.hitDice.count", { min, max : most }));
      return null;
    }
  }
  const terms = Object.entries(dice).filter(([, n]) => n > 0).map(([d, n]) => `${n}${d}`);
  const roll = await new Roll([...terms, bonus].filter(Boolean).join(" + "), actor.getRollData()).evaluate();
  await roll.toMessage({ speaker : ChatMessage.implementation.getSpeaker({ actor }), flavor });
  /* Expended : each size from its classes in turn */
  const updates = [];
  for(const [d, n] of Object.entries(dice)){
    let todo = n;
    for(const cls of actor.items.filter(i => (i.type === "class") && (i.system.hd?.denomination === d))){
      const take = Math.min(todo, Number(cls.system.hd.value) || 0);
      if(take > 0) updates.push({ _id : cls.id, "system.hd.spent" : (Number(cls.system.hd.spent) || 0) + take });
      todo -= take;
    }
  }
  if(updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  return { total : roll.total, roll, dice };
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

/* The save activity a save is made against : the activity itself, else the item's save (the one with that ability first) */
function saveActivityOf(from, ability){
  if(!from) return null;
  if(from.save && from.item) return from;
  const saves = [...(from.system?.activities ?? [])].filter(a => a.type === "save");
  return saves.find(a => a.save?.ability?.has?.(ability)) ?? saves[0] ?? null;
}

/**
 * The save lego : a creature makes a saving throw, the same way for every rule (a card's row, an on-hit save, a repeat
 * save at the end of its turn, Topple). Read as : target.actor.save("con", 13, { from : item }).
 * The roll keeps the keys held (advantage / disadvantage), dnd5e's own bonuses and rules (Paralyzed fails STR / DEX).
 * A creature the user doesn't own : the active GM's client rolls it (no dialog, no keys).
 * @param {Actor|Token|TokenDocument} thing
 * @param {string} ability   "con", "dex"...
 * @param {number} [dc]      without one, dnd5e judges nothing : success is null
 * @param {object} [options]
 * @param {Item|Activity} [options.from]  what it saves against : its save activity's bonus is added, the save is linked to it
 * @param {string}  [options.bonus]       more to add to the save (a formula)
 * @param {number}  [options.cover]       cover's bonus to a DEX save (+2 half, +5 three-quarters)
 * @param {Event}   [options.event]       the click, for its advantage / disadvantage keys
 * @param {boolean} [options.dialog]      dnd5e's roll dialog first (default : none)
 * @param {boolean} [options.secret]      a private GM roll (default : an NPC's, with the DM Screen setting on)
 * @param {ChatMessage} [options.card]    the card it's for : the save links to it, and a secret save's success is noted on it
 * @param {object}  [options.flags]       the save message's own flags (macro-helper's); `against` : the conditions it's
 *                                        made to avoid or end (["poisoned"] : saveModeAgainst's traits count)
 * @returns {Promise<{ success : boolean|null, total : number, roll : Roll }|null>}  null if it wasn't rolled
 */
export async function rollSave(thing, ability, dc = null, { from = null, bonus = null, cover = 0, event = null, dialog = false, secret, card = null, flags = null } = {}){
  const actor = actorOf(thing);
  if(!actor?.rollSavingThrow || !ability) return null;
  if(!actor.isOwner) return saveByGM(thing, ability, dc, { from, bonus, cover, secret, card, flags });
  const token = tokenOf(thing);
  dc = ((dc === null) || (dc === "")) ? NaN : Number(dc);

  const activity = saveActivityOf(from, ability);
  const config = { ability, ...(event ? { event } : {}), ...(Number.isFinite(dc) ? { target : dc } : {}) };
  const activityBonus = activity ? CONFIG.Dice.BasicRoll.replaceFormulaData(activity.save?.bonus ?? "", activity.getRollData(), { missing : 0 }) : "";
  const covered = (ability === "dex") ? (Number(cover) || 0) : 0;
  const parts = CONFIG.Dice.BasicRoll.constructParts({ activityBonus, bonus : bonus ?? "", cover : covered || "" });
  if(parts.parts.length) config.rolls = [parts];

  secret ??= settings.value("rollItemDmScreen") && !actor.hasPlayerOwner;
  const speaker = ChatMessage.implementation.getSpeaker({ actor, token : token?.document });
  const data = { speaker, system : { ...(activity?.messageSources ?? {}), ...(card ? { origin : card.id } : {}) }, ...(flags ? { flags : { [module.id] : flags } } : {}) };
  const messageConfig = { data, ...(secret ? { rollMode : "gm" } : {}) };

  const [roll] = await actor.rollSavingThrow(config, dialog ? {} : { configure : false }, messageConfig) ?? [];
  if(!roll) return null;
  const success = Number.isFinite(dc) ? (roll.total >= dc) : null;
  /* A private save the players can't read : the GM notes its success on the card (its row shows pass / fail) */
  const uuid = (thing?.document ?? ((thing?.documentName === "Token") ? thing : null) ?? token?.document)?.uuid;
  if(card && secret && game.user.isGM && (success !== null) && uuid) await card.setFlag(module.id, `saves.${uuid.replaceAll(".", "-")}`, { success });
  return { success, total : roll.total, roll };
}

/* A creature the user doesn't own (a player's on-hit button against a monster) : the active GM's client rolls its save */
async function saveByGM(thing, ability, dc, { from, bonus, cover, secret, card, flags }){
  const doc = tokenOf(thing)?.document ?? actorOf(thing);
  const result = await gm.run("rollSave", { uuid : doc?.uuid ?? null, ability, dc, from : from?.uuid ?? null, bonus, cover,
    secret : secret ?? null, card : card?.id ?? null, flags });
  if(!result) return null;
  return { success : result.success, total : result.total, roll : result.roll ? Roll.fromData(result.roll) : null };
}

/* The GM's side of saveByGM */
export async function rollSaveAsGM({ uuid, ability, dc = null, from = null, bonus = null, cover = 0, secret = null, card = null, flags = null } = {}){
  const doc = fromUuidSync(uuid ?? "", { strict : false });
  if(!doc) return null;
  const rolled = await rollSave(doc, ability, dc, { from : from ? fromUuidSync(from, { strict : false }) : null, bonus, cover,
    ...((secret === null) ? {} : { secret }), card : card ? game.messages.get(card) ?? null : null, flags });
  return rolled ? { success : rolled.success, total : rolled.total, roll : rolled.roll.toJSON() } : null;
}

/* ---------- An item's own effect ---------- */

/* The item an effect is from : the item it's on, else its origin */
function sourceItemOf(effect){
  const item = (effect?.parent?.documentName === "Item") ? effect.parent : (effect?.origin ? fromUuidSync(effect.origin, { strict : false }) : null);
  return (item?.documentName === "Item") ? item : null;
}

/**
 * The effects working on a creature now that came from an item : on the creature (with the item as origin) or switched
 * on on the item itself. Not disabled, suppressed or expired.
 * @param {Actor|Token|TokenDocument} thing
 * @param {string|string[]|Function} match   the item's identifier (or several), or a check (effect) => boolean
 * @returns {ActiveEffect[]}
 */
export function effectsFrom(thing, match){
  const actor = actorOf(thing);
  const ids = (typeof match === "function") ? null : [match].flat();
  return [...(actor?.appliedEffects ?? [])].filter(effect => {
    if(effect.disabled || effect.isSuppressed || effect.duration?.expired) return false;
    return ids ? ids.includes(idOf(sourceItemOf(effect))) : !!match(effect);
  });
}

/**
 * An item's own effect turned on for its creature (Rage, Innate Sorcery; a monster's "it becomes enraged"), its
 * duration counting from now. Its item on the creature itself : the item's transferred effect is switched on. Else (an
 * unlinked token's copy, an effect that isn't transferred, `copy`) : a copy goes on the creature, the item its origin.
 * Already on : left as it is (returned).
 * @param {Item} item
 * @param {object} [options]
 * @param {Actor|Token} [options.on]     the creature (default : the item's; give the token's for an unlinked token)
 * @param {string} [options.effect]      which of the item's effects (its id; default : the activity's first, else the
 *                                       transferred one, else the first)
 * @param {Activity} [options.activity]
 * @param {object} [options.fallback]    the effect's data when the item has none
 * @param {object} [options.data]        merged into it (duration, flags, showIcon...)
 * @param {boolean} [options.copy=false] always a copy on the creature
 * @returns {Promise<ActiveEffect|null>}
 */
export async function itemEffectOn(item, { on = null, effect : id = null, activity = null, fallback = null, data = {}, copy = false } = {}){
  const actor = actorOf(on ?? item?.actor);
  if(!item || !actor?.isOwner) return null;
  const working = effectsFrom(actor, e => sourceItemOf(e) && ((sourceItemOf(e) === item) || (idOf(sourceItemOf(e)) === idOf(item))));
  if(working.length) return working[0];
  const chosen = id ?? activity?.effects?.[0]?._id;
  const source = (chosen && item.effects.get(chosen)) ?? item.effects.find(e => e.transfer) ?? item.effects.contents?.[0] ?? null;
  if(!source && !fallback) return null;
  const start = { time : game.time.worldTime };
  if(game.combat?.started) Object.assign(start, { combat : game.combat.id, round : game.combat.round, turn : game.combat.turn ?? 0 });
  if(source?.transfer && !copy && (item.parent === actor)){
    await source.update(foundry.utils.mergeObject({ disabled : false, start }, data, { inplace : false }));
    return source;
  }
  const base = source?.toObject?.() ?? { name : item.name, img : item.img, ...fallback };
  delete base._id;
  const [made] = await actor.createEmbeddedDocuments("ActiveEffect", [foundry.utils.mergeObject(base,
    foundry.utils.mergeObject({ disabled : false, transfer : false, origin : item.uuid, start }, data, { inplace : false }), { inplace : false })]);
  return made ?? null;
}

/**
 * An effect on a creature, after its save when one is given (a success : none). With `until` : it lasts until the start
 * or end of `of`'s next turn (default : the item's owner, else the creature itself; the active GM removes it then; made
 * out of combat : it waits for that turn in a combat that begins, else ends after 30 seconds of game time), and the same
 * effect (name and origin) already there lasts from now instead of being added twice. The GM's client puts it on; on a
 * creature that isn't the user's own (gm.mine), after the GM's button on a card (asked). A maneuver's Goaded, a
 * smite's Seared, a weapon mastery's Sap, Dash's "until the end of this turn".
 * @param {Actor|Token|TokenDocument} thing
 * @param {object} data                the effect's data
 * @param {object} [options]
 * @param {string} [options.save]      the ability saved with
 * @param {number} [options.dc]
 * @param {Item} [options.from]        what it comes from (its origin, picture, the save's source)
 * @param {string} [options.until]     "turnStart" | "turnEnd"
 * @param {Actor|Token} [options.of]   whose turn
 * @param {boolean} [options.thisTurn=false]  "turnEnd" : the end of the turn going on now, not the next one
 * @param {boolean} [options.confirmed=false] at once, no GM button : a consequence of a change already allowed, or an
 *                                            automatic part of the creature's own action on itself (Vex)
 * @returns {Promise<{ applied : boolean, asked : boolean, save : object|null }>}
 */
export async function giveEffect(thing, data, { save = null, dc = null, from = null, until = null, of = null, thisTurn = false, confirmed = false } = {}){
  const actor = actorOf(thing);
  if(!actor) return { applied : false, asked : false, save : null };
  const effect = foundry.utils.mergeObject({ showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2, origin : from?.uuid ?? null, img : from?.img ?? null }, data, { inplace : false });
  if(until){
    const expires = gm.timedStamp(actorOf(of) ?? from?.actor ?? actor, until);
    /* "Until the end of this turn" (Action Surge, Dash) : not the next one */
    if(expires && thisTurn) expires.thisTurn = true;
    foundry.utils.setProperty(effect, `flags.${module.id}.expires`, expires);
  }
  const payload = { actor : actor.uuid, data : effect, item : from?.uuid ?? null };
  const name = tokenOf(thing)?.name ?? actor.name;
  /* The ask card names what it comes from : the item given, else the effect's origin */
  const source = from?.name ?? fromUuidSync(effect.origin ?? "", { strict : false })?.name ?? "";
  return saveThenGive(thing, { save, dc, from, confirmed, against : data?.statuses ?? [],
    /* Its own creature the user may change : here (no GM needed); else the GM's client */
    run : () => actor.isOwner ? giveEffectAsGM(payload, game.user) : gm.run("giveEffect", payload),
    ask : () => gm.ask("giveEffectAsk", payload, { actor : from?.actor ?? null,
      text : module.format("giveEffect.ask", { item : source, name, effect : effect.name }),
      label : module.format("giveEffect.button", { name, effect : effect.name }), conditions : [...(effect.statuses ?? [])] }) });
}

/**
 * The one way a rule changes a creature (giveEffect, giveCondition) : its save first, when one is given (a success :
 * nothing), then `run()` at once on the user's own creature (gm.mine) or when `confirmed` (a consequence of a change the
 * GM already allowed), else `ask()` : the GM's button on a card.
 * @returns {Promise<{ applied : boolean, asked : boolean, save : object|null }>}  save : rollSave's result
 */
export async function saveThenGive(thing, { save = null, dc = null, from = null, against = [], confirmed = false, run, ask }){
  const actor = actorOf(thing);
  if(!actor) return { applied : false, asked : false, save : null };
  let rolled = null;
  if(save && Number.isFinite(Number(dc))){
    rolled = await rollSave(thing, save, Number(dc), { from, flags : against?.length ? { against : [...against] } : null });
    if(!rolled || rolled.success) return { applied : false, asked : false, save : rolled };
  }
  if(!confirmed && !gm.mine(actor)){
    await ask();
    return { applied : false, asked : true, save : rolled };
  }
  return { applied : !!await run(), asked : false, save : rolled };
}

/* GM : giveEffect's effect put on (the ask card's button calls it with the GM as user) */
export async function giveEffectAsGM({ actor : uuid, data } = {}, user){
  const actor = fromUuidSync(uuid ?? "", { strict : false });
  if(!actor || !data || !(user?.isGM || gm.mine(actor, user))) return false;
  if(foundry.utils.hasProperty(data, `flags.${module.id}.expires`)) return !!await timedEffect(actor, data);
  await actor.createEmbeddedDocuments("ActiveEffect", [data]);
  return true;
}

/* A timed effect put on, one at a time per creature : two clicks at once (a player's and the GM's) find the first one
   instead of adding twice. The same effect (name and origin) already there lasts from now instead. */
function timedEffect(actor, data){
  const key = actor.uuid;
  const run = (timedQueue.get(key) ?? Promise.resolve()).then(async () => {
    const expires = foundry.utils.getProperty(data, `flags.${module.id}.expires`);
    const same = actor.effects.find(e => (e.name === data.name) && ((e.origin ?? null) === (data.origin ?? null)) && e.getFlag(module.id, "expires") !== undefined);
    if(same){
      await same.setFlag(module.id, "expires", expires);
      return same;
    }
    const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
    return created ?? null;
  });
  timedQueue.set(key, run.catch(() => {}));
  return run;
}
const timedQueue = new Map();

/**
 * The effects itemEffectOn turned on, off again : an item's own switched off, a copy removed.
 * @param {Actor|Token|TokenDocument} thing
 * @param {string|string[]|Function} match   as effectsFrom
 * @param {object} [options]
 * @param {object} [options.data]   also changed on an item's own effect as it's switched off (a flag taken off)
 * @returns {Promise<number>}  how many ended
 */
export async function itemEffectOff(thing, match, { data = {} } = {}){
  const effects = effectsFrom(thing, match).filter(e => e.isOwner);
  for(const effect of effects){
    if(effect.parent?.documentName === "Item") await effect.update({ disabled : true, ...data });
    else await effect.delete();
  }
  return effects.length;
}

/* The old form, for world macros : giveEffect with `until` (default "turnStart") */
export function addTimedEffect(thing, data, { of = null, until = "turnStart", thisTurn = false } = {}){
  return giveEffect(thing, data, { of, until, thisTurn });
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

/* ---------- Counted uses ---------- */

const counters = new Map();
let countersHooked = false;

/**
 * Uses counted on the creature, for a feature whose item has none of its own (Favored Enemy's free Hunter's Mark,
 * Paladin's Smite's free Divine Smite, a homebrew "twice a Long Rest" with no uses set). When `item(actor)` has limited
 * uses, those are the ones counted instead. The count comes back on the rest (`"long"` : a Long Rest, `"short"` : any).
 *
 *   const free = MacroHelper.countedUses("favoredEnemy", { max : actor => 2, item : actor => actor.items.getName("Favored Enemy") });
 *   if(free.left(actor)) await free.spend(actor);
 *
 * @param {string} id
 * @param {object} [options]
 * @param {(actor : Actor) => number} [options.max]    how many (default 1)
 * @param {(actor : Actor) => Item|null} [options.item] the item whose own uses count, when it has them
 * @param {"long"|"short"|null} [options.recover="long"]
 * @returns {{ left : Function, spend : Function, reset : Function }}  left(thing) -> number, spend(thing, n = 1), reset(thing)
 */
export function countedUses(id, { max = () => 1, item = null, recover = "long" } = {}){
  const key = `counted.${id}`;
  const own = actor => { const i = item?.(actor); return Number(i?.system?.uses?.max) ? i : null; };
  const counter = {
    left(thing){
      const actor = actorOf(thing);
      if(!actor) return 0;
      const i = own(actor);
      if(i) return Number(i.system.uses.value) || 0;
      return Math.max(0, (Number(max(actor)) || 0) - (Number(actor.getFlag(module.id, key)) || 0));
    },
    async spend(thing, n = 1){
      const actor = actorOf(thing);
      if(!actor?.isOwner) return;
      const i = own(actor);
      if(i) return i.update({ "system.uses.spent" : (Number(i.system.uses.spent) || 0) + n });
      return actor.setFlag(module.id, key, Math.max(0, (Number(actor.getFlag(module.id, key)) || 0) + n));
    },
    async reset(thing){
      const actor = actorOf(thing);
      if(actor?.isOwner && (actor.getFlag(module.id, key) !== undefined)) await actor.unsetFlag(module.id, key);
    },
  };
  counters.set(id, { counter, recover });
  if(!countersHooked){
    countersHooked = true;
    Hooks.on("dnd5e.restCompleted", async (actor, result) => {
      for(const { counter, recover } of counters.values()){
        if((recover === "short") || ((recover === "long") && result?.longRest)) await counter.reset(actor);
      }
    });
  }
  return counter;
}

/* ---------- Spell slots ---------- */

/**
 * The spell slots a creature has left at a level or higher, lowest first, Pact Magic's last (a spell, a smite or a mark
 * paid with a slot).
 * @param {Actor|Token} thing
 * @param {number} [minLevel=1]
 * @returns {{ key : string, level : number, value : number, pact? : boolean }[]}  key : "spell2", "pact"
 */
export function slotsLeft(thing, minLevel = 1){
  const spells = (thing?.actor ?? thing)?.system?.spells ?? {};
  const out = [];
  for(let l = Math.max(1, Number(minLevel) || 1); l <= 9; l++){
    const slot = spells[`spell${l}`];
    if((Number(slot?.value) > 0) && (Number(slot?.max) > 0)) out.push({ key : `spell${l}`, level : l, value : Number(slot.value) });
  }
  const pact = spells.pact;
  if((Number(pact?.value) > 0) && (Number(pact?.level) >= minLevel)) out.push({ key : "pact", level : Number(pact.level), value : Number(pact.value), pact : true });
  return out;
}

/**
 * Every spell slot level a creature has (its maximum above 0), lowest first, Pact Magic's last.
 * @param {Actor|Token} thing
 * @returns {{ key : string, level : number, value : number, max : number, pact? : boolean }[]}
 */
export function spellSlots(thing){
  const spells = (thing?.actor ?? thing)?.system?.spells ?? {};
  const out = [];
  for(let l = 1; l <= 9; l++){
    const slot = spells[`spell${l}`];
    if(Number(slot?.max) > 0) out.push({ key : `spell${l}`, level : l, value : Number(slot.value) || 0, max : Number(slot.max) });
  }
  const pact = spells.pact;
  if(Number(pact?.max) > 0) out.push({ key : "pact", level : Number(pact.level) || 0, value : Number(pact.value) || 0, max : Number(pact.max), pact : true });
  return out;
}

/**
 * Add spell slots to a level, or (negative) spend them : a slot made by a feature (Font of Magic) goes on top of that
 * level's count, past its maximum; dnd5e's Long Rest sets the level back to its maximum, so such a slot goes then.
 * Never below 0. The creature's owner (or the GM) only.
 * @param {Actor|Token} thing
 * @param {number|string} level   1-9, or "pact" (or a key : "spell3")
 * @param {number} [amount=1]
 * @returns {Promise<number|null>}  the level's slots now, null : no such level, or not yours
 */
export async function addSpellSlot(thing, level, amount = 1){
  const actor = actorOf(thing);
  const key = (level === "pact") || String(level).startsWith("spell") ? String(level) : `spell${Number(level)}`;
  const slot = actor?.system?.spells?.[key];
  if(!slot || !actor.isOwner || !(Number(slot.max) > 0)) return null;
  const value = Math.max(0, (Number(slot.value) || 0) + (Number(amount) || 0));
  await actor.update({ [`system.spells.${key}.value`] : value });
  return value;
}

/**
 * Pay an amount of gold from the creature's coins : gold first, then the smaller coins, then the larger ones (change
 * given back in the smaller coins).
 * @param {Actor|Token|TokenDocument} thing
 * @param {number} gp   the cost, in gold pieces
 * @returns {Promise<boolean>}  paid (false : not enough, nothing taken)
 */
export async function payCoins(thing, gp){
  const actor = actorOf(thing);
  const currency = actor?.system?.currency;
  if(!currency || !actor.isOwner) return false;
  /* Copper pieces per coin (dnd5e's conversion : coins per gold piece) */
  const coins = Object.entries(CONFIG.DND5E.currencies ?? {}).map(([key, c]) => ({ key, cp : Math.round(100 / (Number(c.conversion) || 1)) }))
    .filter(c => c.cp > 0);
  const gold = coins.find(c => c.key === "gp");
  const order = [gold, ...coins.filter(c => (c !== gold) && (c.cp < 100)).sort((a, b) => b.cp - a.cp), ...coins.filter(c => c.cp > 100).sort((a, b) => a.cp - b.cp)].filter(Boolean);
  let owed = Math.round(Number(gp) * 100);
  const wealth = order.reduce((n, c) => n + ((Number(currency[c.key]) || 0) * c.cp), 0);
  if(!(owed > 0)) return true;
  if(wealth < owed) return false;
  const next = Object.fromEntries(order.map(c => [c.key, Number(currency[c.key]) || 0]));
  for(const c of order){
    const n = Math.min(next[c.key], Math.floor(owed / c.cp));
    next[c.key] -= n;
    owed -= n * c.cp;
  }
  /* Still owed : one larger coin broken, the change in the largest coins that fit */
  if(owed > 0){
    const coin = order.filter(c => (next[c.key] > 0) && (c.cp >= owed)).sort((a, b) => a.cp - b.cp)[0];
    next[coin.key]--;
    let change = coin.cp - owed;
    for(const c of [...order].sort((a, b) => b.cp - a.cp).filter(c => c.cp < coin.cp)){
      const n = Math.floor(change / c.cp);
      next[c.key] += n;
      change -= n * c.cp;
    }
  }
  await actor.update(Object.fromEntries(Object.entries(next).map(([k, v]) => [`system.currency.${k}`, v])));
  return true;
}

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

/**
 * One of an actor's items by its exact dnd5e identifier, nothing else (findItem also matches names).
 * @param {Actor|Token|TokenDocument} thing
 * @param {string|string[]} ids   one identifier or several (the first item that has any of them)
 * @param {object} [options]
 * @param {string} [options.type] only items of this type
 * @returns {Item|null}
 */
export function itemOf(thing, ids, { type } = {}){
  const actor = actorOf(thing), list = [ids].flat();
  return actor?.items?.find?.(i => (!type || (i.type === type)) && list.includes(idOf(i))) ?? null;
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
 * regains HP). Help's Stabilize, a Healer's Kit... A creature that isn't the user's own (gm.mine) : a card with the
 * GM's Stabilize button instead.
 * @param {Actor|Token|TokenDocument} thing
 * @param {object} [options]
 * @param {boolean} [options.confirmed=false]  the GM's button : do it now
 * @returns {Promise<boolean>}  true if it's now stable (or the GM was asked)
 */
export async function stabilize(thing, { confirmed = false } = {}){
  const actor = actorOf(thing);
  if(!actor || (Number(actor.system?.attributes?.hp?.value) > 0)) return false;
  /* Not the user's own creature : the GM's button (confirmed : that button, doing it) */
  if(!confirmed && !gm.mine(actor)) return !!(await gm.ask("stabilize", { actor : actor.uuid },
    { text : module.format("actions.stabilize.ask", { name : actor.name }), label : module.format("actions.stabilize.askButton", { name : actor.name }) }));
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
 * Split a token into copies of itself, sharing its HP (Ochre Jelly / Black Pudding Split). GM only.
 * The token itself is the first copy (anything aimed at it : targets, a card's buttons, its place in combat, stays);
 * the others are new tokens. Each copy is a new creature : its HP and max HP are its share (so not Bloodied). The new
 * ones keep its effects and conditions, except what belongs to one creature only : effects tied to someone's
 * Concentration (Hunter's Mark, Hex, Bane : flags.dnd5e.dependentOn) or linked to another effect (a grapple :
 * flags.macro-helper.linked) stay with the original. Each takes a space of its own : inside the original's space
 * first, then the nearest free squares around it (no other creature, no wall in between). In a combat, the new ones
 * join it at the original's initiative.
 * @param {Token|TokenDocument|Actor} thing
 * @param {object} [options]
 * @param {number} [options.copies=2]
 * @param {number} [options.hp=0.5]          fraction of current HP each copy gets (rounded down), also its max HP
 * @param {boolean} [options.stepSize=true]  one dnd5e size category smaller, the token sized from dnd5e's table
 *                                           (Small 1 square, Tiny half a square)
 * @param {number} [options.scale]           a token width / height multiplier instead of dnd5e's size table
 * @param {boolean} [options.chat=true]      tell the GM what happened (a whisper : it gives the HP)
 * @returns {Promise<TokenDocument[]>}       every copy, the original first
 */
export async function splitToken(thing, { copies = 2, hp = 0.5, stepSize : step = true, scale = null, chat = true } = {}){
  const source = tokenOf(thing);
  if(!source) return warned("Split : no token to split.");
  if(!game.user.isGM) return warned("Split : only the GM can create and delete tokens.");

  const doc = source.document;
  if(doc.actorLink) return warned(`Split : ${doc.name} is linked to its actor, the copies would share one HP pool. Unlink it first.`);

  const value = Math.floor((source.actor.system.attributes?.hp?.value ?? 0) * hp);
  if(value < 1) return warned(`Split : ${doc.name} doesn't have enough HP to split.`);

  const size = source.actor.system.traits?.size;
  const newSize = (step && size) ? stepSize(size, -1) : size;
  const tokenSize = (scale !== null) ? null : (CONFIG.DND5E.actorSizes?.[newSize]?.token ?? 1);
  const width = tokenSize ?? doc.width * scale, height = tokenSize ?? doc.height * scale;

  const positions = splitSpaces(source, copies, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  if(positions.length < copies) return warned(`Split : no room around ${doc.name} for ${copies} creatures.`);

  /* What the new ones don't get : one creature's effects (Concentration, linked), and Bloodied (dnd5e judges it again) */
  const single = e => e.flags?.dnd5e?.dependentOn || e.flags?.[module.id]?.linked || (e.statuses ?? []).includes("bloodied");
  const data = doc.toObject();
  delete data._id;
  if(Array.isArray(data.delta?.effects)) data.delta.effects = data.delta.effects.filter(e => !single(e));
  const share = token => {
    foundry.utils.setProperty(token, "delta.system.attributes.hp.value", value);
    foundry.utils.setProperty(token, "delta.system.attributes.hp.max", value);
    foundry.utils.setProperty(token, "delta.system.attributes.hp.temp", 0);
    if(newSize) foundry.utils.setProperty(token, "delta.system.traits.size", newSize);
    return token;
  };
  const tokens = positions.slice(1).map(pos => share(Object.assign(foundry.utils.deepClone(data), pos, { width, height })));

  /* The original : its share, its new size, the first space */
  await doc.actor.update(share({}).delta);
  await doc.update({ ...positions[0], width, height }, { animate : false });

  /* dnd5e would re-roll unlinked NPC HP on creation otherwise */
  const created = await doc.parent.createEmbeddedDocuments("Token", tokens, { dnd5e : { autoRollNPCHP : "no" } });

  /* Its place in combat : every combat it's in, the new ones at its initiative */
  for(const combat of game.combats){
    const combatant = combat.combatants.find(m => (m.tokenId === doc.id) && (m.sceneId === doc.parent.id));
    if(!combatant) continue;
    await combat.createEmbeddedDocuments("Combatant", created.map(t => ({
      tokenId : t.id, sceneId : t.parent.id, actorId : t.actorId,
      initiative : combatant.initiative, hidden : combatant.hidden,
    })));
  }

  if(chat){
    const label = game.i18n.localize(CONFIG.DND5E.actorSizes?.[newSize]?.label ?? "");
    ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor : source.actor, token : doc }),
      whisper : game.users.filter(u => u.isGM).map(u => u.id),
      content : `<p><strong>${doc.name}</strong> splits into ${copies}${(newSize !== size) && label ? ` ${label}` : ""} creatures with <strong>${value} HP</strong> each.</p>`,
    });
  }
  return [doc, ...created];
}

/* Top-left corners (canvas pixels) for `count` blocks of w × h squares : inside the token's space first, then rings
   around it, each free of other creatures, inside the scene, not behind a wall from the token's centre */
function splitSpaces(token, count, w, h){
  const grid = canvas.grid.size;
  const doc = token.document;
  const left = Math.round(doc.x / grid), top = Math.round(doc.y / grid);
  const W = Math.max(1, Math.round(doc.width)), H = Math.max(1, Math.round(doc.height));
  const rect = canvas.dimensions?.sceneRect;
  const centre = token.center;
  const wall = CONFIG.Canvas.polygonBackends?.move;
  const chosen = [];
  const overlaps = (gx, gy) => chosen.some(c => (c.gx < gx + w) && (c.gx + w > gx) && (c.gy < gy + h) && (c.gy + h > gy));
  for(let ring = 0; (ring <= 4) && (chosen.length < count); ring++){
    const spots = [];
    for(let gx = left - ring; gx <= left + W - w + ring; gx++) for(let gy = top - ring; gy <= top + H - h + ring; gy++){
      const inside = (gx >= left) && (gy >= top) && (gx + w <= left + W) && (gy + h <= top + H);
      const depth = Math.max(left - gx, top - gy, gx + w - (left + W), gy + h - (top + H), 0);
      if((ring === 0) ? inside : (depth === ring)) spots.push({ gx, gy });
    }
    for(const { gx, gy } of spots){
      if(chosen.length >= count) break;
      const x = gx * grid, y = gy * grid;
      if(rect && ((x < rect.x) || (y < rect.y) || (x + w * grid > rect.x + rect.width) || (y + h * grid > rect.y + rect.height))) continue;
      if(overlaps(gx, gy) || !isSpaceFree(x, y, w, { height : h, ignore : token })) continue;
      const point = { x : x + w * grid / 2, y : y + h * grid / 2 };
      if(wall && (ring > 0) && wall.testCollision(centre, point, { type : "move", mode : "any" })) continue;
      chosen.push({ gx, gy });
    }
  }
  return chosen.map(({ gx, gy }) => ({ x : gx * grid, y : gy * grid }));
}
