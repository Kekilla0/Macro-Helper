import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf, chooseOption } from '../helpers/utils.js';
import { usedThisTurn, markUsedThisTurn, giveEffect } from '../helpers/actors.js';
import { damageRoll } from './extra-damage.js';
import { gm } from '../gm.js';
import { uses } from '../uses.js';
import { limits } from '../automation/limits.js';
import { TYPES } from './message.js';
import { cardSave } from './card-save.js';
import { casting, castingOptions } from '../automation/casting.js';
import { actionTracker } from '../automation/action-tracker.js';
const log = logger.for(import.meta.url);

/**
 * The cast-on-hit lego : spells cast right after a weapon hit, onto that hit's card (the smites : Divine Smite,
 * Wrathful, Thunderous; Ensnaring Strike, Hail of Thorns; a homebrew "after you hit, you can cast X"). Its owner's
 * button on the attack card offers every spell that fits the hit, each with what can pay for it (a free casting, then
 * each spell slot of its level or higher). The spell's damage goes on the card as its own box (crits like the attack);
 * its save on the card (or around the target); Concentration starts for one that needs it. Once per attack; a second
 * in a turn follows Rule Limits; it costs the economy given (a Bonus Action) on the caster's own turn. From the sheet,
 * the spell (or a feature that casts one) works on the latest qualifying hit.
 *
 *   castOnHit({
 *     id : "smite",
 *     spells : actor => [...],                          the spells it can cast now (prepared ones)
 *     fits : (spell, kind) => kind === "melee",         does it follow that hit : kind "melee" or "ranged"
 *     damage : (spell, level, target) => ({ formula, type }) | null,   default : the spell's first damage part, scaled
 *     save : spell => true | { around : 5 } | null,     its save on the card (around : everyone within that many feet
 *                                                       of the target)
 *     effect : spell => true | null,                    the spell's effect goes on the creature hit (giveEffect : the
 *                                                       GM's button when it isn't the caster's own), at the slot level
 *                                                       cast (Searing Smite's Seared, Shining Smite's Shining)
 *     free : (actor, spell) => ({ left, spend, label }) | null,   a free casting (castingOptions)
 *     slotLabel : (slot, spell) => "…",
 *     sheet : item => ({ only : spellIdentifier, freeOnly }) | null,  an item used from the sheet that works on the
 *                                                       latest hit (the spells themselves, or a feature)
 *     economy : "bonus",                                its cost (default : a Bonus Action; null : none)
 *     label : choices => "Smite", icon : choices => "fa-sun", title, prompt (strings, or actor => string),
 *     noChoice : actor => "…", noHit,
 *     after : (actor, spell, message, choice) => {},    once cast
 *     enabled(),
 *   })
 * The card keeps flags["macro-helper"]["castOnHit"][id][ray] = the spell's id; its face (name and rules) shows under the
 * weapon's. Hooks "macro-helper.castOnHit" (actor, spell, message, id) once cast.
 */
const rules = new Map();
let hooked = false;

export function castOnHit(rule){
  if(!rule?.id || !rule.spells) return;
  rules.set(rule.id, rule);
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => cardButtons(message, buttons, context));
  Hooks.on(`${module.id}.cardButton`, (message, id, context) => {
    if(String(id).startsWith("castOnHit|")) cast(String(id).slice(10), message, context?.ray ?? null);
  });
  /* The spell on the card : its face (name and rules) under the weapon's, like the spell's own card */
  Hooks.on(`${module.id}.cardFaces`, (message, faces) => cardFaces(message, faces));
  gm.handle("castOnHitCard", (data, user) => writeCardAsGM(data, user));
  /* Used from the sheet : the latest hit it fits */
  uses.onItem("smite", (item, ctx, next) => {
    for(const rule of rules.values()){
      const sheet = on(rule) ? rule.sheet?.(item) : null;
      if(sheet) return fromSheet(rule, item, sheet);
    }
    return next();
  });
}

const on = rule => !rule.enabled || rule.enabled();
const rayKey = ray => Number.isInteger(ray) ? String(ray) : "single";
const flagOf = (rule, ray) => `castOnHit.${rule.id}.${rayKey(ray)}`;

/* A weapon hit on the card : "melee" or "ranged" (a thrown weapon : ranged), null when it isn't one */
export function hitKind(message, ray){
  const card = message?.system;
  if((message?.type !== TYPES.attack) || !card?.isHitOn?.(ray)) return null;
  const activity = message.getAssociatedActivity?.();
  if((activity?.type !== "attack") || (activity.item?.type !== "weapon")) return null;
  const type = String(activity.getActionType?.(card.attackOf(ray)?.options?.attackMode) ?? "");
  return type.startsWith("m") ? "melee" : type.startsWith("r") ? "ranged" : null;
}

const fits = (rule, spell, kind) => !!kind && (rule.fits ? !!rule.fits(spell, kind) : (kind === "melee"));

export function castOnHitDone(message, id, ray){
  return !!message?.getFlag?.(module.id, `castOnHit.${id}.${rayKey(ray)}`);
}

/* Every way to cast now : [{ value, label, spell, level, slot | free, pay() }] (for a kind of hit : the spells that fit) */
function choicesFor(rule, actor, { only = null, freeOnly = false, kind = null } = {}){
  const out = [];
  for(const spell of rule.spells(actor) ?? []){
    if(only && (idOf(spell) !== only)) continue;
    if(kind && !fits(rule, spell, kind)) continue;
    const free = rule.free?.(actor, spell) ?? null;
    const labels = rule.slotLabel ? { slot : slot => rule.slotLabel(slot, spell) } : undefined;
    for(const option of castingOptions(actor, spell, { free, labels })){
      if(!freeOnly || option.free) out.push(option);
    }
  }
  return out;
}

/* In a started combat, someone else's turn */
function offTurn(actor){
  const combat = game.combat;
  if(!combat?.started || !combat.combatant) return false;
  const current = combat.combatant.actor;
  return !!current && (current !== actor) && (current.uuid !== actor?.uuid);
}

function cardButtons(message, buttons, { ray } = {}){
  const actor = message.getAssociatedActor?.();
  /* The card's roller, or the character's owner (the GM rolled for them : the card's part goes through the GM) */
  if(!message.isOwner && !(actor?.isOwner && !game.user.isGM)) return;
  const kind = hitKind(message, ray);
  if(!actor?.isOwner || !kind) return;
  for(const rule of rules.values()){
    if(!on(rule) || castOnHitDone(message, rule.id, ray)) continue;
    const choices = choicesFor(rule, actor, { kind });
    if(!choices.length) continue;
    /* A Bonus Action : only on its own turn (not an Opportunity Attack or a readied attack), one left */
    const economy = rule.economy === undefined ? "bonus" : rule.economy;
    if(economy && (offTurn(actor) || !actionTracker.left(actor, economy))) continue;
    buttons.push({ id : `castOnHit|${rule.id}`, label : rule.label?.(choices) ?? module.i18n("castOnHit.cast"), icon : rule.icon?.(choices) ?? "fa-wand-sparkles" });
  }
}

/* The creature the attack hit */
function targetOf(message, ray){
  return message.system.hitTargets?.(ray)?.[0] ?? null;
}

/**
 * A spell's extra damage at a slot level : its first damage part (a damage activity's, else any), scaled.
 * @returns {{ formula : string, type : string }|null}
 */
export function spellDamage(spell, level){
  const extra = Math.max(0, level - (Number(spell.system.level) || 1));
  const activities = spell.system.activities?.contents ?? [];
  const withDamage = a => a.damage?.parts?.some?.(p => p.number && p.denomination);
  const activity = activities.find(a => (a.type === "damage") && withDamage(a)) ?? activities.find(withDamage);
  const part = activity?.damage.parts.find(p => p.number && p.denomination);
  if(!part) return null;
  const number = part.number + (extra * (Number(part.scaling?.number) || 1));
  return { formula : `${number}d${part.denomination}`, type : [...(part.types ?? [])][0] ?? "" };
}

/**
 * Cast onto this card's hit : choose what to cast and how to pay, then its damage and save on the card.
 * @param {string} id   the rule
 * @param {ChatMessage} message
 * @param {number|null} ray
 * @param {object} [options]
 * @param {string} [options.only]       one spell (identifier; from the sheet)
 * @param {boolean} [options.freeOnly]  its free casting only (a feature from the sheet)
 * @returns {Promise<boolean>}
 */
export async function cast(id, message, ray, { only = null, freeOnly = false } = {}){
  const rule = rules.get(id);
  const actor = message.getAssociatedActor?.();
  const kind = hitKind(message, ray);
  if(!rule || !on(rule) || !actor?.isOwner || !kind || castOnHitDone(message, id, ray)) return false;
  const choices = choicesFor(rule, actor, { only, freeOnly, kind });
  if(!choices.length){
    ui.notifications.warn(rule.noChoice?.(actor) ?? module.format("castOnHit.none", { name : actor.name }));
    return false;
  }
  const words = v => (typeof v === "function") ? v(actor) : v;
  const value = await chooseOption({ title : words(rule.title) ?? module.i18n("castOnHit.cast"), icon : `fa-solid ${rule.icon?.(choices) ?? "fa-wand-sparkles"}`,
    prompt : words(rule.prompt) ?? module.i18n("castOnHit.prompt"), options : choices.map(c => ({ value : c.value, label : c.label })) });
  const choice = choices.find(c => c.value === value);
  if(!choice) return false;
  /* Its components, and one slot a turn (Casting) */
  if(!casting.allowsCast(choice.spell, { slot : !choice.free })) return false;
  const economy = rule.economy === undefined ? "bonus" : rule.economy;
  /* Its economy : one a turn */
  if(usedThisTurn(actor, `castOnHit.${id}`) && !limits.allow(module.format("castOnHit.used", { name : actor.name }), { who : actor.name, what : choice.spell.name })) return false;
  if(economy && !actionTracker.left(actor, economy) && !limits.allow(module.format("actionTracker.spent", { name : actor.name, kind : actionTracker.label(economy) }), { who : actor.name, what : choice.spell.name })) return false;

  const target = targetOf(message, ray);
  const damage = rule.damage ? rule.damage(choice.spell, choice.level, target) : spellDamage(choice.spell, choice.level);
  const roll = damage?.formula ? await damageRoll(damage.formula, { type : damage.type, crit : !!message.system.attackOf(ray)?.isCritical, magical : true }) : null;
  /* The card's part : here when it's this user's card, else the GM's client (the GM rolled the attack for them) */
  const card = { id, message : message.id, ray, spell : choice.spell.id, level : choice.level, formula : damage?.formula ?? null, roll : roll ? roll.toJSON() : null };
  if(message.isOwner) await writeCard(card);
  else if(!await gm.run("castOnHitCard", card)) return false;
  await choice.pay();
  await markUsedThisTurn(actor, `castOnHit.${id}`);
  if(economy) await actionTracker.spend(actor, { kind : economy, what : choice.spell.name }).catch(error => log.debug(error));
  /* Concentration (Wrathful, Searing...) : on the spell, as if cast */
  if(choice.spell.system.properties?.has?.("concentration")){
    const activity = choice.spell.system.activities?.contents?.[0];
    if(activity) await actor.beginConcentrating(activity).catch(error => log.error(error));
  }
  if(target && rule.effect?.(choice.spell)) await hitEffect(choice.spell, choice.level, target).catch(error => log.error(error));
  log.debug("Cast on hit", actor.name, choice.spell.name, choice.level, damage?.formula);
  await rule.after?.(actor, choice.spell, message, choice);
  Hooks.callAll(`${module.id}.castOnHit`, actor, choice.spell, message, id);
  return true;
}

/* The spell's effect on the creature hit : its damage activity's (else any activity's, else the item's first), with
   the slot level cast (repeating effects scale their dice by it) */
async function hitEffect(spell, level, target){
  const activities = spell.system.activities?.contents ?? [];
  const id = activities.find(a => (a.type === "damage") && a.effects?.length)?.effects[0]?._id ?? activities.find(a => a.effects?.length)?.effects[0]?._id;
  const source = (id && spell.effects.get(id)) ?? spell.effects.find(e => !e.transfer) ?? null;
  if(!source) return null;
  const data = source.toObject();
  delete data._id;
  data.transfer = false;
  data.origin = spell.uuid;
  foundry.utils.setProperty(data, "flags.dnd5e.spellLevel", level);
  return giveEffect(target, data, { from : spell });
}

/* The spell on the card : its damage, the done mark, its save (Wrathful...) or its burst (Hail of Thorns) */
async function writeCard({ id, message : messageId, ray = null, spell : spellId, level, formula = null, roll = null } = {}){
  const rule = rules.get(id);
  const message = game.messages.get(messageId);
  const actor = message?.getAssociatedActor?.();
  const spell = actor?.items?.get(spellId);
  if(!rule || !message || !spell) return false;
  if(roll){
    const damage = CONFIG.Dice.DamageRoll.fromData(roll);
    await message.system.addDamage([damage], { key : `castOnHit-${id}`, ray, formula,
      label : module.format("castOnHit.damageLabel", { spell : spell.name, level }) });
  }
  await message.setFlag(module.id, flagOf(rule, ray), spell.id);
  const save = rule.save?.(spell);
  const target = targetOf(message, ray);
  if(save?.around){ if(target) await cardSave(message, spell, { around : { target, feet : save.around }, level }); }
  else if(save) await cardSave(message, spell);
  return true;
}

/* GM : a player's spell on a card the GM rolled for their character */
async function writeCardAsGM(data = {}, user){
  const message = game.messages.get(data.message);
  const actor = message?.getAssociatedActor?.();
  if(!actor || !(user.isGM || actor.testUserPermission(user, "OWNER")) || castOnHitDone(message, data.id, data.ray ?? null)) return false;
  return writeCard(data);
}

function cardFaces(message, faces){
  const done = message?.getFlag?.(module.id, "castOnHit") ?? {};
  const ids = Object.values(done).flatMap(byRay => Object.values(byRay ?? {}));
  const actor = ids.length ? message.getAssociatedActor?.() : null;
  for(const id of new Set(ids)){
    const spell = actor?.items?.get(id);
    if(spell && !faces.some(f => f.uuid === spell.uuid)) faces.push({ uuid : spell.uuid });
  }
}

/* From the sheet : the latest attack card of this actor (among the last messages) with a hit it fits, not yet cast on */
function latestHit(rule, actor, only){
  const recent = game.messages.contents.slice(-15).reverse();
  for(const message of recent){
    if((message.type !== TYPES.attack) || (message.getAssociatedActor?.()?.id !== actor.id)) continue;
    const rays = message.system.isMulti ? message.system.rays.map((_, i) => i) : [null];
    const spells = (rule.spells(actor) ?? []).filter(s => !only || (idOf(s) === only));
    const ray = rays.find(r => { const kind = hitKind(message, r); return spells.some(s => fits(rule, s, kind)) && !castOnHitDone(message, rule.id, r); });
    if(ray !== undefined) return { message, ray };
    return null;
  }
  return null;
}

async function fromSheet(rule, item, { only = null, freeOnly = false } = {}){
  const actor = item.actor;
  const hit = actor && latestHit(rule, actor, only);
  if(!hit){
    ui.notifications.warn(rule.noHit?.(actor, item) ?? module.format("castOnHit.noHit", { name : actor?.name ?? "", item : item.name }));
    return null;
  }
  const done = await cast(rule.id, hit.message, hit.ray, { only, freeOnly });
  return done ? hit.message : null;
}
