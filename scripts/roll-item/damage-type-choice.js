import { module } from '../module.js';
import { TYPES } from './message.js';

/**
 * The damage type lego : an attack whose damage can be one of several types, its owner choosing on the card
 * (Pact of the Blade's Necrotic, Psychic or Radiant instead of its own; a homebrew "fire or cold" weapon, a dragon's
 * claw). The card rolls it as `normal` without asking; buttons switch it to each other type.
 *
 *   MacroHelper.damageTypeChoice("pactWeapon", { applies : item => isPactWeapon(item),
 *     types : item => ["slashing", "necrotic", "psychic", "radiant"], normal : item => "slashing" });
 *
 * The same id again replaces the rule (a macro); enabled() : its setting.
 */
const rules = new Map();
let hooked = false;

export function damageTypeChoice(id, rule){
  rules.set(id, rule);
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.damageType`, (activity, { types, preset } = {}) => {
    const rule = ruleFor(activity?.item);
    if(!rule || !preset) return;
    const normal = rule.normal?.(activity.item, types);
    preset.type = (normal && types?.includes?.(normal)) ? normal : (normal ?? types?.[0]);
  });
  Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => typeButtons(message, buttons, Number.isInteger(ray) ? ray : null));
  Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => {
    if(String(id).startsWith("damageType|")) message.system.setDamageType?.(String(id).split("|")[1], Number.isInteger(ray) ? ray : null);
  });
}

function ruleFor(item){
  for(const rule of rules.values()){
    if((!rule.enabled || rule.enabled()) && item && rule.applies(item)) return rule;
  }
  return null;
}

/* Each other type : a button for the card's owner */
function typeButtons(message, buttons, ray){
  if((message.type !== TYPES.attack) || !message.isOwner) return;
  const item = message.getAssociatedItem?.();
  const rule = ruleFor(item);
  if(!rule) return;
  const rolls = Number.isInteger(ray) ? (message.system.rayDamage?.(ray) ?? []) : (message.system.damageRolls ?? []);
  const current = rolls[0]?.options?.type;
  if(!current) return;
  for(const type of [...new Set(rule.types(item))].filter(t => t && (t !== current))){
    buttons.push({ id : `damageType|${type}`, icon : rule.icon ?? "fa-wand-magic",
      label : module.format("damageType.button", { type : game.i18n.localize(CONFIG.DND5E.damageTypes[type]?.label ?? type) }) });
  }
}
