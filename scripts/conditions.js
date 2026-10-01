import { settings } from './settings.js';
import { logger } from './log.js';
const log = logger.for(import.meta.url);

/**
 * Condition rules dnd5e lists but doesn't apply. dnd5e 6 puts Poisoned (and, with 2014 rules, Exhaustion 3) in
 * CONFIG.DND5E.conditionEffects.attackDisadvantage, and Heavily Encumbered in physicalAttackDisadvantage, yet only
 * ability checks and saves read those lists : attack rolls never get the disadvantage.
 * This adds it to every dnd5e attack roll (sheet, chat card, Roll Item, pickAndAttack). It combines with advantage like
 * any other disadvantage : both = a normal roll. It follows the condition, from the Poisoned condition itself or from
 * any effect that gives the status (an effect whose Statuses include Poisoned).
 */
export class conditions{
  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.preRollAttackV2", config => this.onPreRollAttack(config));
  }

  static onPreRollAttack(config){
    if(!settings.value("conditionAttacks")) return;
    const actor = config.subject?.actor;
    if(!this.hasAttackDisadvantage(actor, config.ability)) return;

    const roll = config.rolls?.[0];
    if(!roll) return;
    roll.options ??= {};
    roll.options.disadvantage = true;
    log.debug("Condition disadvantage on attack", actor.name);
  }

  /**
   * Does a condition give this actor disadvantage on its attack rolls ?
   * @param {Actor} actor
   * @param {string} [ability]  the attack's ability, for conditions that only hit Strength / Dexterity attacks
   * @returns {boolean}
   */
  static hasAttackDisadvantage(actor, ability){
    if(typeof actor?.hasConditionEffect !== "function") return false;
    if(actor.hasConditionEffect("attackDisadvantage")) return true;
    const physical = CONFIG.DND5E.abilities[ability]?.type === "physical";
    return physical && actor.hasConditionEffect("physicalAttackDisadvantage");
  }
}
