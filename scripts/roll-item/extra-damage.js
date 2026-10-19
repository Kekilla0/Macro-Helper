import { module } from '../module.js';
import { waitFor } from '../helpers/utils.js';

/**
 * The extra-damage legos.
 *   damageRoll(formula, { type, crit, magical, rollData })   every extra damage roll : typed, doubled on a crit
 *   card.extraDamage(formula, { key, type, label, ray })      onto an attack card (message.js), once per key per attack
 *   eachAttack(card, fn)                                     each attack on a card once its damage is shown, with its targets
 */

/**
 * An extra damage roll, evaluated (Hunter's Mark's 1d6, Sneak Attack, a monster's extra damage).
 * @param {string} formula
 * @param {object} [options]
 * @param {string|null} [options.type]     its damage type
 * @param {boolean} [options.crit=false]   a critical hit : its dice doubled
 * @param {boolean} [options.magical=false] magical damage (a spell's)
 * @param {object} [options.rollData]      for @ references (@mod, @prof)
 * @returns {Promise<DamageRoll>}
 */
export async function damageRoll(formula, { type = null, crit = false, magical = false, rollData = {} } = {}){
  const roll = new CONFIG.Dice.DamageRoll(String(formula), rollData ?? {}, { type, types : type ? [type] : [], isCritical : !!crit,
    properties : magical ? ["mgc"] : [] });
  return roll.evaluate();
}

/**
 * Each attack on an attack card, once Roll Item has shown its damage (a staged card waits), with the tokens it was
 * aimed at : fn(card, ray, tokens). ray : the attack on a multi-attack card, else null. Hunter's Mark and Hex use it.
 * @param {ChatMessage} message
 * @param {(card : ChatMessage, ray : number|null, tokens : TokenDocument[]) => Promise<void>} fn
 */
export async function eachAttack(message, fn){
  if(message?.getFlag?.(module.id, "reveal") !== undefined){
    await waitFor(() => (game.messages.get(message.id)?.getFlag(module.id, "reveal") ?? 2) >= 2, { timeout : 15000 });
    message = game.messages.get(message.id) ?? message;
  }
  const system = message?.system;
  if(!system?.targetsOf) return;
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  const rays = system.isMulti ? system.rays.map((_, i) => i) : [null];
  for(const ray of rays){
    const tokens = (system.targetsOf(ray) ?? []).map(t => TargetsField.resolve(t)?.token).filter(Boolean);
    await fn(message, ray, tokens);
  }
}
