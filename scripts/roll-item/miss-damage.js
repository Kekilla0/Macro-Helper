import { module } from '../module.js';
import { logger } from '../log.js';
import { ruleSet, ruleArgs } from '../helpers/rules.js';
import { rollItem } from './roll-item.js';
const log = logger.for(import.meta.url);

/**
 * The on-miss lego : damage an attack deals when it misses (Graze; a monster's "on a miss, half damage"). Rolled with
 * every attack it qualifies for (and again when the attack is rerolled), shown under the attack in a box of its own
 * with its own APPLY once the attack misses (or when there's no target to judge by). Apply Hits deals it on a miss.
 *
 *   onMiss({
 *     id : "graze",                                         the rule's key (and its damage box's)
 *     feature : "graze",                                    the item (identifier) the attacker needs; or (actor) => item
 *     when : miss => miss.mastery === "graze",              does this attack qualify
 *     formula : miss => String(miss.mod),                   the damage (null / "" / 0 : none)
 *     type : miss => "slashing",                            its type; the attack's own damage type if left out
 *     label : miss => "Graze", icon : "fa-droplet",
 *   })
 *
 * miss : { activity, item, actor, roll (the attack), ability, mod (its modifier), mastery, damage (its damage rolls),
 *          weapon, melee, ranged, feature }
 */
const rules = ruleSet("On-miss rule");
let hooked = false;

export function onMiss(match, rule){
  rule = ruleArgs(match, rule);
  if(!rule.id) return;
  const when = rule.when;
  rules.add(rule.feature ?? (() => true), { ...rule, when : when && (({ miss, source }) => when({ ...miss, feature : source })) }, rule.id);
  if(hooked) return;
  hooked = true;
  foundry.applications.handlebars.loadTemplates({ [`${module.id}.on-miss`] : `${module.path}/templates/on-miss.hbs` });
  rollItem.addRolls((activity, attack, damage) => rollsFor(activity, attack, damage));
  Hooks.on(`${module.id}.cardSections`, (message, sections, { ray } = {}) => sectionsFor(message, sections, ray ?? null));
}

function missOf(activity, attack, damage = []){
  const actor = activity?.actor;
  const item = activity?.item;
  let action = "";
  try { action = String(activity?.getActionType?.(attack?.options?.attackMode) ?? ""); } catch {}
  const ability = attack?.options?.ability ?? activity?.ability ?? null;
  return {
    activity, item, actor, roll : attack, ability, mod : Number(actor?.system?.abilities?.[ability]?.mod) || 0,
    mastery : attack?.options?.mastery ?? null, damage,
    weapon : item?.type === "weapon", melee : action.startsWith("m"), ranged : action.startsWith("r"),
  };
}

const labelOf = (rule, miss) => rule.label?.(miss) ?? ((miss.feature && (miss.feature !== true)) ? miss.feature.name : rule.id);

async function rollsFor(activity, attack, damage){
  const rolls = [];
  for(const rule of rules.values()){
    try {
      const miss = missOf(activity, attack, damage);
      miss.feature = rules.holds(rule, miss.actor, { miss });
      if(!miss.feature) continue;
      const formula = rule.formula(miss);
      if(!formula || (String(formula).trim() === "0")) continue;
      const base = damage.find(r => r.options?.type);
      const type = rule.type?.(miss) ?? base?.options.type ?? activity.item?.system.damage?.base?.types?.first?.();
      const roll = new CONFIG.Dice.DamageRoll(String(formula), miss.actor?.getRollData?.() ?? {}, { type, properties : [...(base?.options.properties ?? [])] });
      await roll.evaluate();
      if(roll.total <= 0) continue;
      roll.options[module.id] = { part : rule.id, onMiss : true, label : labelOf(rule, miss) };
      rolls.push(roll);
    } catch(error){ log.error("On-miss rule", rule.id, error); }
  }
  return rolls;
}

/* Each rule's damage under the attack once it missed and its dice have played */
function sectionsFor(message, sections, ray){
  const card = message?.system;
  if(!card?.addedRollsOf || !card.targetHits) return;
  const { targets, hits } = card.targetHits(ray);
  const missed = targets.length > hits.length;
  if(!(missed || !targets.length) || !(card.outcomeShown?.(ray, "miss") ?? true)) return;
  for(const rule of rules.values()){
    const rolls = card.addedRollsOf(ray, rule.id);
    if(!rolls.length) continue;
    sections.push({
      partial : `${module.id}.on-miss`,
      applies : true,
      context : {
        part : rule.id, icon : rule.icon ?? "fa-droplet",
        label : rolls[0].options?.[module.id]?.label ?? rule.id,
        damage : { ...card.damageContextOf(rolls), showTray : card.canApplyOn?.(ray) ?? card.canApply, onMiss : !targets.length },
        ray : Number.isInteger(ray) ? ray : "", hasRay : Number.isInteger(ray),
      },
    });
  }
}
