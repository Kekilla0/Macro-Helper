import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Hit Point Dice legos (Chef's Replenishing Meal; a homebrew "your Hit Dice heal 2 more"; a monster's feast) :
 *
 *   hitDieBonus(match, { formula : "1d8", when : ({ actor, source }) => true, enabled, id })
 *       each Hit Point Die the creature spends (dnd5e's Hit Die roll : a Short Rest's, the sheet's) adds `formula`
 *       (a string, or ({ actor, source }) => string)
 *   match    an item identifier the creature has (or several), or (actor) => the source (anything truthy)
 *
 * Effect rules (flags["macro-helper"].rule) :
 *   hitDieBonus : "1d8"        the same, from an effect; with hitDieBonusOnce : true, only its first die : the effect
 *                              then goes (the meal eaten once). An effect that lasts until a rest : dnd5e's own
 *                              duration.expiry "shortRest" (any rest) or "longRest".
 */
const rules = new Map();
/* actor uuid -> the once-only effects a Hit Die roll just used */
const usedOnce = new Map();

export function hitDieBonus(match, { formula, when = null, enabled = null, id = null } = {}){
  if(!formula) return;
  rules.set(id ?? ((typeof match === "function") ? foundry.utils.randomID() : [match].flat().join(",")), { match, formula, when, enabled });
}

function sourceOf(actor, match){
  if(typeof match === "function"){
    try { return match(actor) || null; } catch(error){ log.error("Hit die match", error); return null; }
  }
  const ids = [match].flat();
  return actor.items?.find?.(i => ids.includes(idOf(i))) ?? null;
}

const ruleOf = effect => effect?.getFlag?.(module.id, "rule") ?? null;

/* What the creature's rules and effects add to a Hit Die : ["1d8", ...], and the once-only effects used */
export function hitDieBonuses(actor){
  const parts = [], once = [];
  for(const rule of rules.values()){
    if(rule.enabled && !rule.enabled()) continue;
    const source = sourceOf(actor, rule.match);
    if(!source) continue;
    try {
      if(rule.when && !rule.when({ actor, source })) continue;
      const formula = (typeof rule.formula === "function") ? rule.formula({ actor, source }) : rule.formula;
      if(formula) parts.push(String(formula));
    } catch(error){ log.error("Hit die bonus", error); }
  }
  for(const effect of actor.appliedEffects ?? actor.effects ?? []){
    const rule = ruleOf(effect);
    if(!rule?.hitDieBonus || effect.disabled) continue;
    parts.push(String(rule.hitDieBonus));
    if(rule.hitDieBonusOnce) once.push(effect.id);
  }
  return { parts, once };
}

export function registerHitDice(){
  if(game.system.id !== "dnd5e") return;
  Hooks.on("dnd5e.preRollHitDieV2", config => {
    const actor = config?.subject;
    const roll = config?.rolls?.[0];
    if(!actor || !roll) return;
    const { parts, once } = hitDieBonuses(actor);
    if(!parts.length) return;
    roll.parts = [...(roll.parts ?? []), ...parts];
    if(once.length) usedOnce.set(actor.uuid, once);
    log.debug("Hit die bonus", actor.name, parts);
  });
  Hooks.on("dnd5e.postRollHitDie", async (rolls, { subject } = {}) => {
    const once = subject && usedOnce.get(subject.uuid);
    if(!once) return;
    usedOnce.delete(subject.uuid);
    const ids = once.filter(id => subject.effects.has(id));
    if(ids.length && subject.isOwner) await subject.deleteEmbeddedDocuments("ActiveEffect", ids);
  });
}
