import { module } from '../module.js';
import { logger } from '../log.js';
import { ruleSet, ruleValue } from '../helpers/rules.js';
const log = logger.for(import.meta.url);

/**
 * The range lego : a creature whose spells, features or weapons reach farther (Spell Sniper : +60 ft on spell attacks,
 * Improved Illusions : +60 ft on Illusion spells, Elemental Attunement : +10 ft reach; a monster's "its spells' range is
 * doubled", a homebrew longbow).
 *
 *   addRange(match, 60, { when : ({ item }) => item.type === "spell" })
 *   addRange(match, 10, { reach : true, when : ({ item }) => idOf(item) === "unarmed-strike" })
 *
 *   match  an item identifier the creature has (or several), or (actor) => the item (or anything truthy) that gives it
 *   feet   a number, or (info) => number
 *   when   (info) => boolean ; info { actor, item, source (the matched item) }
 *   reach  true : a melee weapon's reach; else a spell's or feature's range (a weapon's own range is never stretched)
 *   enabled () => boolean leaves it off (its setting). The same id (default : the match) replaces the rule.
 * Range in feet only : Self, Touch and unlimited ranges stay as they are.
 */
const rules = { range : ruleSet("Range rule", { spells : false }), reach : ruleSet("Reach rule", { spells : false }) };
let hooked = false;

export function addRange(match, feet, options){
  ({ value : feet, options } = ruleValue(feet, options, "feet"));
  const { when = null, reach = false, enabled = null, id = null } = options;
  rules[reach ? "reach" : "range"].add(match, { feet, when, enabled }, id);
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.range`, (item, more) => { more.feet += extra(item, false); });
  Hooks.on(`${module.id}.reach`, (item, more) => { more.feet += extra(item, true); });
}

/* The feet the rules add to this item's range (or reach) */
function extra(item, reach){
  const actor = item?.actor;
  if(!actor) return 0;
  let total = 0;
  for(const { rule, source } of rules[reach ? "reach" : "range"].active(actor, { item })){
    try { total += Number((typeof rule.feet === "function") ? rule.feet({ actor, item, source }) : rule.feet) || 0; }
    catch(error){ log.error("Range rule", error); }
  }
  return total;
}
