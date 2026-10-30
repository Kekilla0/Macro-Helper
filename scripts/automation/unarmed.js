import { logger } from '../log.js';
import { ruleSet } from '../helpers/rules.js';
import { onDamage } from '../roll-item/damage.js';
const log = logger.for(import.meta.url);

/**
 * The Unarmed Strike damage lego : a feature that gives a creature's Unarmed Strike a damage die of its own instead of
 * "1 + STR" (Tavern Brawler's 1d4, a Tortle's Claws, Unarmed Fighting's d6 / d8; a homebrew "your fists deal 1d6").
 * When several apply, the biggest die wins (with its reroll and type). An Unarmed Strike that already rolls a die (a
 * Monk's Martial Arts) is left alone.
 *
 *   unarmedDamage("tavern-brawler", {             the item (identifier) it needs; or (actor) => item, with an id
 *     id : "unarmed-fighting",                      the rule's key (default the identifier)
 *     die : 4,                                      the die's faces; or (attack) => faces (Unarmed Fighting : 8 with
 *                                                   no weapon or shield in hand, else 6); 0 / null : not this time
 *     reroll : 1,                                   its 1s rolled again, once
 *     type : "slashing",                            its damage type (left out : the strike's own)
 *     bonus : "@mod",                               what's added (default the attack's modifier)
 *     when : attack => true,                        attack : the damage lego's (onDamage)
 *     enabled : () => true,
 *   })
 */
const rules = ruleSet("Unarmed damage");
let hooked = false;

export function unarmedDamage(feature, rule = {}){
  if(!feature) return;
  const id = rule.id ?? ((typeof feature === "string") ? feature : null);
  if(!id) return;
  const when = rule.when;
  rules.add(feature, { ...rule, feature, when : when && (({ attack }) => when(attack)) }, id);
  if(hooked) return;
  hooked = true;
  onDamage((attack, damage) => apply(attack, damage));
}

function apply(attack, damage){
  if(!attack?.isAttack || !attack.unarmed || !attack.actor) return;
  const base = attack.baseDamage;
  if(!base || /\d*d\d+/i.test(base)) return;
  let best = null;
  for(const { rule } of rules.active(attack.actor, { attack })){
    try {
      const faces = Number((typeof rule.die === "function") ? rule.die(attack) : rule.die) || 0;
      if((faces > 0) && (!best || (faces > best.faces))) best = { rule, faces };
    } catch(error){ log.error("Unarmed damage", rule.feature, error); }
  }
  if(!best) return;
  const { rule, faces } = best;
  const formula = `1d${faces}${rule.reroll ? `r${rule.reroll === 1 ? "1" : `<=${rule.reroll}`}` : ""} + ${rule.bonus ?? "@mod"}`;
  if(damage.setBase(formula, { type : rule.type })) log.debug("Unarmed damage", rule.feature, attack.actor.name, formula);
}
