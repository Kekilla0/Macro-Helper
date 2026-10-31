import { module } from '../module.js';
import { logger } from '../log.js';
import { ruleSet } from '../helpers/rules.js';
const log = logger.for(import.meta.url);

/**
 * Rest length legos (2024 Elf Trance : a Long Rest in 4 hours; a homebrew "rests in half the time") :
 *
 *   restLength(match, { long : 4, short : null, when : ({ actor, source }) => true, enabled, id })
 *       the creature finishes that rest in these hours (a number, or ({ actor, source }) => hours) instead of the
 *       rest's own (Long 8 h, Short 1 h). Under dnd5e's gritty / epic rest variants it scales with the rest
 *       (Trance : half a gritty Long Rest).
 *   match    an item identifier the creature has (or several), or (actor) => the source (anything truthy)
 *
 * Effect rules (flags["macro-helper"].rule) : restLong : 4 / restShort : 0.5, the same from an effect.
 * The shortest that applies wins. A group's Short / Long Rest (Group Travel) lasts as long as its longest member's.
 */
const rules = ruleSet("Rest length");

export function restLength(match, { long = null, short = null, when = null, enabled = null, id = null } = {}){
  if((long == null) && (short == null)) return;
  rules.add(match, { long, short, when, enabled }, id);
}

/* The rest's own length in minutes (dnd5e's rest variant) */
export function standardRest(type){
  return Number(CONFIG.DND5E.restTypes[type]?.duration?.[game.settings.get("dnd5e", "restVariant")]) || 0;
}

/* RAW normal-variant length in hours (Long 8, Short 1) : the scale a rule's hours are read against */
function normalHours(type){
  return (Number(CONFIG.DND5E.restTypes[type]?.duration?.normal) || 0) / 60;
}

/**
 * How long this creature takes to finish that rest : { minutes, source } (source : the item or effect that shortened
 * it, null = the rest's own length)
 */
export function restMinutesOf(actor, type){
  const standard = standardRest(type);
  const scale = normalHours(type) ? standard / normalHours(type) : 60;
  let best = { minutes : standard, source : null };
  const offer = (hours, source) => {
    const minutes = Math.round(Number(hours) * scale);
    if(Number.isFinite(minutes) && (minutes >= 0) && (minutes < best.minutes)) best = { minutes, source };
  };
  if(!actor?.system?.isCreature) return best;
  for(const { rule, source } of rules.active(actor)){
    try {
      const value = rule[type];
      const hours = (typeof value === "function") ? value({ actor, source }) : value;
      if(hours != null) offer(hours, source);
    } catch(error){ log.error("Rest length", error); }
  }
  const key = (type === "long") ? "restLong" : "restShort";
  for(const effect of actor.appliedEffects ?? []){
    const hours = effect.getFlag?.(module.id, "rule")?.[key];
    if(hours != null) offer(hours, effect);
  }
  return best;
}
