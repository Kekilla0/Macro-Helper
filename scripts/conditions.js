import { module } from './module.js';
import { settings } from './settings.js';
import { logger } from './log.js';
import { tokenOf } from './helpers/tokens.js';
import { getFlanker } from './helpers/targets.js';
import { getSaveAdvantages } from './helpers/actors.js';
const log = logger.for(import.meta.url);

/**
 * Rules applied to dnd5e's own rolls (sheet, chat cards, Roll Item, pickAndAttack alike).
 *
 * Conditions on attack rolls : dnd5e 6 puts Poisoned (and, with 2014 rules, Exhaustion 3) in
 * CONFIG.DND5E.conditionEffects.attackDisadvantage, and Heavily Encumbered in physicalAttackDisadvantage, yet only
 * ability checks and saves read those lists. This adds the disadvantage to attack rolls.
 *
 * Saves against conditions : features like Brave ("Advantage on saving throws you make to avoid or end the Frightened
 * condition") give advantage on a save rolled from a card whose activity applies that condition. A save rolled with
 * nothing saying what it's for (straight from the sheet) can't be told apart, it stays a normal roll.
 *
 * Flanking (Homebrew) : melee attacks against a creature with an ally on its opposite side get advantage or +2.
 */
export class conditions{
  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.preRollAttackV2", config => this.onPreRollAttack(config));
    Hooks.on("dnd5e.preRollSavingThrowV2", (config, dialog, message) => this.onPreRollSave(config, message));
  }

  static onPreRollAttack(config){
    const actor = config.subject?.actor;
    const roll = config.rolls?.[0];
    if(!actor || !roll) return;
    roll.options ??= {};

    if(settings.value("conditionAttacks") && this.hasAttackDisadvantage(actor, config.ability)){
      roll.options.disadvantage = true;
      log.debug("Condition disadvantage on attack", actor.name);
    }

    const flanking = settings.value("homebrewFlanking");
    if(flanking && (flanking !== "off")) this.applyFlanking(config, roll, flanking);
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

  /* ---------- Flanking ---------- */

  /* The token an attack is aimed at : Roll Item says, else your one target */
  static targetOf(config){
    const given = config?.[module.id]?.target;
    if(given) return fromUuidSync(given, { strict : false })?.object ?? null;
    return (game.user.targets.size === 1) ? game.user.targets.first() : null;
  }

  static applyFlanking(config, roll, mode){
    const activity = config.subject;
    const melee = String(activity.getActionType?.(config.attackMode) ?? "").startsWith("m");
    if(!melee) return;
    const attacker = tokenOf(activity.actor), target = this.targetOf(config);
    if(!attacker || !target) return;
    const flanker = getFlanker(attacker, target);
    if(!flanker) return;

    if(mode === "advantage") roll.options.advantage = true;
    else if(mode === "bonus"){
      roll.parts = [...(roll.parts ?? []), "@flanking"];
      roll.data = { ...(roll.data ?? {}), flanking : 2 };
    }
    log.debug("Flanking", attacker.name, "with", flanker.name, "against", target.name, mode);
  }

  /* ---------- Saves against conditions ---------- */

  /* Conditions the card's activity (and its on-hit rider) puts on whoever fails */
  static conditionsFrom(card){
    const found = new Set();
    const activity = card?.getAssociatedActivity?.();
    const activities = [activity, card?.system?.riderActivity].filter(Boolean);
    for(const a of activities){
      for(const link of a.applicableEffects ?? []){
        const effect = link.uuid ? fromUuidSync(link.uuid, { strict : false }) : a.item?.effects.get(link._id);
        for(const status of effect?.statuses ?? []) found.add(status);
        for(const status of effect?.system?.rider?.statuses ?? []) found.add(status);
      }
    }
    return found;
  }

  static onPreRollSave(config, message){
    if(!settings.value("conditionSaves")) return;
    const actor = config.subject;
    const card = game.messages.get(message?.data?.system?.origin);
    if(!actor || !card) return;

    const against = this.conditionsFrom(card);
    if(!against.size) return;
    const advantages = getSaveAdvantages(actor);
    const match = [...against].find(c => advantages.has(c));
    if(!match) return;

    config.advantage = true;
    log.debug("Save advantage against", match, actor.name);
  }
}
