import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
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
const rules = new Map();
let hooked = false;

export function addRange(match, feet, { when = null, reach = false, enabled = null, id = null } = {}){
  rules.set(id ?? ((typeof match === "function") ? Symbol() : [match].flat().map(String).join(",") + (reach ? ":reach" : "")), { match, feet, when, reach, enabled });
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.range`, (item, more) => { more.feet += extra(item, false); });
  Hooks.on(`${module.id}.reach`, (item, more) => { more.feet += extra(item, true); });
}

function sourceOf(actor, match){
  if(!actor) return null;
  if(typeof match === "function") return match(actor) || null;
  const ids = [match].flat();
  return actor.items?.find?.(i => (i.type !== "spell") && ids.includes(idOf(i))) ?? null;
}

/* The feet the rules add to this item's range (or reach) */
function extra(item, reach){
  const actor = item?.actor;
  if(!actor) return 0;
  let total = 0;
  for(const rule of rules.values()){
    if((rule.reach !== reach) || (rule.enabled && !rule.enabled())) continue;
    try {
      const source = sourceOf(actor, rule.match);
      if(!source) continue;
      const info = { actor, item, source };
      if(rule.when && !rule.when(info)) continue;
      total += Number((typeof rule.feet === "function") ? rule.feet(info) : rule.feet) || 0;
    } catch(error){ log.error("Range rule", error); }
  }
  return total;
}
