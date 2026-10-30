import { module } from '../module.js';
import { logger } from '../log.js';
import { ruleSet, ruleArgs } from '../helpers/rules.js';
import { hasUses, spendUses } from '../helpers/items.js';
import { usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
const log = logger.for(import.meta.url);

/**
 * The reroll button lego : a button on a card, after the roll, for the roller's owner, that rolls part of it again
 * (Empowered Spell, Seeking Spell, Savage Attacker; a monster's "once per turn it can reroll a missed attack"; a
 * homebrew "reroll your lowest damage die").
 *
 *   rerollButton({
 *     id : "empowered",                                the rule's key
 *     feature : "empowered-spell",                     the item (identifier) the roller needs; or (actor) => item
 *     roll : "damage",                                 "damage" : the lowest `n` damage dice, once a card (attack
 *                                                      cards and save cards with damage); "attack" : a missed attack's
 *                                                      d20, the new roll kept, once an attack; "again" : a hit's
 *                                                      damage rolled again beside the first, each with its own
 *                                                      APPLY (use either), once an attack
 *     when : (card, actor) => true,                    does this card get it (a spell's card...)
 *     n : (actor, card) => 2,                          damage : how many dice (default 1)
 *     cost : (actor, card) => ({ item, amount }),      paid on the click (no button without enough uses)
 *     label : (actor, feature, { n, cost }) => "...", icon : "fa-burst",
 *     face : true, subtitle : (actor, feature) => "...",   once used, the feature is shown under the card's
 *                                                      description, laid out like the item (macro-helper.cardFaces)
 *     once : "turn",                                   the roller uses it once a turn (in combat)
 *     enabled : () => true,
 *   })
 */
const rules = ruleSet("Reroll", { when : false });
let hooked = false;

const rayKey = ray => Number.isInteger(ray) ? String(ray) : "single";

export function rerollButton(match, rule){
  rule = ruleArgs(match, rule);
  if(!rule.id || !["damage", "attack", "again"].includes(rule.roll)) return;
  rules.add(rule.feature, rule, rule.id);
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.cardButtons`, (card, buttons, { ray } = {}) => {
    for(const rule of rules.values()){
      const button = (rule.roll === "damage") ? (!Number.isInteger(ray) && buttonOf(rule, card, null)) : buttonOf(rule, card, ray ?? null);
      if(button) buttons.push(button);
    }
  });
  Hooks.on(`${module.id}.saveCardButtons`, (card, buttons) => {
    if(!card.system?.dealsDamage) return;
    for(const rule of rules.values()){
      const button = (rule.roll === "damage") && buttonOf(rule, card, null);
      if(button) buttons.push(button);
    }
  });
  Hooks.on(`${module.id}.cardButton`, (card, id, { ray } = {}) => {
    if(String(id).startsWith("reroll|")) clicked(rules.get(String(id).slice(7)), card, ray ?? null);
  });
  Hooks.on(`${module.id}.cardFaces`, (card, faces) => {
    const actor = card?.getAssociatedActor?.();
    for(const rule of rules.values()){
      if(!rule.face || !Object.values(card?.getFlag?.(module.id, `rerolls.${rule.id}`) ?? {}).some(Boolean)) continue;
      const feature = rules.sourceOf(actor, rule.match);
      faces.push({ uuid : feature?.uuid ?? null, name : feature?.name, img : feature?.img, subtitle : rule.subtitle?.(actor, feature) ?? "" });
    }
  });
}

/* Has this card's roll been rolled again by that rule ? */
export function rerolled(card, id, ray = null){
  return !!card?.getFlag?.(module.id, `rerolls.${id}.${rayKey(ray)}`);
}

/* The button, or null : not this card, used, or not enough to pay */
function buttonOf(rule, card, ray){
  const actor = card?.getAssociatedActor?.();
  const feature = rules.holds(rule, actor);
  if(!feature || !actor.isOwner || rerolled(card, rule.id, ray)) return null;
  if((rule.once === "turn") && usedThisTurn(actor, `reroll-${rule.id}`)) return null;
  if(rule.when && !rule.when(card, actor)) return null;
  if(rule.roll === "attack"){
    if(!card.system?.isHitOn || card.system.isHitOn(ray)) return null;
  }
  else if(rule.roll === "again"){
    if(!card.system?.isHitOn?.(ray) || !card.system.rollDamage) return null;
  }
  else if(!(card.system?.damageRolls?.length)) return null;
  const cost = rule.cost?.(actor, card) ?? null;
  if(cost?.item && !hasUses(cost.item, cost.amount ?? 1)) return null;
  const n = (rule.roll === "damage") ? Math.max(1, Number(rule.n?.(actor, card)) || 1) : null;
  const label = rule.label?.(actor, feature, { n, cost }) ?? feature.name;
  return { id : `reroll|${rule.id}`, label, icon : rule.icon ?? "fa-dice" };
}

async function clicked(rule, card, ray){
  if(!rule || !buttonOf(rule, card, ray)) return;
  const actor = card.getAssociatedActor();
  const cost = rule.cost?.(actor, card) ?? null;
  if(cost?.item && !(await spendUses(cost.item, cost.amount ?? 1))) return;
  await card.setFlag(module.id, `rerolls.${rule.id}.${rayKey(ray)}`, true);
  if(rule.once === "turn") await markUsedThisTurn(actor, `reroll-${rule.id}`);
  if(rule.roll === "attack") await card.system.rerollAttackRoll(ray);
  else if(rule.roll === "again"){
    const feature = rules.sourceOf(actor, rule.match);
    const rolls = await card.system.rollDamage(ray);
    await card.system.addDamage(rolls, { key : `reroll-${rule.id}`, label : feature?.name ?? rule.id, ray, alternative : true });
  }
  else await card.system.rerollLowestDamage(Math.max(1, Number(rule.n?.(actor, card)) || 1));
  log.debug("Reroll", rule.id, actor.name);
}
