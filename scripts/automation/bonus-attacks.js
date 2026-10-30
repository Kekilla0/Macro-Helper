import { module } from '../module.js';
import { logger } from '../log.js';
import { ruleSet } from '../helpers/rules.js';
import { onDamage } from '../roll-item/damage.js';
import { TYPES } from '../roll-item/message.js';
import { actionTracker } from './action-tracker.js';
const log = logger.for(import.meta.url);

/**
 * The bonus attack lego : an attack a creature may make as its Bonus Action, after something it did this turn (the
 * Light property's extra attack, Martial Arts' Unarmed Strike, Dual Wielder, Polearm Master's Pole Strike, Great Weapon
 * Master's Hew; a monster's "after a hit, it can bite as a Bonus Action", a homebrew "after a crit, attack again").
 * The Action Tracker reads it : once the Attack action's own attacks are made (or with none to make), such an attack
 * spends the Bonus Action instead of a new Action.
 *
 *   bonusAttackAfter(match, {
 *     after : "attackAction",       what it needs first, this turn : "attackAction" (it took the Attack action),
 *                                   "any" (nothing : Martial Arts), "critical" (a critical hit), "drop" (an attack
 *                                   brought a creature to 0 HP); several in a list (Hew : ["critical", "drop"])
 *     when : info => boolean,       is this attack the one it allows. info { actor, item, activity, source (the matched
 *                                   item), attacked (ids of the items it attacked with on its Attack action this
 *                                   turn), light (ids of the Light weapons among them) }
 *     trigger : hit => boolean,     "critical" / "drop" : the attack that gives it (hit : hitOf's, at least { actor,
 *                                   item, activity, critical, melee, weapon }); the bonus attack is then with that weapon
 *     damage : (attack, damage, info) => {},   that bonus attack's damage changed (onDamage's sentences : Pole Strike's
 *                                   d4 Bludgeoning)
 *     label : source => string,     the log's name for it (default : the source's name)
 *     enabled : () => boolean, id   its setting; the same id (default : the match) replaces the rule
 *   })
 *
 *   match  an item identifier the creature has (or several), or (actor) => the item (or anything truthy) that gives it
 */
const rules = ruleSet("Bonus attack", { spells : false, when : false });
let hooked = false;

const keyOf = (match, id) => id ?? ((typeof match === "function") ? foundry.utils.randomID() : [match].flat().map(String).join(","));

const afterOf = rule => [rule.after ?? "attackAction"].flat();

/**
 * Add a rule.
 * @param {string|string[]|Function} match
 * @param {object} [options]  see above
 * @returns {string}  the rule's id
 */
export function bonusAttackAfter(match, { after = "attackAction", when = null, trigger = null, damage = null, label = null, enabled = null, id = null } = {}){
  const key = keyOf(match, id);
  rules.add(match, { id : key, after, when, trigger, damage, label, enabled }, key);
  hook();
  return key;
}

/**
 * The rule that lets this attack be the Bonus Action now, or null. The Action Tracker asks, with the turn's record.
 *   { rule (its id), grant (a "critical" / "drop" grant it uses up), text (the log's name) }
 * @param {Activity} activity
 * @param {object} rec   the creature's turn record (actionTracker.state(actor).rec)
 * @param {object} [options]
 * @param {boolean} [options.attackAction]   the Attack action was taken this turn (rec.attack)
 */
export function bonusAttackRule(activity, rec, { attackAction = !!rec?.attack } = {}){
  const actor = activity?.actor, item = activity?.item;
  if(!actor || !item) return null;
  /* A grant first : a critical hit or a drop gave one, with that weapon */
  for(const grant of rec?.bonusGrants ?? []){
    const rule = rules.get(grant.rule);
    if(!rule || (grant.item !== item.id)) continue;
    const source = rules.holds(rule, actor);
    if(source) return { rule : rule.id, grant, text : textOf(rule, source) };
  }
  const info = { actor, item, activity, attacked : [...(rec?.attackIds ?? [])], light : [...(rec?.lightIds ?? [])] };
  const allowed = rule => { const after = afterOf(rule); return after.includes("any") || (after.includes("attackAction") && attackAction); };
  const [found] = rules.active(actor, info, (rule, full) => allowed(rule) && (!rule.when || rule.when(full)));
  if(found) return { rule : found.rule.id, text : textOf(found.rule, found.source) };
  return null;
}

function textOf(rule, source){
  try { return rule.label?.(source) ?? source?.name ?? ""; } catch { return source?.name ?? ""; }
}

/* ---------- Grants : a critical hit, a creature brought to 0 HP ---------- */

const granted = new Set();

/* Rules this attack triggers : { rule, source } */
function triggered(kind, hit){
  return rules.active(hit.actor, {}, (rule, { source }) => afterOf(rule).includes(kind) && (!rule.trigger || rule.trigger({ ...hit, source })));
}

/* A grant on its own turn only (a Bonus Action is), once per attack card and rule */
async function grant(kind, hit, key){
  const actor = actionTracker.payerOf(hit.actor);
  const st = actionTracker.state(actor);
  if(!st?.mine || !actor.isOwner || !hit.item) return;
  for(const { rule, source } of triggered(kind, hit)){
    const once = `${key}|${rule.id}`;
    if(granted.has(once)) continue;
    granted.add(once);
    const rec = actionTracker.state(actor)?.rec;
    if(!rec || (rec.bonusGrants ?? []).some(g => (g.rule === rule.id) && (g.item === hit.item.id))) continue;
    rec.bonusGrants = [...(rec.bonusGrants ?? []), { rule : rule.id, item : hit.item.id, kind }];
    actionTracker.note(rec, module.format("bonusAttack.granted", { what : textOf(rule, source), item : hit.item.name }));
    await actionTracker.save(actor, rec);
    log.debug("Bonus attack granted", actor.name, rule.id, kind);
  }
}

async function onCard(message){
  if((message?.type !== TYPES.attack) || !message.isAuthor) return;
  const { hitOf } = await import('../roll-item/hit-bonus.js');
  const rays = message.system?.isMulti ? message.system.rays.map((_, i) => i) : [null];
  for(const ray of rays){
    const hit = hitOf(message, ray);
    if(hit?.critical) await grant("critical", hit, `${message.id}.${ray ?? "single"}`).catch(error => log.error(error));
  }
}

/* Its damage brought a creature to 0 HP : the card's attacker, with the card's weapon */
async function onDamaged(actor, amount, options){
  if(!(amount > 0) || (Number(actor?.system?.attributes?.hp?.value) > 0)) return;
  const message = options?.origin ?? options?.originatingMessage;
  if(message?.type !== TYPES.attack) return;
  const activity = message.getAssociatedActivity?.();
  const attacker = message.getAssociatedActor?.() ?? activity?.actor;
  if(!attacker || !activity?.item) return;
  let action = "";
  try { action = String(activity.getActionType?.(message.system?.attackOf?.(null)?.options?.attackMode) ?? ""); } catch {}
  const hit = { message, actor : attacker, item : activity.item, activity, critical : false, weapon : activity.item.type === "weapon",
    melee : action ? action.startsWith("m") : ((activity.attack?.type?.value ?? "melee") === "melee"), dropped : actor };
  await grant("drop", hit, `${message.id}.drop.${actor.uuid}`).catch(error => log.error(error));
}

function hook(){
  if(hooked) return;
  hooked = true;
  Hooks.on("createChatMessage", message => onCard(message));
  Hooks.on("updateChatMessage", (message, changes) => { if(changes?.system || changes?.rolls) onCard(message); });
  Hooks.on("dnd5e.applyDamage", (actor, amount, options) => onDamaged(actor, amount, options));
  /* A bonus attack's own damage (its tag on the attack : Pole Strike's d4) */
  onDamage((attack, damage) => {
    const id = attack.tags?.bonusAttack;
    const rule = id ? rules.get(id) : null;
    if(!rule?.damage || (rule.enabled && !rule.enabled())) return;
    rule.damage(attack, damage, { source : rules.sourceOf(attack.actor, rule.match) });
  });
}
