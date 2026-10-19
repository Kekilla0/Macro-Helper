import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
import { tokenOf, distanceBetween } from '../helpers/tokens.js';
import { usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
import { spendUses } from '../helpers/items.js';
import { TYPES } from './message.js';
const log = logger.for(import.meta.url);

/**
 * The on-hit bonus lego : a rule that adds damage after a hit (Divine Fury, Hand of Harm, Colossus Slayer, a Battle
 * Master's maneuver) says it once, as sentences; its owner gets a button on the attack card once the attack hits.
 * The damage goes on the card as its own box (doubled on a crit), once per attack.
 *
 *   onHit({
 *     id : "divine-fury", feature : "divine-fury",          the button's key; the item (identifier) it needs
 *     when : hit => hit.weapon || hit.unarmed,               does this hit qualify
 *     formula : hit => "1d6 + 1",                            the damage
 *     types : hit => ["necrotic", "radiant"],                its type (several : a button each); the weapon's if left out
 *     once : "turn",                                         "turn" (once a turn), "target" (each creature once a turn)
 *     ownTurn : true,                                        only on the attacker's own turn
 *     cost : hit => ({ item, amount : 1 }),                  spent on the click (none left : no button); { activity } :
 *                                                            that activity's own uses (Dreadful Strike's)
 *     after : (hit, card) => {},                             once it's on the card (a save, a mark)
 *   })
 *
 * hit : { message, ray, actor, token, item, activity, roll, critical, target, targets, weapon, unarmed, spell, cantrip,
 *         melee, ranged, ability, damageType, feature }
 */
const rules = [];
let hooked = false;

/**
 * Add a rule.
 * @param {object} rule  see above; also enabled() (default : on), label (hit => string; default : the feature's name),
 *                       icon (a Font Awesome class)
 */
export function onHit(rule){
  if(!rule?.id || rules.some(r => r.id === rule.id)) return;
  rules.push(rule);
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => cardButtons(message, buttons, ray ?? null));
  Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => { if(String(id).startsWith("onHit|")) clicked(message, String(id), ray ?? null); });
}

/**
 * What a hit on a card is, read once : who made it, with what, at whom.
 * @param {ChatMessage} message
 * @param {number|null} ray
 * @returns {object|null}  null when that attack didn't hit
 */
export function hitOf(message, ray = null){
  const card = message?.system;
  if((message?.type !== TYPES.attack) || !card?.isHitOn?.(ray)) return null;
  const activity = message.getAssociatedActivity?.();
  const item = activity?.item ?? message.getAssociatedItem?.();
  const actor = message.getAssociatedActor?.() ?? activity?.actor;
  if(!actor || !item) return null;
  const roll = card.attackOf?.(ray) ?? null;
  let action = "";
  try { action = String(activity?.getActionType?.(roll?.options?.attackMode) ?? ""); } catch {}
  const targets = (card.hitTargets?.(ray) ?? []).map(t => tokenOf(t)).filter(Boolean);
  const base = (Number.isInteger(ray) ? card.rayDamage?.(ray) : card.damageRolls) ?? [];
  const classification = activity?.attack?.type?.classification;
  return {
    message, ray, actor, token : tokenOf(message.getAssociatedToken?.() ?? actor), item, activity, roll,
    critical : !!roll?.isCritical, target : targets[0] ?? null, targets,
    weapon : item.type === "weapon", unarmed : (idOf(item) === "unarmed-strike") || (classification === "unarmed"),
    spell : item.type === "spell", cantrip : (item.type === "spell") && (Number(item.system?.level) === 0),
    melee : action.startsWith("m"), ranged : action.startsWith("r"),
    ability : roll?.options?.ability ?? activity?.ability ?? null,
    damageType : base[0]?.options?.type ?? [...(item.system?.damage?.base?.types ?? [])][0] ?? null,
  };
}

/* Is it the attacker's own turn (out of combat : yes) */
function ownTurn(actor){
  const combat = game.combat;
  if(!combat?.started) return true;
  const current = combat.combatant?.actor;
  return !!current && ((current === actor) || (current.uuid === actor?.uuid));
}

/* The once-per-turn key for a rule (per target : that creature's token) */
function onceKey(rule, hit){
  return (rule.once === "target") ? `hit-${rule.id}-${hit.target?.document?.id ?? "x"}` : `hit-${rule.id}`;
}

function featureOf(rule, actor){
  if(typeof rule.feature === "function") return rule.feature(actor);
  return rule.feature ? (actor?.items?.find?.(i => idOf(i) === rule.feature) ?? null) : true;
}

/**
 * Does this rule offer its button for this hit now. "" when it does, else why not (for a click that came too late).
 */
function problem(rule, hit){
  if((rule.enabled && !rule.enabled()) || !hit) return "off";
  const feature = featureOf(rule, hit.actor);
  if(!feature) return "off";
  hit.feature = (feature === true) ? null : feature;
  if(rule.ownTurn && !ownTurn(hit.actor)) return "turn";
  if(rule.once && usedThisTurn(hit.actor, onceKey(rule, hit))) return "once";
  if(rule.within && hit.target && hit.token && (distanceBetween(hit.token, hit.target) > rule.within)) return "range";
  if(rule.when && !rule.when(hit)) return "off";
  const cost = rule.cost?.(hit);
  if(cost && !(Number((cost.activity ?? cost.item)?.uses?.value ?? cost.item?.system?.uses?.value) >= (cost.amount ?? 1))) return "cost";
  return "";
}

/* The cost paid : an item's uses, or an activity's own */
async function pay(cost){
  const amount = cost.amount ?? 1;
  if(!cost.activity) return !!await spendUses(cost.item, amount);
  const left = Number(cost.activity.uses?.value) || 0;
  if(left < amount){ ui.notifications.warn(module.format("hitBonus.noUses", { name : cost.activity.name || cost.activity.item?.name })); return false; }
  await cost.activity.update({ "uses.spent" : (Number(cost.activity.uses?.spent) || 0) + amount });
  return true;
}

function typesOf(rule, hit){
  const types = rule.types?.(hit) ?? [hit.damageType ?? "bludgeoning"];
  return (Array.isArray(types) ? types : [types]).filter(Boolean);
}

function labelOf(rule, hit){
  return rule.label?.(hit) ?? hit.feature?.name ?? rule.id;
}

function cardButtons(message, buttons, ray){
  if(!message.isOwner && !message.getAssociatedActor?.()?.isOwner) return;
  let hit = null;
  for(const rule of rules){
    hit ??= hitOf(message, ray);
    if(!hit) return;
    if(!hit.actor.isOwner || message.system.extraRolls?.(ray, rule.id)?.length) continue;
    if(problem(rule, hit)) continue;
    const types = typesOf(rule, hit);
    const label = labelOf(rule, hit);
    for(const type of types){
      const typeLabel = CONFIG.DND5E.damageTypes?.[type]?.label ?? type;
      buttons.push({ id : `onHit|${rule.id}|${type}`, icon : rule.icon ?? "fa-burst",
        label : (types.length > 1) ? `${label} (${typeLabel})` : label });
    }
  }
}

async function clicked(message, id, ray){
  const [, ruleId, type] = id.split("|");
  const rule = rules.find(r => r.id === ruleId);
  const hit = hitOf(message, ray);
  if(!rule || !hit?.actor?.isOwner || message.system.extraRolls?.(ray, rule.id)?.length) return;
  const why = problem(rule, hit);
  if(why) return ui.notifications.warn(module.format("hitBonus.notNow", { name : labelOf(rule, hit) }));
  const cost = rule.cost?.(hit);
  if(cost && !await pay(cost)) return;
  if(rule.once) await markUsedThisTurn(hit.actor, onceKey(rule, hit));
  const formula = String(rule.formula(hit));
  await message.system.extraDamage(formula, { key : rule.id, type : type || null, ray, label : labelOf(rule, hit),
    rollData : hit.actor.getRollData?.() ?? {}, magical : !!rule.magical });
  log.debug("On-hit bonus", rule.id, hit.actor.name, formula, type);
  try { await rule.after?.(hit, message); }
  catch(error){ log.error(error); }
}
