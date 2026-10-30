import { module } from '../module.js';
import { logger } from '../log.js';
import { ruleSet, ruleArgs } from '../helpers/rules.js';
import { tokenOf, distanceBetween, canSee, isIncapacitated } from '../helpers/tokens.js';
import { limits } from '../automation/limits.js';
import { actionTracker } from '../automation/action-tracker.js';
import { gm } from '../gm.js';
const log = logger.for(import.meta.url);

/**
 * The "when it's attacked" lego : a button on an attack card for a creature that can step in when another one (or
 * itself) is attacked or hit : Interception, Protection, later Deflect Attacks; a monster's Parry, a bodyguard's
 * "when an ally within 5 ft is hit". The button is the guard's owner's; using it spends the guard's Reaction (Action
 * Tracker) and runs the rule.
 *
 *   onAttacked({
 *     id : "interception", feature : "interception",     the rule's key; the item (identifier) the guard needs, or (actor) => item
 *     when : "hit",                                      "attacked" (default) or "hit"
 *     within : 5,                                        feet from the attacked creature (0 with self)
 *     self : false,                                      true : only the attacked creature itself (Deflect Attacks)
 *     reaction : true,                                   it's a Reaction : not while out of action, nor once spent
 *     sees : true,                                       the guard must see the attacker
 *     unmet : (guard, ctx) => "",                        another requirement (a shield) : why not, "" when met
 *     done : ctx => false,                               already used on this attack
 *     label : ctx => "Intercept", tooltip : ctx => "...", icon : "fa-shield",
 *     run : async ctx => {},                             what it does
 *   })
 *
 * ctx : { message, ray, guard (token), target (the attacked creature's token), attacker (token), roll (the attack) }.
 * Guards are on the attacked creature's side, not the attacker's. A requirement unmet : Rule Limits decides (Off and
 * Warn : the button, with a notice on use; Block : no button).
 */
const rules = ruleSet("When attacked", { when : false });
let hooked = false;

export function onAttacked(match, rule){
  rule = ruleArgs(match, rule);
  if(!rule.id) return;
  registerRaise();
  rules.add(rule.feature ?? (() => true), rule, rule.id);
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => cardButtons(message, buttons, ray ?? null));
  Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => { if(String(id).startsWith("attacked|")) clicked(message, String(id), ray ?? null); });
}

const side = t => t?.document?.disposition;

/* The user's tokens that could step in for this creature */
function guardsFor(rule, target, attacker){
  if(rule.self) return (target?.actor?.isOwner && rules.holds(rule, target.actor)) ? [target] : [];
  return (canvas.tokens?.placeables ?? []).filter(t => t.actor?.isOwner && (t !== target) && (t !== attacker)
    && (side(target) === side(t)) && (!attacker || (side(attacker) !== side(t)))
    && rules.holds(rule, t.actor) && (distanceBetween(t, target) <= (rule.within ?? 5)));
}

/* Why the guard can't, "" when it can */
function unmet(rule, ctx){
  const { guard, attacker } = ctx;
  if(rule.reaction !== false){
    if(isIncapacitated(guard) || (Number(guard.actor?.system?.attributes?.hp?.value) <= 0))
      return module.format("fightingStyles.cantReact", { name : guard.name });
    if(!actionTracker.left(guard.actor, "reaction")) return module.format("actionTracker.spent", { name : guard.name, kind : actionTracker.label("reaction") });
  }
  if((rule.sees !== false) && attacker && (attacker !== guard) && !canSee(guard, attacker)) return module.format("fightingStyles.cantSee", { name : guard.name });
  return rule.unmet?.(guard, ctx) ?? "";
}

const offered = problem => !problem || ["off", "warn"].includes(limits.mode());
const labelOf = (rule, ctx) => rule.label?.(ctx) ?? rule.id;

/* Each attacked creature's guards, for one attack */
function contexts(message, ray){
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  const attacker = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
  const roll = message.system.attackOf(ray);
  const hit = new Set((message.system.hitTargets?.(ray) ?? []).map(t => tokenOf(t)));
  const found = [];
  for(const t of message.system.targetsOf?.(ray) ?? []){
    const target = tokenOf(TargetsField.resolve(t).token);
    if(target) found.push({ message, ray, target, attacker, roll, hit : hit.has(target) });
  }
  return found;
}

function cardButtons(message, buttons, ray){
  if(!message.system?.attackOf?.(ray)) return;
  for(const rule of rules.values()){
    try {
      for(const base of contexts(message, ray)){
        if((rule.when === "hit") && !base.hit) continue;
        for(const guard of guardsFor(rule, base.target, base.attacker)){
          const ctx = { ...base, guard };
          if(rule.done?.(ctx) || !offered(unmet(rule, ctx))) continue;
          buttons.push({ id : `attacked|${rule.id}|${guard.document.uuid}|${base.target.document.uuid}`, icon : rule.icon ?? "fa-shield",
            label : labelOf(rule, ctx), tooltip : rule.tooltip?.(ctx) ?? null });
        }
      }
    } catch(error){ log.error("When attacked", rule.id, error); }
  }
}

async function clicked(message, id, ray){
  const [, ruleId, guardUuid, targetUuid] = id.split("|");
  const rule = rules.get(ruleId);
  const guard = fromUuidSync(guardUuid, { strict : false })?.object;
  const base = rule && guard?.actor?.isOwner && contexts(message, ray).find(c => c.target.document.uuid === targetUuid);
  if(!base || (rule.enabled && !rule.enabled())) return;
  const ctx = { ...base, guard };
  if(rule.done?.(ctx)) return;
  const problem = unmet(rule, ctx);
  if(problem && !limits.allow(problem, { who : guard.name, what : labelOf(rule, ctx) })) return;
  try {
    if(await rule.run(ctx) === false) return;
    if(rule.reaction !== false) await actionTracker.spend(guard.actor, { kind : "reaction", what : labelOf(rule, ctx) }).catch(() => null);
    log.debug("When attacked", rule.id, guard.name, "for", base.target.name);
  } catch(error){
    log.error("When attacked", rule.id, error);
    ui.notifications.warn(error.message);
  }
}

/**
 * A creature's AC raised on an attack card that's out, once for each id (a Parry, Shield) : its hits and misses there
 * follow. The GM's client changes the card; the creature's owner may ask.
 * @param {ChatMessage} message  the attack card
 * @param {Token|TokenDocument|string} token   the creature (or its token uuid)
 * @param {number} amount
 * @param {object} [options]
 * @param {string} [options.id]  what raised it (once a card for each)
 * @returns {Promise<boolean>}  false : not raised (already, or not allowed)
 */
export async function raiseCardAC(message, token, amount, { id = "ac" } = {}){
  registerRaise();
  const uuid = (typeof token === "string") ? token : (token?.document ?? token)?.uuid;
  if(!message?.system?.raiseAC || !uuid) return false;
  return !!await gm.run("raiseCardAC", { message : message.id, uuid, amount : Number(amount) || 0, id });
}

/* Was the AC on that card raised by that id */
export function raisedCardAC(message, token, id = "ac"){
  const uuid = (typeof token === "string") ? token : (token?.document ?? token)?.uuid;
  return !!message?.getFlag?.(module.id, `raisedAC.${id}.${String(uuid).replaceAll(".", "-")}`);
}

let raiseRegistered = false;
function registerRaise(){
  if(raiseRegistered) return;
  raiseRegistered = true;
  gm.handle("raiseCardAC", async ({ message : id, uuid, amount, id : key } = {}, user) => {
    const message = game.messages.get(id);
    const token = fromUuidSync(uuid ?? "", { strict : false });
    if(!message || !token?.actor || !(user?.isGM || token.actor.testUserPermission(user, "OWNER")) || raisedCardAC(message, uuid, key)) return false;
    await message.setFlag(module.id, `raisedAC.${key}.${String(uuid).replaceAll(".", "-")}`, true);
    return message.system.raiseAC(uuid, amount);
  });
}
