import { logger } from '../log.js';
import { idOf } from './utils.js';
const log = logger.for(import.meta.url);

/**
 * A lego's rules list : what every rule lego (ignoresCover, hitDieBonus...) keeps and reads the same way.
 *
 *   const rules = ruleSet("Hit die bonus", { spells : false });
 *   rules.add(match, { formula, when, enabled }, id)    the same id (default : the match) replaces the rule
 *   for(const { rule, source } of rules.active(actor, info, test)) ...
 *   rules.holds(rule, actor, info, test)                 one rule : its source, or null
 *
 *   match    an item identifier the creature has (or several), or (actor) => the source (anything truthy)
 *   enabled  () => boolean leaves the rule off (its setting)
 *   when     ({ ...info, actor, source }) => boolean
 *   test     (rule, { ...info, actor, source }) => boolean : the lego's own check, before `when`
 *   spells   false : spell items never give the rule
 *   when     false : the lego calls its rules' `when` itself (its own arguments : a row, a card...)
 * Errors in a rule's match / when / test are logged under the set's name and skip that rule.
 */
export function ruleSet(name, { spells = true, when : ownWhen = true } = {}){
  const rules = new Map();
  const fits = ids => i => (spells || (i.type !== "spell")) && ids.includes(idOf(i));

  /* Every item on this creature the match names (one per copy of a repeatable feat) */
  function sources(actor, match){
    if(!actor) return [];
    if(typeof match === "function"){
      try { const source = match(actor); return source ? [source] : []; } catch(error){ log.error(`${name} match`, error); return []; }
    }
    return actor.items?.filter?.(fits([match].flat())) ?? [];
  }

  return {
    get size(){ return rules.size; },
    values : () => rules.values(),
    get : id => rules.get(id),
    add(match, rule = {}, id = null){
      const key = id ?? ((typeof match === "function") ? Symbol() : [match].flat().map(String).join(","));
      rules.set(key, { ...rule, match });
    },
    delete : id => rules.delete(id),
    sources,
    sourceOf : (actor, match) => sources(actor, match)[0] ?? null,
    /* This rule's source item on this creature when it holds, else null */
    holds(rule, actor, info = {}, test = null){
      if(!actor || (rule.enabled && !rule.enabled())) return null;
      const source = sources(actor, rule.match)[0];
      if(!source) return null;
      const full = { ...info, actor, source };
      try {
        if(test && !test(rule, full)) return null;
        if(ownWhen && rule.when && !rule.when(full)) return null;
      } catch(error){ log.error(name, error); return null; }
      return source;
    },
    /* The rules that hold for this creature : [{ rule, source }] */
    active(actor, info = {}, test = null){
      const found = [];
      for(const rule of rules.values()){
        const source = this.holds(rule, actor, info, test);
        if(source) found.push({ rule, source });
      }
      return found;
    }
  };
}

/* A rule's object, not a match (an identifier, a list of them, a function) or a value (feet, a list...) */
const isRule = thing => foundry.utils.getType(thing) === "Object";

/**
 * Every rule lego takes (match, rule) : the item that gives it (an identifier, several, or (actor) => the source), then
 * the rule. The older forms still work : (rule) with rule.feature (or rule.match). Returns the rule with `feature`
 * (what the lego reads) and `match` both set, and `id` defaulting to an identifier match.
 *   export function onAttacked(match, rule){ rule = ruleArgs(match, rule); ... }
 */
export function ruleArgs(match, rule){
  if(isRule(match) && (rule === undefined)) [match, rule] = [match.match ?? match.feature, match];
  const out = { ...(rule ?? {}) };
  match ??= out.match ?? out.feature;
  if(match !== undefined) Object.assign(out, { match, feature : match });
  if((out.id === undefined) && ((typeof match === "string") || Array.isArray(match))) out.id = [match].flat().map(String).join(",");
  return out;
}

/**
 * A rule lego whose rule was a value then options (addRange(match, 10, { reach : true })) also takes one rule object
 * (addRange(match, { feet : 10, reach : true })) : the value read from it by `key`.
 * @returns {{ value : any, options : object }}
 */
export function ruleValue(value, options, key){
  if(isRule(value) && (options === undefined)) return { value : value[key], options : value };
  return { value, options : options ?? {} };
}
