import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf, chooseOption } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * The item choice lego : a choice made once for an item and kept on it (Elemental Adept's damage type; a homebrew
 * "choose a skill" feature, a monster's chosen element). Asked of whoever adds the item, and of a player for their
 * character's items still without it when the world loads; MacroHelper.askChoice changes it later.
 *
 *   itemChoice("elemental-adept", { id : "damageType", label : "Elemental Adept",
 *     options : item => ["acid", "cold", "fire", "lightning", "thunder"].map(t => ({ value : t, label : CONFIG.DND5E.damageTypes[t].label })),
 *     unique : true });                                  each copy of the item on a creature picks a different one
 *   choiceOf(item, "damageType")                         "fire", or null when not chosen
 *
 *   match    an item identifier (or several), or (item) => boolean
 *   enabled  () => boolean : not asked while off (its setting)
 * Kept in the item's flags (choices.<id>).
 */
const rules = new Map();

export function itemChoice(match, { id, label = "", prompt = "", options, unique = false, enabled = null } = {}){
  if(!id || (typeof options !== "function")) throw new Error("itemChoice needs an id and options : item => [{ value, label }]");
  rules.set(id, { match, id, label, prompt, options, unique, enabled });
}

export function choiceOf(item, id){
  return item?.getFlag?.(module.id, `choices.${id}`) ?? null;
}

const matches = (rule, item) => (typeof rule.match === "function") ? !!rule.match(item) : [rule.match].flat().includes(idOf(item));

/* The rules that apply to this item and are on */
const rulesFor = item => [...rules.values()].filter(r => (!r.enabled || r.enabled()) && matches(r, item));

/**
 * Ask for an item's choice now (again when it has one).
 * @param {Item} item
 * @param {string} [id]  the choice, default every one the item has
 * @returns {Promise<boolean>}  true when one was chosen
 */
export async function askChoice(item, id = null){
  if(!item?.isOwner) return false;
  let chose = false;
  for(const rule of rulesFor(item).filter(r => !id || (r.id === id))){
    const taken = rule.unique ? new Set((item.actor?.items ?? []).filter(i => (i.id !== item.id) && matches(rule, i)).map(i => choiceOf(i, rule.id)).filter(Boolean)) : new Set();
    let options = [];
    try { options = (rule.options(item) ?? []).filter(o => !taken.has(o.value)); } catch(error){ log.error("Item choice options", error); }
    if(!options.length) continue;
    const value = await chooseOption({
      title : rule.label || item.name, options, value : choiceOf(item, rule.id) ?? undefined,
      prompt : rule.prompt || module.format("itemChoice.prompt", { item : item.name, actor : item.actor?.name ?? "" }),
    });
    if(!value) continue;
    await item.setFlag(module.id, `choices.${rule.id}`, value);
    chose = true;
  }
  return chose;
}

/* Choices this item still needs */
const missing = item => rulesFor(item).filter(r => !choiceOf(item, r.id));

export function registerItemChoices(){
  /* Whoever adds the item chooses (after an importer's own windows : a short wait) */
  Hooks.on("createItem", (item, options, userId) => {
    if((userId !== game.user.id) || !item.actor || !missing(item).length) return;
    setTimeout(() => askChoice(item).catch(error => log.error("Item choice", error)), 500);
  });
  /* A player's character : items added before the rule (or the question closed) */
  Hooks.once("ready", () => {
    const actor = game.user.isGM ? null : game.user.character;
    const items = (actor?.items ?? []).filter(i => missing(i).length);
    (async () => { for(const item of items) await askChoice(item); })().catch(error => log.error("Item choices", error));
  });
}
