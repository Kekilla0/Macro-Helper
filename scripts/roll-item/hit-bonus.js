import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
import { tokenOf, distanceBetween } from '../helpers/tokens.js';
import { usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
import { spendUses } from '../helpers/items.js';
import { TYPES } from './message.js';
import { actionTracker } from '../automation/action-tracker.js';
const log = logger.for(import.meta.url);

/**
 * The on-hit bonus lego : a rule that adds damage after a hit (Divine Fury, Hand of Harm, Colossus Slayer, a Battle
 * Master's maneuver) says it once, as sentences; its owner gets a button on the attack card once the attack hits.
 * The damage goes on the card as its own box (doubled on a crit), once per attack.
 *
 *   onHit({
 *     id : "divine-fury", feature : "divine-fury",          the button's key; the item (identifier) it needs
 *     when : hit => hit.weapon || hit.unarmed,               does this hit qualify
 *     formula : hit => "1d6 + 1",                            the damage; left out : no damage, the click only runs
 *                                                            `after` (a shield bash's save), once per attack
 *     types : hit => ["necrotic", "radiant"],                its type (several : a button each); the weapon's if left out
 *     once : "turn",                                         "turn" (once a turn), "target" (each creature once a turn)
 *     counted : "apply",                                     once counts when its damage is applied to a creature, not
 *                                                            on the click (Sneak Attack : rolling isn't using it)
 *     again : actor => false,                                its damage applied again in the turn : go ahead? (Rule Limits)
 *     noHit : actor => "...",                                the warning when used from the sheet with no hit for it
 *     ownTurn : true,                                        only on the attacker's own turn
 *     critical : true,                                       only on a critical hit
 *     attackAction : true,                                   only an attack that's part of the Attack action, on the
 *                                                            attacker's own turn
 *     cost : hit => ({ item, amount : 1 }),                  spent on the click (none left : no button); { activity } :
 *                                                            that activity's own uses (Dreadful Strike's)
 *     after : (hit, card) => {},                             once it's on the card (a save, a mark)
 *   })
 *
 * hit : { message, ray, actor, token, item, activity, roll, critical, advantage, disadvantage, target, targets, weapon,
 *         finesse, unarmed, spell, cantrip, melee, ranged, ability, damageType, damageTypes (a Set : every type the
 *         attack's damage has, its added boxes too), attackAction, tags (the attack roll's : Cleave's noMod, a rule's
 *         bonusAttack), opportunity (an Opportunity Attack), feature }
 *
 * useOnLatestHit(id, actor) : the rule used from the sheet : the latest of the actor's attack cards (among the last
 * messages) with a hit it qualifies for.
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
  Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => applied(options));
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
  const damageTypes = new Set([...base, ...(card.extraRolls?.(ray) ?? [])].map(r => r?.options?.type).filter(Boolean));
  if(!damageTypes.size) for(const t of item.system?.damage?.base?.types ?? []) damageTypes.add(t);
  return {
    message, ray, actor, token : tokenOf(message.getAssociatedToken?.() ?? actor), item, activity, roll,
    critical : !!roll?.isCritical, advantage : !!roll?.hasAdvantage, disadvantage : !!roll?.hasDisadvantage, target : targets[0] ?? null, targets,
    weapon : item.type === "weapon", finesse : !!item.system?.properties?.has?.("fin"), unarmed : (idOf(item) === "unarmed-strike") || (classification === "unarmed"),
    spell : item.type === "spell", cantrip : (item.type === "spell") && (Number(item.system?.level) === 0),
    melee : action.startsWith("m"), ranged : action.startsWith("r"),
    ability : roll?.options?.ability ?? activity?.ability ?? null,
    damageType : base[0]?.options?.type ?? [...(item.system?.damage?.base?.types ?? [])][0] ?? null,
    damageTypes,
    attackAction : isAttackAction(actor, activity),
    tags : roll?.options?.[module.id]?.tags ?? {},
    opportunity : !!roll?.options?.[module.id]?.tags?.opportunity,
  };
}

/**
 * Is it an attack made as part of the Attack action, on its creature's own turn : a weapon's (or a Multiattack
 * creature's) attack paid with the Action (Action Tracker; off : any such attack on its turn).
 * @param {Actor} actor
 * @param {Activity} activity
 * @returns {boolean}
 */
export function isAttackAction(actor, activity){
  if(!actionTracker.isAttack(activity) || !ownTurn(actor)) return false;
  if(!actionTracker.enabled() || !game.combat?.started) return true;
  const paid = String(actionTracker.paidBy(actor) ?? "");
  return !paid || paid.startsWith("action");
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
  if(rule.critical && !hit.critical) return "off";
  if(rule.attackAction && !hit.attackAction) return "off";
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

const rayKey = ray => Number.isInteger(ray) ? String(ray) : "single";

/* Used on this attack : its damage box, or (no damage) the card's mark */
function usedOn(rule, message, ray){
  if(!rule.formula) return !!message.getFlag?.(module.id, `hitUsed.${rule.id}.${rayKey(ray)}`);
  return !!message.system.extraRolls?.(ray, rule.id)?.length;
}

function typesOf(rule, hit){
  if(!rule.formula) return [""];
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
    if(!hit.actor.isOwner || usedOn(rule, message, ray)) continue;
    if(problem(rule, hit)) continue;
    const types = typesOf(rule, hit);
    const label = labelOf(rule, hit);
    for(const type of types){
      const typeLabel = type ? (CONFIG.DND5E.damageTypes?.[type]?.label ?? type) : "";
      buttons.push({ id : `onHit|${rule.id}|${type}`, icon : rule.icon ?? "fa-burst",
        label : (types.length > 1) ? `${label} (${typeLabel})` : label });
    }
  }
}

async function clicked(message, id, ray){
  const [, ruleId, type] = id.split("|");
  const rule = rules.find(r => r.id === ruleId);
  const hit = hitOf(message, ray);
  if(!rule || !hit?.actor?.isOwner || usedOn(rule, message, ray)) return;
  const why = problem(rule, hit);
  if(why) return ui.notifications.warn(module.format("hitBonus.notNow", { name : labelOf(rule, hit) }));
  const cost = rule.cost?.(hit);
  if(cost && !await pay(cost)) return;
  if(rule.once && (rule.counted !== "apply")) await markUsedThisTurn(hit.actor, onceKey(rule, hit));
  if(!rule.formula){
    if(message.isOwner) await message.setFlag(module.id, `hitUsed.${rule.id}.${rayKey(ray)}`, true);
    log.debug("On-hit use", rule.id, hit.actor.name);
    try { await rule.after?.(hit, message); }
    catch(error){ log.error(error); }
    return;
  }
  const formula = String(rule.formula(hit));
  await message.system.extraDamage(formula, { key : rule.id, type : type || null, ray, label : labelOf(rule, hit),
    rollData : hit.actor.getRollData?.() ?? {}, magical : !!rule.magical });
  log.debug("On-hit bonus", rule.id, hit.actor.name, formula, type);
  try { await rule.after?.(hit, message); }
  catch(error){ log.error(error); }
}

/* Its box applied to a creature : the turn's use, for a rule counted then (a second one that turn : rule.again) */
function applied(options = {}){
  const part = String(options?.[module.id]?.part ?? "");
  if(!part.startsWith("tray-extra-")) return;
  const rule = rules.find(r => (r.counted === "apply") && r.once && part.startsWith(`tray-extra-${r.id}`));
  const attacker = rule && options.origin?.getAssociatedActor?.();
  if(!attacker || (rule.enabled && !rule.enabled())) return;
  const key = onceKey(rule, { target : null });
  if(usedThisTurn(attacker, key) && (rule.again?.(attacker) === false)) return false;
  markUsedThisTurn(attacker, key);
}

/**
 * A rule used from the sheet : the latest of this actor's attack cards (the last 15 messages) with a hit it offers its
 * button on, and its damage put there (its first type).
 * @param {string} id      the rule's id
 * @param {Actor} actor
 * @returns {Promise<ChatMessage|null>}  the card, or null (no such hit : a warning)
 */
export async function useOnLatestHit(id, actor){
  const rule = rules.find(r => r.id === id);
  for(const message of rule ? game.messages.contents.slice(-15).reverse() : []){
    if((message.type !== TYPES.attack) || (message.getAssociatedActor?.()?.id !== actor?.id)) continue;
    const rays = message.system.isMulti ? message.system.rays.map((_, i) => i) : [null];
    for(const ray of rays){
      const hit = hitOf(message, ray);
      if(!hit || usedOn(rule, message, ray) || problem(rule, hit)) continue;
      await clicked(message, `onHit|${rule.id}|${typesOf(rule, hit)[0] ?? ""}`, ray);
      return message;
    }
    break;
  }
  ui.notifications.warn(rule?.noHit?.(actor) ?? module.format("hitBonus.noHit", { name : actor?.name ?? "", item : rule ? labelOf(rule, { actor, feature : featureOf(rule, actor) }) : id }));
  return null;
}
