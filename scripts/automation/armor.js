import { logger } from '../log.js';
import { patch } from '../patch.js';
import { idOf } from '../helpers/utils.js';
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
const rules = new Map();

export function acDexCap(match, { cap, armor = null, when = null, enabled = null, id = null } = {}){
  rules.set(id ?? ((typeof match === "function") ? foundry.utils.randomID() : [match].flat().join(",")), { match, cap, armor, when, enabled });
}

function sourceOf(actor, match){
  if(typeof match === "function") return match(actor) || null;
  const ids = [match].flat();
  return actor.items?.find?.(i => ids.includes(idOf(i))) ?? null;
}

/* The worn armor's Dexterity limit, raised by the rules that apply (its prepared data only) */
function raiseCap(actor){
  const worn = actor.items?.find?.(i => (i.type === "equipment") && i.system?.equipped && (i.system.type?.value in (CONFIG.DND5E.armorTypes ?? {}))
    && (i.system.type?.value !== "shield"));
  const limit = worn?.system?.armor?.dex;
  if(!worn || (limit === null) || (limit === undefined) || (worn.system.type.value === "heavy")) return;
  let best = Number(limit);
  for(const rule of rules.values()){
    if(rule.enabled && !rule.enabled()) continue;
    if(rule.armor && ![rule.armor].flat().includes(worn.system.type.value)) continue;
    try {
      const source = sourceOf(actor, rule.match);
      if(!source) continue;
      const info = { actor, armor : worn, source };
      if(rule.when && !rule.when(info)) continue;
      const cap = Number((typeof rule.cap === "function") ? rule.cap(info) : rule.cap);
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
