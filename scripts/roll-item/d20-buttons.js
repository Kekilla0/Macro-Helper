import { module } from '../module.js';
import { logger } from '../log.js';
import { ruleSet, ruleArgs } from '../helpers/rules.js';
import { hasUses, spendUses } from '../helpers/items.js';
import { usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
import { gm } from '../gm.js';
import { rerolls, extraD20 } from './rerolls.js';
const log = logger.for(import.meta.url);

/**
 * The extra d20 lego : a button that adds a second d20 to a D20 Test already rolled, keeping the higher or the lower
 * (Lucky's Luck Points; a monster's "it can force a creature to reroll and take the lower"; a homebrew charm).
 * Advantage and disadvantage cancel, as dnd5e's do; no button on a roll that already has that mode.
 *
 *   d20Button({
 *     id : "lucky",                                   the rule's key
 *     feature : "lucky",                              the item (identifier) its owner needs; or (actor) => item
 *     keep : "kh",                                    "kh" : the higher (advantage), "kl" : the lower (disadvantage)
 *     tests : ["attack", "save", "check", "initiative"],   which rolls (default all four)
 *     against : true,                                 attack rolls against the feature's owner (one of the card's
 *                                                     targets), not its own rolls : the GM changes the card
 *     cost : (actor, feature) => ({ item, amount }),  paid on the click (no button without enough uses)
 *     once : "turn",                                  its owner uses it once a turn (in combat)
 *     label : (actor, feature) => "...", icon : "fa-clover",
 *     enabled : () => true,
 *   })
 * Each rule is used once a roll (an attack on a multi-attack card : once each).
 */
const rules = ruleSet("Extra d20");
let hooked = false;

const rayKey = ray => Number.isInteger(ray) ? String(ray) : "single";
const want = rule => (rule.keep === "kl") ? -1 : 1;

export function d20Button(match, rule){
  rule = ruleArgs(match, rule);
  if(!rule.id || !["kh", "kl"].includes(rule.keep)) return;
  rules.add(rule.feature, rule, rule.id);
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.rerollButtons`, (message, buttons, { actor, roll }) => testButtons(message, buttons, actor, roll));
  Hooks.on(`${module.id}.cardButtons`, (card, buttons, { ray } = {}) => attackButtons(card, buttons, ray ?? null));
  Hooks.on(`${module.id}.cardButton`, (card, id, { ray } = {}) => {
    if(String(id).startsWith("d20|")) attackClicked(rules.get(String(id).slice(4)), card, ray ?? null);
  });
  gm.handle("d20Against", (data, user) => againstAsGM(data, user));
}

/* Its feature, when the rule is on, its owner may use it now and can pay */
function usable(rule, actor){
  const feature = rules.holds(rule, actor);
  if(!feature) return null;
  if((rule.once === "turn") && usedThisTurn(actor, `d20-${rule.id}`)) return null;
  const cost = rule.cost?.(actor, feature) ?? null;
  if(cost?.item && !hasUses(cost.item, cost.amount ?? 1)) return null;
  return feature;
}

async function pay(rule, actor, feature){
  const cost = rule.cost?.(actor, feature) ?? null;
  if(cost?.item) await spendUses(cost.item, cost.amount ?? 1, { warn : false });
  if(rule.once === "turn") await markUsedThisTurn(actor, `d20-${rule.id}`);
}

function testsOf(rule){
  return rule.tests ?? ["attack", "save", "check", "initiative"];
}

function label(rule, actor, feature){
  return rule.label?.(actor, feature) ?? feature.name;
}

/* ---------- Saves, checks, initiative ---------- */

function testButtons(message, buttons, actor, roll){
  if(!actor?.isOwner) return;
  const kind = message.getFlag?.("core", "initiativeRoll") ? "initiative" : message.type;
  for(const rule of rules.values()){
    if(rule.against || !testsOf(rule).includes(kind) || message.getFlag?.(module.id, `d20.${rule.id}`)) continue;
    if(Number(roll?.options?.advantageMode ?? 0) === want(rule)) continue;
    const feature = usable(rule, actor);
    if(!feature) continue;
    buttons.push({ id : `d20|${rule.id}`, icon : rule.icon ?? "fa-dice-d20", label : label(rule, actor, feature), run : async () => {
      const now = usable(rule, actor);
      if(!now || !message.isOwner || message.getFlag(module.id, `d20.${rule.id}`)) return;
      const result = await extraD20(message.rolls[0], rule.keep);
      if(!result) return;
      if(result.status === "same") return ui.notifications.info(module.i18n("rollItem.d20.same"));
      await rerolls.replace(message, result.updated, result.extra ? [result.extra] : []);
      await pay(rule, actor, now);
      await message.setFlag(module.id, `d20.${rule.id}`, true);
      log.debug("Extra d20", rule.id, actor.name);
    } });
  }
}

/* ---------- Attack cards ---------- */

/* The card's targets that have the rule's feature (against : the attack is at them) */
function targetsWith(rule, card, ray, test = a => a.isOwner){
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  const attacker = card.getAssociatedActor?.();
  return (card.system.targetsOf?.(ray) ?? []).map(t => TargetsField.resolve(t).actor)
    .filter(a => a && (a !== attacker) && test(a) && usable(rule, a));
}

function attackButtons(card, buttons, ray){
  if(!card.system?.addD20) return;
  const roll = card.system.attackOf?.(ray);
  if(!roll) return;
  for(const rule of rules.values()){
    if(!testsOf(rule).includes("attack") || card.getFlag?.(module.id, `d20.${rule.id}.${rayKey(ray)}`)) continue;
    if(Number(roll.options?.advantageMode ?? 0) === want(rule)) continue;
    const actor = rule.against ? targetsWith(rule, card, ray)[0] : card.getAssociatedActor?.();
    if(!actor?.isOwner) continue;
    const feature = usable(rule, actor);
    if(feature) buttons.push({ id : `d20|${rule.id}`, label : label(rule, actor, feature), icon : rule.icon ?? "fa-dice-d20" });
  }
}

async function attackClicked(rule, card, ray){
  if(!rule || !testsOf(rule).includes("attack")) return;
  if(rule.against){
    /* The card isn't theirs : the GM changes it */
    const notes = await gm.run("d20Against", { message : card.id, rule : rule.id, ray });
    for(const note of notes ?? []) ui.notifications.info(note);
    return;
  }
  const actor = card.getAssociatedActor?.();
  const feature = actor?.isOwner && usable(rule, actor);
  const key = `d20.${rule.id}.${rayKey(ray)}`;
  if(!feature || !card.isOwner || card.getFlag(module.id, key)) return;
  const result = await card.system.addD20(ray, rule.keep);
  if(result === "same") return ui.notifications.info(module.i18n("rollItem.d20.same"));
  if(!result) return;
  await pay(rule, actor, feature);
  await card.setFlag(module.id, key, true);
  log.debug("Extra d20", rule.id, actor.name);
}

/* GM : the asker must own one of the attack's targets with the feature (and its cost); once an attack */
async function againstAsGM({ message : id, rule : ruleId, ray = null } = {}, user){
  const card = game.messages.get(id);
  const rule = rules.get(ruleId);
  if(!rule?.against || !card?.system?.addD20) throw new Error("Not a Roll Item attack card.");
  const key = `d20.${rule.id}.${rayKey(ray)}`;
  if(card.getFlag(module.id, key)) return [module.i18n("rollItem.d20.done")];
  const [actor] = targetsWith(rule, card, ray, a => a.testUserPermission(user, "OWNER"));
  if(!actor) return [module.i18n("rollItem.d20.none")];
  const result = await card.system.addD20(ray, rule.keep);
  if(result === "same") return [module.i18n("rollItem.d20.same")];
  if(!result) return [];
  await pay(rule, actor, rules.sourceOf(actor, rule.match));
  await card.setFlag(module.id, key, true);
  return [];
}
