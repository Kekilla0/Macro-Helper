import { module } from '../module.js';
import { logger } from '../log.js';
import { ruleSet } from '../helpers/rules.js';
import { tokenOf } from '../helpers/tokens.js';
import { TYPES } from '../roll-item/message.js';
const log = logger.for(import.meta.url);

/**
 * The damage reduction lego : a creature takes less damage of some types (Heavy Armor Master; a monster's "reduces
 * Bludgeoning, Piercing and Slashing damage it takes by 3"; a homebrew "fire you take is reduced by 2").
 *
 *   reducesDamage(match, {
 *     amount : (source, actor) => actor.system.attributes.prof,   how much less (a number, or a function)
 *     types : ["bludgeoning", "piercing", "slashing"],            the damage types (default : all)
 *     attacks : true,                                             only from an attack that hit it (an attack card)
 *     when : (actor, source, card) => true,                       it holds now (Heavy armor worn)
 *     enabled, id
 *   })
 *
 *   match  an item identifier the creature has (or several), or (actor) => the item that gives it
 * Worked out with dnd5e's damage (after Resistance), so a card's row numbers, the tray and Apply agree. The amount comes
 * off that damage once for each attack : a card's added box (Sneak Attack) gets only what the attack's own damage of
 * those types left of it. The same id (default : the match) replaces a rule.
 */
const rules = ruleSet("Damage reduction");
let hooked = false;

export function reducesDamage(match, rule = {}){
  const when = rule.when;
  rules.add(match, { ...rule, when : when && (({ actor, source, card }) => when(actor, source, card)) }, rule.id);
  if(hooked) return;
  hooked = true;
  Hooks.on("dnd5e.calculateDamage", (actor, damages, options) => reduce(actor, damages, options));
}

/* The attack on the card that hit this creature : its ray (null : a single attack), or undefined when none did */
function hitRay(card, actor){
  const system = card?.system;
  if((card?.type !== TYPES.attack) || !system?.hitTargets) return undefined;
  const rays = system.isMulti ? system.rays.map((_, i) => i) : [null];
  return rays.find(ray => system.hitTargets(ray).some(t => (tokenOf(t)?.actor ?? t?.actor)?.uuid === actor.uuid));
}

function reduce(actor, damages, options = {}){
  if(!Array.isArray(damages) || !rules.size) return;
  const card = options?.origin ?? options?.originatingMessage ?? null;
  const ray = hitRay(card, actor);
  for(const { rule, source } of rules.active(actor, { card }, rule => !rule.attacks || (ray !== undefined))){
    try {
      const types = rule.types ?? null;
      const typed = d => (Number(d.value) > 0) && (!types || types.includes(d.type)) && !["healing", "temphp", "maximum"].includes(d.type);
      let left = Number((typeof rule.amount === "function") ? rule.amount(source, actor) : rule.amount) || 0;
      /* An added box, or a hit's box without the attack's own damage (taken already) : what the attack's own damage of
         those types didn't use */
      const own = options?.[module.id] ?? {};
      const added = own.parts ? !own.withOwn : String(own.part ?? "").startsWith("tray-extra");
      if(rule.attacks && added){
        const own = (Number.isInteger(ray) ? card.system.rayDamage?.(ray) : card.system.damageRolls) ?? [];
        const used = own.filter(r => !types || types.includes(r.options?.type)).reduce((sum, r) => sum + (Number(r.total) || 0), 0);
        left = Math.max(0, left - used);
      }
      if(left <= 0) continue;
      for(const d of damages.filter(typed)){
        const off = Math.min(left, Number(d.value));
        d.value = Number(d.value) - off;
        damages.amount = Math.max(0, (Number(damages.amount) || 0) - off);
        left -= off;
        if(left <= 0) break;
      }
    } catch(error){ log.error("Damage reduction", error); }
  }
}
