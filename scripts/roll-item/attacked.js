import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
import { tokenOf, distanceBetween, canSee } from '../helpers/tokens.js';
import { limits } from '../automation/limits.js';
import { actionTracker } from '../automation/action-tracker.js';
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
const rules = [];
let hooked = false;

export function onAttacked(rule){
  if(!rule?.id) return;
  const old = rules.findIndex(r => r.id === rule.id);
  if(old >= 0) rules[old] = rule;
  else rules.push(rule);
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => cardButtons(message, buttons, ray ?? null));
  Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => { if(String(id).startsWith("attacked|")) clicked(message, String(id), ray ?? null); });
}

function featureOf(rule, actor){
  if(typeof rule.feature === "function") return rule.feature(actor);
  return rule.feature ? (actor?.items?.find?.(i => idOf(i) === rule.feature) ?? null) : true;
}

const side = t => t?.document?.disposition;

/* The user's tokens that could step in for this creature */
function guardsFor(rule, target, attacker){
  if(rule.self) return (target?.actor?.isOwner && featureOf(rule, target.actor)) ? [target] : [];
  return (canvas.tokens?.placeables ?? []).filter(t => t.actor?.isOwner && (t !== target) && (t !== attacker)
    && (side(target) === side(t)) && (!attacker || (side(attacker) !== side(t)))
    && featureOf(rule, t.actor) && (distanceBetween(t, target) <= (rule.within ?? 5)));
}

/* Why the guard can't, "" when it can */
function unmet(rule, ctx){
  const { guard, attacker } = ctx;
  if(rule.reaction !== false){
    if(actionTracker.OUT_OF_ACTION.some(s => guard.actor?.statuses?.has?.(s)) || (Number(guard.actor?.system?.attributes?.hp?.value) <= 0))
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
  for(const rule of rules){
    if(rule.enabled && !rule.enabled()) continue;
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
  const rule = rules.find(r => r.id === ruleId);
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
