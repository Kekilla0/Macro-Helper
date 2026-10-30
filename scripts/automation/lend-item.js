import { module } from '../module.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { gm } from '../gm.js';
import { idOf, chooseOption } from '../helpers/utils.js';
import { conjureItem } from '../helpers/items.js';
import { itemFixes } from './item-fixes.js';
const log = logger.for(import.meta.url);

/**
 * The lend lego : a use that gives a creature a use of its own for a while (Dragon's Breath's exhale; a homebrew "the
 * caster lends its ward"; a monster's "grants an ally its breath"). The creature gets an item (a feature) holding a copy
 * of one of the lender's activities, the lender's numbers fixed in it : its save DC, its attack bonus, the dice of the
 * level it was used at, and one damage type when the lender chose one. It goes when `until` ends (the lender's
 * Concentration). On a creature that isn't the user's own (gm.mine), the GM's button gives it.
 *
 *   await lendItem(activity, target, { level, type, until })   the item (null : asked of the GM, or nothing to lend)
 *   lends(match, { activity : item => Activity, enabled })      cast : each target gets the item's `activity`; with
 *                                                               several damage types, the caster picks one first
 *
 * The lent activity is hidden on the lender's own item (used through the lent one, even on itself).
 */
const rules = new Map();
let hooked = false;

export function lends(match, { activity, enabled = null } = {}){
  if(!match || !activity) return;
  rules.set(match, { match, activity, enabled });
  if(hooked) return;
  hooked = true;
  uses.onActivity("lendChoice", (a, ctx, next) => choiceStep(a, ctx, next));
  uses.onActivity("lend", (a, ctx, next) => lendStep(a, ctx, next));
  gm.handle("lendItem", data => lendAsGM(data));
  itemFixes.add({ name : "Lent activity", where : "owned", plan : item => hideFix(item) });
}

function ruleOf(item){
  return [...rules.values()].find(rule => (!rule.enabled || rule.enabled()) && ((typeof rule.match === "function") ? rule.match(item) : (idOf(item) === rule.match))) ?? null;
}

/* The activity a use lends : its item's, when the use is another one of that item (the casting) */
function lentBy(activity){
  const rule = ruleOf(activity?.item);
  const lent = rule?.activity?.(activity.item) ?? null;
  return (lent && (lent.id !== activity.id)) ? lent : null;
}

function typesOf(activity){
  return [...new Set((activity?.damage?.parts ?? []).flatMap(p => [...(p.types ?? [])]))];
}

/* Cast : the damage type first (several), and anyone can be picked */
async function choiceStep(activity, ctx, next){
  const lent = lentBy(activity);
  if(!lent) return next();
  uses.mark(ctx, { pickWho : "any" });
  const types = typesOf(lent);
  if(types.length < 2) return next();
  const label = t => game.i18n.localize(CONFIG.DND5E.damageTypes?.[t]?.label ?? t);
  const type = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-fire", prompt : module.i18n("lend.type"),
    options : types.map(t => ({ value : t, label : label(t) })) });
  if(!type) return;
  uses.mark(ctx, { lendType : type });
  uses.flag(ctx, { note : module.format("spellEffects.chosen", { effect : label(type) }) });
  return next();
}

/* Cast : each target gets the item, tied to the Concentration */
async function lendStep(activity, ctx, next){
  const lent = lentBy(activity);
  if(!lent) return next();
  const picked = [...game.user.targets];
  const result = await next();
  if(!result) return result;
  const card = await uses.cardOf(result).catch(() => null);
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  const targets = (card?.system?.targets?.length ? card.system.targets.map(t => TargetsField.resolve(t)?.token) : picked).filter(t => t?.actor);
  const usage = ctx.config ?? {};
  const level = Number(activity.actor?.system?.spells?.[usage.spell?.slot]?.level) || ((Number(activity.item.system.level) || 0) + (Number(usage.scaling) || 0));
  const until = await concentrationOf(activity.item);
  for(const target of targets) await lendItem(lent, target, { level, type : usage[module.id]?.lendType ?? null, until });
  return result;
}

/* Its Concentration (dnd5e starts it as the spell is cast) */
async function concentrationOf(item){
  if(!item?.requiresConcentration) return null;
  for(let i = 0; i < 10; i++){
    const found = item.actor?.effects?.find?.(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && (e.getFlag("dnd5e", "item")?.id === item.id));
    if(found) return found;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

/**
 * Lend an activity to a creature : a feature on it holding a copy, with the lender's numbers.
 * @param {Activity} activity
 * @param {Actor|Token} target
 * @param {object} [options]
 * @param {number} [options.level]        the level used at (a spell's slot level) : its dice scale to it
 * @param {string} [options.type]         the one damage type it deals (of the activity's)
 * @param {ActiveEffect} [options.until]  it goes when that effect ends (a Concentration)
 * @returns {Promise<Item|null>}
 */
export async function lendItem(activity, target, { level = null, type = null, until = null } = {}){
  const actor = target?.actor ?? target;
  const data = itemData(activity, { level, type });
  if(!actor || !data) return null;
  const key = `lent:${activity.item.uuid}`;
  if(!gm.mine(actor)){
    await gm.ask("lendItem", { actor : actor.uuid, data, key, until : until?.uuid ?? null }, { actor : activity.actor,
      text : module.format("lend.ask", { name : activity.actor?.name ?? "", item : data.name, target : actor.name }),
      label : module.format("lend.button", { target : actor.name }) });
    return null;
  }
  const item = await conjureItem(actor, data, { key, hand : false, until });
  log.debug("Lent", data.name, "to", actor.name);
  return item;
}

/* The GM's button : given, unless what it lasted for has ended */
async function lendAsGM({ actor, data, key, until } = {}){
  const doc = fromUuidSync(actor, { strict : false });
  const effect = until ? fromUuidSync(until, { strict : false }) : null;
  if(!doc || !data || (until && !effect)) return false;
  return !!(await conjureItem(doc, data, { key, hand : false, until : effect }));
}

/* The feature's data : the activity with the lender's DC, attack bonus, dice and damage type fixed */
function itemData(activity, { level, type }){
  const item = activity?.item;
  if(!item) return null;
  const act = activity.toObject();
  foundry.utils.setProperty(act, "visibility.level.max", null);
  act.consumption = { ...(act.consumption ?? {}), targets : [], spellSlot : false, scaling : { allowed : false } };
  if(act.save?.dc) act.save.dc = { calculation : "", formula : String(activity.save.dc.value ?? "") };
  if(act.attack) act.attack = { ...act.attack, bonus : String(parseInt(activity.labels?.toHit) || 0), flat : true };
  const steps = Math.max(0, (Number(level) || 0) - (Number(item.system.level) || 0));
  const parts = activity.damage?.parts ?? [];
  (act.damage?.parts ?? []).forEach((part, i) => {
    const from = parts[i];
    if(type && part.types?.includes?.(type)) part.types = [type];
    if(!steps || !from?.scaling?.mode) return;
    const times = (from.scaling.mode === "half") ? Math.floor(steps / 2) : steps;
    if(from.scaling.number && !from.scaling.formula && !from.custom?.enabled) part.number = (Number(part.number) || 0) + (from.scaling.number * times);
    else part.custom = { enabled : true, formula : from.scaledFormula(steps) };
    part.scaling = { mode : "", number : null, formula : "" };
  });
  const typeLabel = type ? game.i18n.localize(CONFIG.DND5E.damageTypes?.[type]?.label ?? type) : null;
  return {
    name : typeLabel ? `${item.name} (${typeLabel})` : item.name, type : "feat", img : item.img,
    system : { identifier : `${idOf(item) || "lent"}-lent`, description : { value : item.system.description?.value ?? "" }, activities : { [act._id] : act } },
    flags : { [module.id] : { lent : { item : item.uuid, by : item.actor?.uuid ?? null, level : Number(level) || null, type } } },
  };
}

/* The lender's own copy of the activity : hidden (it's used through the lent item) */
function hideFix(item){
  const lent = ruleOf(item)?.activity?.(item);
  if(!lent || (lent.visibility?.level?.max === 0)) return null;
  return { update : { [`system.activities.${lent.id}.visibility.level.max`] : 0 } };
}
