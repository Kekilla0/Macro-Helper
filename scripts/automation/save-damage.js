import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
import { gm } from '../gm.js';
import { limits } from './limits.js';
import { actionTracker } from './action-tracker.js';
import { isIncapacitated } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * The save damage lego : a creature that takes less damage from a save than the card says (Evasion; Shield Master's
 * Interpose Shield; a monster's "if it succeeds on a DEX save for half, it takes no damage"; a homebrew "a failed
 * save against fire still takes only half").
 *
 *   saveDamage(match, {
 *     abilities : ["dex"],              the saves it's for (default : DEX)
 *     onlyHalf : true,                  only a save whose success takes half (default)
 *     success : 0,                      the damage taken on a success (a multiplier : 0 none, 0.5 half); null : as the card
 *     fail : 0.5,                       ... on a failure; null : as the card (default)
 *     reaction : false,                 true : not by itself, a button on the creature's row after the save (its
 *                                       owner's) spends its Reaction (Action Tracker) and does it
 *     unmet : actor => "",              another requirement (holding a shield) : why not, "" when met (Rule Limits)
 *     when : (actor, card) => true,     this card qualifies
 *     label, icon, enabled, id
 *   })
 *
 *   match  an item identifier the creature has (or several), or (actor) => the item that gives it
 * The same id (default : the match) replaces a rule. The rows and their Apply follow at once.
 */
const rules = new Map();
let hooked = false;

const uuidKey = uuid => String(uuid).replaceAll(".", "-");
const keyOf = (match, id) => id ?? [match].flat().map(String).join(",");

export function saveDamage(match, rule = {}){
  rules.set(keyOf(match, rule.id), { abilities : ["dex"], onlyHalf : true, success : 0, fail : null, ...rule, match, key : keyOf(match, rule.id) });
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.rowResults`, (card, results) => rowResults(card, results));
  Hooks.on(`${module.id}.rowButtons`, (card, uuid, buttons, context = {}) => rowButtons(card, uuid, buttons, context));
  Hooks.on(`${module.id}.rowButton`, (card, uuid, id) => { if(String(id).startsWith("saveDamage|")) clicked(card, uuid, String(id).slice(11)); });
  gm.handle("saveDamageUsed", (data, user) => usedAsGM(data, user));
}

function sourceOf(actor, match){
  if(!actor) return null;
  if(typeof match === "function"){
    try { return match(actor) || null; } catch(error){ log.error("Save damage match", error); return null; }
  }
  const ids = [match].flat();
  return actor.items?.find?.(i => ids.includes(idOf(i))) ?? null;
}

/* The card's save : its abilities and what a success takes */
function saveOf(card){
  const abilities = card?.system?.saveAbilities ?? [];
  const onSave = card?.system?.rider?.onSave ?? card?.getAssociatedActivity?.()?.damage?.onSave ?? null;
  return { abilities, onSave };
}

/* Does this rule hold for that creature on this card : its source item, or null */
function holds(rule, card, actor){
  if((rule.enabled && !rule.enabled()) || !actor) return null;
  const { abilities, onSave } = saveOf(card);
  if(!abilities.some(a => rule.abilities.includes(a))) return null;
  if(rule.onlyHalf && (onSave !== "half")) return null;
  const source = sourceOf(actor, rule.match);
  if(!source) return null;
  try { if(rule.when && !rule.when(actor, card)) return null; }
  catch(error){ log.error("Save damage", error); return null; }
  return source;
}

const flagOf = (rule, uuid) => `saveDamage.${uuidKey(rule.key)}.${uuidKey(uuid)}`;
const actorAt = uuid => fromUuidSync(uuid, { strict : false })?.actor ?? null;

function rowResults(card, results){
  for(const [uuid, result] of results){
    if(!result || result.rolling || (typeof result.success !== "boolean")) continue;
    const actor = actorAt(uuid);
    for(const rule of rules.values()){
      if(!holds(rule, card, actor)) continue;
      if(rule.reaction && !card.getFlag?.(module.id, flagOf(rule, uuid))) continue;
      const multiplier = result.success ? rule.success : rule.fail;
      if(!Number.isFinite(multiplier)) continue;
      results.set(uuid, { ...result, multiplier, noDamage : multiplier === 0 });
      break;
    }
  }
}

const labelOf = (rule, source) => rule.label?.(source) ?? source?.name ?? rule.key;

function rowButtons(card, uuid, buttons, { result } = {}){
  if(typeof result?.success !== "boolean") return;
  const actor = actorAt(uuid);
  if(!actor?.isOwner) return;
  for(const rule of rules.values()){
    if(!rule.reaction) continue;
    const source = holds(rule, card, actor);
    if(!source) continue;
    const multiplier = result.success ? rule.success : rule.fail;
    if(!Number.isFinite(multiplier)) continue;
    const done = !!card.getFlag(module.id, flagOf(rule, uuid));
    if(!done && (unmetOf(rule, actor) && !["off", "warn"].includes(limits.mode()))) continue;
    buttons.push({ id : `saveDamage|${rule.key}`, label : labelOf(rule, source), icon : rule.icon ?? "fa-shield", disabled : done,
      tooltip : module.format("saveDamage.tooltip", { name : actor.name, item : source.name }) });
  }
}

/* Why it can't now, "" when it can (a Reaction : not out of action, one left) */
function unmetOf(rule, actor){
  if(rule.reaction){
    if(isIncapacitated(actor)) return module.format("fightingStyles.cantReact", { name : actor.name });
    if(!actionTracker.left(actor, "reaction")) return module.format("actionTracker.spent", { name : actor.name, kind : actionTracker.label("reaction") });
  }
  return rule.unmet?.(actor) ?? "";
}

async function clicked(card, uuid, key){
  const rule = rules.get(key);
  const actor = actorAt(uuid);
  const source = rule && actor?.isOwner && holds(rule, card, actor);
  if(!source || card.getFlag(module.id, flagOf(rule, uuid))) return;
  const problem = unmetOf(rule, actor);
  if(problem && !limits.allow(problem, { who : actor.name, what : labelOf(rule, source) })) return;
  if(!await gm.run("saveDamageUsed", { card : card.id, key, uuid })) return;
  if(rule.reaction) await actionTracker.spend(actor, { kind : "reaction", what : labelOf(rule, source) }).catch(() => null);
  log.debug("Save damage", key, actor.name);
}

/* GM : the card remembers it (the creature's owner asked) */
async function usedAsGM({ card : id, key, uuid } = {}, user){
  const card = game.messages.get(id);
  const rule = rules.get(key);
  const actor = actorAt(uuid ?? "");
  if(!card || !rule || !actor?.testUserPermission?.(user, "OWNER")) return false;
  await card.setFlag(module.id, flagOf(rule, uuid), true);
  return true;
}
