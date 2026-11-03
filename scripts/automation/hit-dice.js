import { module } from '../module.js';
import { logger } from '../log.js';
import { ruleSet } from '../helpers/rules.js';
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
 *
 *   extraHitDice(actor, count = 1)
 *       Hit Point Dice over the creature's maximum until its next Long Rest (homebrew Rested Levels +2) : a
 *       character's on its class with the largest die (its bonus Hit Dice, flag extraHitDice { classId : { was, count } },
 *       put back by that Long Rest before its updates); an NPC's an effect on its Hit Dice maximum that dnd5e ends then.
 */
const rules = ruleSet("Hit die bonus");
/* actor uuid -> the once-only effects a Hit Die roll just used */
const usedOnce = new Map();

export function hitDieBonus(match, { formula, when = null, enabled = null, id = null } = {}){
  if(!formula) return;
  rules.add(match, { formula, when, enabled }, id);
}

const ruleOf = effect => effect?.getFlag?.(module.id, "rule") ?? null;

/* What the creature's rules and effects add to a Hit Die : ["1d8", ...], and the once-only effects used */
export function hitDieBonuses(actor){
  const parts = [], once = [];
  for(const { rule, source } of rules.active(actor)){
    try {
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

export async function extraHitDice(actor, count = 1){
  if(!actor || !(count > 0)) return false;
  const classes = Object.values(actor.classes ?? {});
  if(!classes.length){
    if(!actor.system.attributes?.hd) return false;
    const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{ name : game.i18n.localize("hitDice.extra"), img : "icons/sundries/gaming/dice-runed-brown.webp",
      changes : [{ key : "system.attributes.hd.max", type : "add", value : String(count) }], duration : { expiry : "longRest" } }]);
    return !!effect;
  }
  const cls = classes.reduce((best, c) => (parseInt(c.system.hd.denomination?.slice(1)) > parseInt(best.system.hd.denomination?.slice(1))) ? c : best);
  const flag = { ...(actor.getFlag(module.id, "extraHitDice") ?? {}) };
  const now = flag[cls.id] ?? { was : String(cls.system._source.hd?.additional ?? ""), count : 0 };
  now.count += count;
  flag[cls.id] = now;
  await cls.update({ "system.hd.additional" : now.was.trim() ? `${now.was} + ${now.count}` : String(now.count) });
  await actor.setFlag(module.id, "extraHitDice", flag);
  return true;
}

/* A Long Rest : the extra dice go (with the rest's own updates, after its recovery) */
function dropExtraDice(actor, result, config){
  const flag = actor.getFlag(module.id, "extraHitDice");
  if(!flag || (config?.type !== "long") || !result) return;
  result.updateItems ??= [];
  for(const [id, { was }] of Object.entries(flag)){
    if(!actor.items.has(id)) continue;
    const update = result.updateItems.find(u => u._id === id) ?? result.updateItems[result.updateItems.push({ _id : id }) - 1];
    update["system.hd.additional"] = was ?? "";
  }
  result.updateData ??= {};
  result.updateData[`flags.${module.id}.extraHitDice`] = new foundry.data.operators.ForcedDeletion();
}

export function registerHitDice(){
  if(game.system.id !== "dnd5e") return;
  Hooks.on("dnd5e.preRestCompleted", (actor, result, config) => dropExtraDice(actor, result, config));
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
