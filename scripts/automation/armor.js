import { logger } from '../log.js';
import { patch } from '../patch.js';
import { ruleSet } from '../helpers/rules.js';
const log = logger.for(import.meta.url);

/**
 * Armor legos (Medium Armor Master; a homebrew "light armor adds all of your Dexterity"; a monster's) :
 *
 *   acDexCap(match, { cap : 3, armor : "medium", when : ({ actor, armor, source }) => true, enabled, id })
 *       wearing that type of armor ("light", "medium", or several; default any), its AC adds up to `cap` (a number, or
 *       ({ actor, armor, source }) => number) of its Dexterity modifier : the armor's own limit raised, never lowered.
 *       Set on the worn armor before dnd5e works out AC, so the sheet's AC and its breakdown agree.
 *   match    an item identifier the creature has (or several), or (actor) => the source (anything truthy)
 */
const rules = ruleSet("Armor Dexterity cap");

export function acDexCap(match, { cap, armor = null, when = null, enabled = null, id = null } = {}){
  rules.add(match, { cap, armor, when, enabled }, id);
}

/* The worn armor's Dexterity limit, raised by the rules that apply (its prepared data only) */
function raiseCap(actor){
  const worn = actor.items?.find?.(i => (i.type === "equipment") && i.system?.equipped && (i.system.type?.value in (CONFIG.DND5E.armorTypes ?? {}))
    && (i.system.type?.value !== "shield"));
  const limit = worn?.system?.armor?.dex;
  if(!worn || (limit === null) || (limit === undefined) || (worn.system.type.value === "heavy")) return;
  let best = Number(limit);
  const fits = rule => !rule.armor || [rule.armor].flat().includes(worn.system.type.value);
  for(const { rule, source } of rules.active(actor, { armor : worn }, fits)){
    try {
      const cap = Number((typeof rule.cap === "function") ? rule.cap({ actor, armor : worn, source }) : rule.cap);
      if(Number.isFinite(cap) && (cap > best)) best = cap;
    } catch(error){ log.error("Armor Dexterity cap", error); }
  }
  if(best > Number(limit)) worn.system.armor.dex = best;
}

export function registerArmor(){
  if(game.system.id !== "dnd5e") return;
  /* Once its items are prepared, before dnd5e's system data works out AC */
  patch.wrap("CONFIG.Actor.documentClass.prototype.prepareEmbeddedDocuments", function(wrapped, ...args){
    const result = wrapped(...args);
    if(rules.size) try { raiseCap(this); } catch(error){ log.error("Armor", error); }
    return result;
  });
}
