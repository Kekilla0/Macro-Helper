import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { patch } from '../patch.js';
import { ruleSet } from '../helpers/rules.js';
import { rollModes, giveRollMode } from './roll-modes.js';
import { attackOf } from '../roll-item/damage.js';
import { giveMode } from '../roll-item/reasons.js';
import { cantUseWhile } from './use-rules.js';
const log = logger.for(import.meta.url);

/**
 * Armor legos (Medium Armor Master; a homebrew "light armor adds all of your Dexterity"; a monster's) :
 *
 *   acDexCap(match, { cap : 3, armor : "medium", when : ({ actor, armor, source }) => true, enabled, id })
 *       wearing that type of armor ("light", "medium", or several; default any), its AC adds up to `cap` (a number, or
 *       ({ actor, armor, source }) => number) of its Dexterity modifier : the armor's own limit raised, never lowered.
 *       Set on the worn armor before dnd5e works out AC, so the sheet's AC and its breakdown agree.
 *   match    an item identifier the creature has (or several), or (actor) => the source (anything truthy)
 *
 * Armor Training (Rules → Equipment), the 2024 rule : armor worn without training with it (Light, Medium or Heavy)
 * gives Disadvantage on D20 Tests with STR or DEX (attacks, saves, checks) and no spells (Rule Limits); a Shield
 * without training gives no AC (its prepared AC is 0, so the sheet agrees). Training is dnd5e's (an NPC always has it).
 *   untrainedArmor(actor) / untrainedShield(actor) : the item worn without training, or null
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

/* ---------- Armor Training ---------- */

const training = settings.on("armorTraining");

const worn = (actor, shield) => actor?.items?.find?.(i => (i.type === "equipment") && i.system?.equipped
  && (i.system.type?.value in (CONFIG.DND5E.armorTypes ?? {})) && ((i.system.type.value === "shield") === shield)) ?? null;

const untrained = item => !!item && (item.system?.proficiencyMultiplier === 0);

export function untrainedArmor(actor){
  const armor = worn(actor, false);
  return untrained(armor) ? armor : null;
}

export function untrainedShield(actor){
  const shield = worn(actor, true);
  return untrained(shield) ? shield : null;
}

const reasonOf = armor => module.format("armor.untrained", { item : armor.name });

/* An untrained Shield : no AC (its prepared data only) */
function shieldAc(actor){
  const shield = untrainedShield(actor);
  if(shield?.system?.armor) shield.system.armor.value = 0;
}

/* STR or DEX D20 Tests in untrained armor : Disadvantage */
function attackMode(config){
  const attack = attackOf(config);
  const armor = ["str", "dex"].includes(attack.ability) ? untrainedArmor(attack.actor) : null;
  if(armor && config.rolls?.[0]) giveMode(config.rolls[0], "disadvantage", reasonOf(armor));
}

function rollMode(config){
  const armor = ["str", "dex"].includes(config?.ability) ? untrainedArmor(config.subject) : null;
  if(armor) giveRollMode(config, "disadvantage", reasonOf(armor));
}

export function registerArmor(){
  if(game.system.id !== "dnd5e") return;
  /* Once its items are prepared, before dnd5e's system data works out AC */
  patch.wrap("CONFIG.Actor.documentClass.prototype.prepareEmbeddedDocuments", function(wrapped, ...args){
    const result = wrapped(...args);
    if(rules.size) try { raiseCap(this); } catch(error){ log.error("Armor", error); }
    if(training()) try { shieldAc(this); } catch(error){ log.error("Armor Training", error); }
    return result;
  });
  rollModes.add("armorTraining", config => { if(training()) attackMode(config); });
  rollModes.add("armorTraining:rolls", config => { if(training()) rollMode(config); }, { rolls : ["save", "check"] });
  /* A card's save row : the hint shows it before the roll */
  Hooks.on(`${module.id}.saveHint`, (card, actor, ability, { dis } = {}) => {
    const armor = (training() && ["str", "dex"].includes(ability)) ? untrainedArmor(actor) : null;
    if(armor) dis?.push(reasonOf(armor));
  });
  cantUseWhile("armorTrainingSpells", { enabled : training, uses : item => item.type === "spell", while : actor => !!untrainedArmor(actor),
    reason : actor => module.format("armor.noSpells", { name : actor.name, item : untrainedArmor(actor)?.name ?? "" }) });
}
