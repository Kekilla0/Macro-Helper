import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
import { patch } from '../patch.js';
const log = logger.for(import.meta.url);

/**
 * The ignores lego : a creature whose attacks or damage skip one of the rules that would hold them back (Sharpshooter,
 * Spell Sniper, Crossbow Expert, Elemental Adept, Poisoner; a monster's "its ranged attacks ignore cover", a homebrew
 * "your fire ignores resistance").
 *
 *   ignoresDisadvantage(match, ["threatened", "longRange"], { when })   no disadvantage for an enemy within 5 ft (a
 *                                                                         ranged attack) / for long range
 *   ignoresCover(match, { when })                                         Half and Three-Quarters Cover don't count
 *                                                                         (Total Cover still does)
 *   ignoresProperty(match, "lod", { when })                               a weapon property's limit ("lod" : Loading's
 *                                                                         one shot; "amm" : a free hand to load)
 *   ignoresResistance(match, types, { when })                             its damage of those types ignores Resistance
 *   ignoresTerrain(match, { types, when })                                Difficult Terrain costs it no extra movement
 *                                                                         (types : dnd5e's, "all" by default; "magical",
 *                                                                         "nonmagical", "plants", "web"...)
 *
 *   match  an item identifier the creature has (or several), or (actor) => the item (or anything truthy) that gives it
 *   when   (info) => boolean : this attack or damage qualifies. info { actor, item, activity, target (token), source (the
 *          matched item), message (the card, for cover and damage) }
 *   types  damage types, or (source, info) => damage types (a choice kept on the feat : Elemental Adept)
 *   enabled () => boolean leaves the rule off (its setting). The same id (default : the match) replaces the rule.
 */
const rules = { disadvantage : new Map(), cover : new Map(), property : new Map(), resistance : new Map(), terrain : new Map() };

const keyOf = (match, id) => id ?? ((typeof match === "function") ? Symbol() : [match].flat().map(String).join(","));

/* The item on this creature that gives a rule, or null */
function sourceOf(actor, match){
  if(!actor) return null;
  if(typeof match === "function"){
    try { return match(actor) || null; } catch(error){ log.error("Ignores match", error); return null; }
  }
  const ids = [match].flat();
  return actor.items?.find?.(i => (i.type !== "spell") && ids.includes(idOf(i))) ?? null;
}

/* The first rule of a kind that holds for this info : { source, rule } or null */
function holding(kind, info, test = () => true){
  for(const rule of rules[kind].values()){
    if(rule.enabled && !rule.enabled()) continue;
    const source = sourceOf(info.actor, rule.match);
    if(!source) continue;
    const full = { ...info, source };
    try {
      if(!test(rule, full)) continue;
      if(rule.when && !rule.when(full)) continue;
    } catch(error){ log.error("Ignores rule", error); continue; }
    return { source, rule };
  }
  return null;
}

/**
 * No disadvantage from these reasons.
 * @param {string|string[]|Function} match
 * @param {("threatened"|"longRange")[]|string} reasons
 * @param {object} [options]  { when, enabled, id }
 */
export function ignoresDisadvantage(match, reasons, { when = null, enabled = null, id = null } = {}){
  rules.disadvantage.set(keyOf(match, id), { match, reasons : [reasons].flat(), when, enabled });
}

/**
 * Half and Three-Quarters Cover don't count against its attacks (and saves it forces, where a card asks).
 * @param {string|string[]|Function} match
 * @param {object} [options]  { when, enabled, id }
 */
export function ignoresCover(match, { when = null, enabled = null, id = null } = {}){
  rules.cover.set(keyOf(match, id), { match, when, enabled });
}

/**
 * A weapon property's limit doesn't hold ("lod" : Loading's one shot, "amm" : Ammunition's free hand to load).
 * @param {string|string[]|Function} match
 * @param {string|string[]} properties  dnd5e property keys
 * @param {object} [options]  { when, enabled, id }
 */
export function ignoresProperty(match, properties, { when = null, enabled = null, id = null } = {}){
  rules.property.set(keyOf(match, id), { match, properties : [properties].flat(), when, enabled });
}

/**
 * Its damage of these types ignores Resistance (Immunity still holds).
 * @param {string|string[]|Function} match
 * @param {string[]|Function} types  or (source, info) => types
 * @param {object} [options]  { when, enabled, id }
 */
export function ignoresResistance(match, types, { when = null, enabled = null, id = null } = {}){
  rules.resistance.set(keyOf(match, id), { match, types, when, enabled });
}

/**
 * Difficult Terrain doesn't cost it extra movement (Speedy's Dash; a monster's Spider Climb "ignores webs"), through
 * dnd5e's own list (attributes.movement.ignoredDifficultTerrain) : the ruler and the move's cost both follow it.
 * `when` gets { actor, source } here (Speedy : only while Dashing).
 * @param {string|string[]|Function} match
 * @param {object} [options]  { types = ["all"], when, enabled, id }
 */
export function ignoresTerrain(match, { types = ["all"], when = null, enabled = null, id = null } = {}){
  rules.terrain.set(keyOf(match, id), { match, types : [types].flat(), when, enabled });
}

/* ---------- Asked by the rules they skip ---------- */

/**
 * Does this attack skip a disadvantage : the name of what lets it, or null.
 * @param {Item} item       the attacking item
 * @param {Token} target
 * @param {"threatened"|"longRange"} reason
 * @param {object} [extra]  { activity }
 * @returns {string|null}
 */
export function disadvantageIgnored(item, target, reason, { activity = null } = {}){
  const found = holding("disadvantage", { actor : item?.actor ?? null, item, activity, target }, rule => rule.reasons.includes(reason));
  return found?.source?.name ?? (found ? true : null);
}

/**
 * Does this weapon attack skip a property's limit : the name of what lets it, or null.
 * @param {Actor} actor
 * @param {Item} item
 * @param {string} property
 */
export function propertyIgnored(actor, item, property){
  const found = holding("property", { actor, item, activity : null, target : null }, rule => rule.properties.includes(property));
  return found?.source?.name ?? (found ? true : null);
}

/* The resistances a card's damage ignores on this creature : a Set of types (empty : none) */
function resistancesIgnored(message, target){
  const actor = message?.getAssociatedActor?.() ?? null;
  if(!actor) return new Set();
  const info = { actor, item : message.getAssociatedItem?.() ?? null, activity : message.getAssociatedActivity?.() ?? null, target, message };
  const types = new Set();
  for(const rule of rules.resistance.values()){
    if(rule.enabled && !rule.enabled()) continue;
    const source = sourceOf(actor, rule.match);
    if(!source) continue;
    const full = { ...info, source };
    try {
      if(rule.when && !rule.when(full)) continue;
      /* A rule given once per copy (a repeatable feat) : each copy's types */
      const sources = (typeof rule.match === "function") ? [source] : actor.items.filter(i => (i.type !== "spell") && [rule.match].flat().includes(idOf(i)));
      for(const each of sources){
        const list = (typeof rule.types === "function") ? rule.types(each, { ...full, source : each }) : rule.types;
        for(const type of [list].flat()) if(type) types.add(type);
      }
    } catch(error){ log.error("Ignores resistance", error); }
  }
  return types;
}

/* Difficult Terrain : the types its rules ignore, added to dnd5e's list once its data is ready */
function terrainIgnored(actor){
  const list = actor.system?.attributes?.movement?.ignoredDifficultTerrain;
  if(!(list instanceof Set)) return;
  for(const rule of rules.terrain.values()){
    if(rule.enabled && !rule.enabled()) continue;
    const source = sourceOf(actor, rule.match);
    if(!source) continue;
    try { if(rule.when && !rule.when({ actor, source })) continue; } catch(error){ log.error("Ignores terrain", error); continue; }
    for(const type of rule.types) list.add(type);
  }
}

export function registerIgnores(){
  patch.wrap("CONFIG.Actor.documentClass.prototype.prepareDerivedData", function(wrapped, ...args){
    const result = wrapped(...args);
    if(rules.terrain.size) terrainIgnored(this);
    return result;
  });

  /* Cover : Roll Item asks (its cover chips stay, they're just not counted) */
  Hooks.on(`${module.id}.ignoresCover`, (message, answer) => {
    if(answer.ignore) return;
    const actor = message?.getAssociatedActor?.() ?? null;
    if(!actor) return;
    const found = holding("cover", { actor, item : message.getAssociatedItem?.() ?? null, activity : message.getAssociatedActivity?.() ?? null, target : null, message });
    if(found){ answer.ignore = true; answer.by = found.source?.name ?? ""; }
  });

  /* Resistance : dnd5e's own ignore list, on every calculation from the card (its rows' totals, the tray, Apply) */
  Hooks.on("dnd5e.preCalculateDamage", (actor, damages, options) => {
    if(!rules.resistance.size || (options?.ignore === true) || (options?.ignore?.resistance === true)) return;
    /* The damage's card : Roll Item passes it as origin, dnd5e's trays as originatingMessage */
    const message = options?.origin ?? options?.originatingMessage;
    if(!message?.getAssociatedActor) return;
    const types = resistancesIgnored(message, actor.token ?? actor.getActiveTokens?.()[0] ?? null);
    if(!types.size) return;
    options.ignore ??= {};
    const now = options.ignore.resistance;
    options.ignore.resistance = (now instanceof Set) ? now.union(types) : types;
  });
}
