import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { tokenOf, distanceBetween, canSee } from '../helpers/tokens.js';
import { clearLastDamage, isKilledOutright } from '../helpers/actors.js';
import { giveMode, noteReason, conditionName, logReasons } from '../roll-item/reasons.js';
const log = logger.for(import.meta.url);

/**
 * Condition rules dnd5e doesn't apply, on its own rolls (sheet, chat cards, Roll Item, pickAndAttack alike).
 *
 * Conditions on Attack Rolls : dnd5e 6 puts Poisoned (and, with 2014 rules, Exhaustion 3) in
 * CONFIG.DND5E.conditionEffects.attackDisadvantage, and Heavily Encumbered in physicalAttackDisadvantage, yet only
 * ability checks and saves read those lists. This adds the disadvantage to attack rolls.
 *
 * Condition & Downed Rules :
 *   attacks against a Blinded, Paralyzed, Petrified, Restrained, Stunned or Unconscious creature have advantage;
 *   against a Prone one, advantage within 5 ft and disadvantage beyond; against an Invisible one, disadvantage.
 *   An attacker who is Blinded, Prone or Restrained has disadvantage; one who is Invisible, advantage.
 *   A hit on a Paralyzed or Unconscious creature from within 5 ft is a critical hit (autoCrit, used for the damage).
 *   A character at 0 HP who takes damage fails a death save (two on a crit, once per card); a hit of at least its HP
 *   max, or massive damage while still up, is three failures. Three failures : Dead.
 *
 * Applied damage : each creature remembers the last damage it took and the card that dealt it (getLastDamage), until a
 * reaction uses it (clearLastDamage) or it rests, and what a card last applied to it (shown on the card's row).
 *
 * Every attack's advantage / disadvantage reasons are logged once rolled (roll-item/reasons.js).
 */
export class conditions{
  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.preRollAttackV2", config => this.onPreRollAttack(config));
    Hooks.on("dnd5e.rollAttackV2", (rolls, { subject } = {}) => logReasons(subject, rolls?.[0]));
    Hooks.on("dnd5e.applyDamage", (actor, amount, options) => this.onApplyDamage(actor, amount, options));
    Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => this.onPreApplyDamage(actor, amount, updates, options));
    Hooks.on("dnd5e.preRollSavingThrowV2", (config, dialog, message) => this.onPreRollSave(config, message));
    Hooks.on("dnd5e.preRollDeathSaveV2", config => this.onPreRollDeathSave(config));
    Hooks.on("updateActor", (actor, changes) => this.onHPChange(actor, changes));
    /* A rest is well past any reaction to a hit : forget it */
    Hooks.on("dnd5e.restCompleted", actor => clearLastDamage(actor));
  }

  static onPreRollAttack(config){
    const actor = config.subject?.actor;
    const roll = config.rolls?.[0];
    if(!actor || !roll) return;
    roll.options ??= {};

    /* Reasons given with the roll (Roll Item : chosen, keys, long range...) */
    for(const { mode, reason } of config[module.id]?.reasons ?? []) noteReason(roll, mode, reason);

    if(settings.value("conditionAttacks") && this.hasAttackDisadvantage(actor, config.ability)){
      giveMode(roll, "disadvantage", module.format("reasons.attackerIs", { condition : this.disadvantageConditions(actor).join(", ") || module.i18n("reasons.conditions") }));
    }

    if(settings.value("downedRules")) this.applyConditionRules(config, roll);
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

  /* The token an attack is aimed at : Roll Item says, else your one target */
  static targetOf(config){
    const given = config?.[module.id]?.target;
    if(given) return fromUuidSync(given, { strict : false })?.object ?? null;
    return (game.user.targets.size === 1) ? game.user.targets.first() : null;
  }


  /* ---------- Conditions on attacks, auto-crits, death saves ---------- */

  static AGAINST_ADVANTAGE = ["blinded", "paralyzed", "petrified", "restrained", "stunned", "unconscious"];
  static ATTACKER_DISADVANTAGE = ["blinded", "prone", "restrained"];
  static AUTO_CRIT = ["paralyzed", "unconscious"];

  /* Within 5 ft (one grid unit) of each other */
  static within5(a, b){
    return !!a && !!b && (distanceBetween(a, b) <= (canvas.scene?.grid.distance ?? 5));
  }

  static applyConditionRules(config, roll){
    const activity = config.subject;
    const attacker = tokenOf(activity?.actor);
    const mine = activity?.actor?.statuses ?? new Set();
    const is = id => module.format("reasons.attackerIs", { condition : conditionName(id) });
    const their = id => module.format("reasons.targetIs", { condition : conditionName(id) });
    for(const id of this.ATTACKER_DISADVANTAGE.filter(s => mine.has(s))) giveMode(roll, "disadvantage", is(id));
    if(mine.has("invisible")) giveMode(roll, "advantage", is("invisible"));

    const target = this.targetOf(config);
    const theirs = target?.actor?.statuses;
    if(!theirs) return;
    for(const id of this.AGAINST_ADVANTAGE.filter(s => theirs.has(s))) giveMode(roll, "advantage", their(id));
    if(theirs.has("prone")){
      if(this.within5(attacker, target)) giveMode(roll, "advantage", module.i18n("reasons.proneNear"));
      else giveMode(roll, "disadvantage", module.i18n("reasons.proneFar"));
    }
    if(theirs.has("invisible")) giveMode(roll, "disadvantage", their("invisible"));
    /* Sight, worked out once for this roll */
    const sees = attacker ? { target : canSee(attacker, target), attacker : canSee(target, attacker) } : { target : true, attacker : true };
    log.debug("Sight", attacker?.name, "sees", target.name, sees.target, "|", target.name, "sees", attacker?.name, sees.attacker);
    /* Dodging : only against an attacker it can see */
    if(theirs.has("dodging") && sees.attacker) giveMode(roll, "disadvantage", their("dodging"));
    this.applySight(attacker, target, mine, theirs, roll, sees);
  }

  /**
   * Sight (Vision Rules) : attacking a creature you can't see has disadvantage; attacking one that can't see you has
   * advantage. Blinded and Invisible already say so above; this adds darkness, walls and no darkvision.
   */
  static applySight(attacker, target, mine, theirs, roll, sees){
    if(!attacker || !target) return;
    sees ??= { target : canSee(attacker, target), attacker : canSee(target, attacker) };
    const explained = s => mine.has("blinded") || theirs.has(s);
    if(!sees.target && !explained("invisible")) giveMode(roll, "disadvantage", module.i18n("reasons.cantSeeTarget"));
    if(!sees.attacker && !theirs.has("blinded") && !mine.has("invisible")) giveMode(roll, "advantage", module.i18n("reasons.unseenAttacker"));
  }

  /* ---------- Saves : automatic failures, outcomes ---------- */

  static AUTO_FAIL = ["paralyzed", "petrified", "stunned", "unconscious"];

  /**
   * Does a creature automatically fail this save ? STR and DEX saves while Paralyzed, Petrified, Stunned or Unconscious.
   * @param {Actor} actor
   * @param {string} ability
   * @returns {string|null}  the condition's name
   */
  static autoFailOf(actor, ability){
    if(!settings.value("downedRules") || !["str", "dex"].includes(ability)) return null;
    const id = this.AUTO_FAIL.find(s => actor?.statuses?.has(s));
    return id ? conditionName(id) : null;
  }

  /* An automatic failure is still rolled (so it's logged and linked to its card), and marked : it fails whatever the d20 */
  static onPreRollSave(config, message){
    const name = this.autoFailOf(config.subject, config.ability);
    if(!name || !message) return;
    foundry.utils.setProperty(message, `data.flags.${module.id}.autoFail`, name);
    log.debug("Automatic save failure", config.subject?.name, config.ability, name);
  }

  /**
   * How a save message turned out, for everything reading it (card rows, Grapple / Shove, dnd5e's damage tray).
   * @param {ChatMessage} message   a dnd5e save message
   * @returns {{ total : number, success : boolean, auto : string|null }|null}  null when it has no d20 roll
   */
  static saveOutcome(message){
    const [roll] = message?.rolls ?? [];
    if(!(roll instanceof CONFIG.Dice.D20Roll)) return null;
    const auto = message.getFlag?.(module.id, "autoFail") ?? null;
    return { total : roll.total, success : !auto && !!(roll.isSuccess || message.system?.forceSuccess), auto };
  }

  /* ---------- Stable ---------- */

  /* A Stable creature makes no death saves */
  static onPreRollDeathSave(config){
    const actor = config.subject;
    if(!actor?.statuses?.has("stable")) return;
    ui.notifications.info(module.format("actions.stabilize.noSave", { name : actor.name }));
    return false;
  }

  /* Stable ends when it regains HP or takes damage */
  static async onHPChange(actor, changes){
    if(!actor?.isOwner || !actor.statuses?.has("stable")) return;
    const hp = foundry.utils.getProperty(changes ?? {}, "system.attributes.hp.value");
    if(hp === undefined) return;
    /* One client does it : the active GM, or the owner when no GM is on */
    if(!(game.users.activeGM ? game.users.activeGM.isSelf : true)) return;
    await actor.toggleStatusEffect("stable", { active : false });
  }

  /* The attacker's conditions dnd5e says give attacks disadvantage (Poisoned, Frightened, Exhaustion...) */
  static disadvantageConditions(actor){
    const effects = CONFIG.DND5E?.conditionEffects ?? {};
    const ids = new Set([...(effects.attackDisadvantage ?? []), ...(effects.physicalAttackDisadvantage ?? [])]);
    return [...(actor?.statuses ?? [])].filter(s => ids.has(s)).map(s => conditionName(s));
  }

  /**
   * The attacker's own conditions that give every attack disadvantage (whoever it's aimed at), for the pick map.
   * None when it's Invisible too (advantage cancels it out).
   * @param {Actor} actor
   * @param {string} [ability]
   * @returns {string[]}  condition names
   */
  static attackerDisadvantages(actor, ability){
    if(game.system.id !== "dnd5e" || !actor) return [];
    const statuses = actor.statuses ?? new Set();
    const downed = settings.value("downedRules");
    if(downed && statuses.has("invisible")) return [];
    const names = downed ? this.ATTACKER_DISADVANTAGE.filter(s => statuses.has(s)).map(s => conditionName(s)) : [];
    if(settings.value("conditionAttacks") && this.hasAttackDisadvantage(actor, ability)){
      names.push(...(this.disadvantageConditions(actor).length ? this.disadvantageConditions(actor) : [module.i18n("reasons.conditions")]));
    }
    return [...new Set(names)];
  }

  /**
   * Is this hit a critical hit because of its target : Paralyzed or Unconscious, the attacker within 5 ft ?
   * The target is the token the attack was aimed at (Roll Item notes it on the roll).
   * @param {Activity} activity
   * @param {D20Roll} attack
   * @returns {boolean}
   */
  static autoCrit(activity, attack){
    if(!settings.value("downedRules") || !attack || attack.isCritical || attack.isFumble) return false;
    const uuid = attack.options?.[module.id]?.target;
    const target = uuid ? fromUuidSync(uuid, { strict : false })?.object : null;
    if(!target?.actor || !this.AUTO_CRIT.some(s => target.actor.statuses?.has(s))) return false;
    const ac = attack.options?.target;
    if(Number.isFinite(ac) && (attack.total < ac)) return false;
    return this.within5(tokenOf(activity?.actor), target);
  }

  /* Did the card that dealt this damage roll it as a crit ? */
  static wasCritical(origin){
    return !!origin?.rolls?.some?.(r => r?.options?.isCritical);
  }

  /* Death saves : damage to a character at 0 HP is a failure (two on a crit); its HP max in one hit, or massive damage
     while still up, is three. Changes dnd5e's pending update, nothing awaited. */
  static onPreApplyDamage(actor, amount, updates, options = {}){
    if(!settings.value("downedRules") || (actor?.type !== "character") || !(amount > 0) || !updates) return;
    const hp = actor.system.attributes?.hp ?? {};
    const death = actor.system.attributes?.death ?? {};
    const max = Number(hp.max) || 0;
    const key = "system.attributes.death.failure";
    if((Number(hp.value) || 0) <= 0){
      if(actor.statuses?.has("stable") && actor.isOwner) actor.toggleStatusEffect("stable", { active : false });
      if(!(max > 0)) return;
      const hurt = amount - (Number(hp.temp) || 0);
      if(hurt <= 0) return;
      /* One hit, one failure : more damage from the same card (its other parts, a rider) doesn't add more */
      const last = actor.getFlag?.(module.id, "lastDamage");
      if(options.origin?.id && (last?.message === options.origin.id)) return;
      updates[key] = (hurt >= max) ? 3 : Math.min(3, (Number(death.failure) || 0) + (this.wasCritical(options.origin) ? 2 : 1));
      log.debug("Death save failures", actor.name, updates[key]);
    }
    else if(isKilledOutright(actor, amount)){
      updates[key] = 3;
      log.debug("Massive damage", actor.name);
    }
  }

  /* Remember the last damage a creature took and the card it came from (Stone's Endurance...); what was applied from
     a card (damage or healing) shows on its row; a third death save failure means Dead */
  static async onApplyDamage(actor, amount, options = {}){
    if(!amount || !actor?.isOwner) return;
    const message = options.origin?.id ?? null;
    const update = {};
    if(amount > 0) update[`flags.${module.id}.lastDamage`] = { amount, message, at : Date.now() };
    /* By card and part ("rows", "hits", dnd5e's "tray") : shown on the card, and applied only once */
    if(message){
      const part = options[module.id]?.part ?? "tray";
      update[`flags.${module.id}.applied.${message}.${part}`] = amount;
      /* Only the last cards are kept */
      const cards = Object.keys(actor.getFlag?.(module.id, "applied") ?? {}).filter(id => id !== message);
      for(const old of cards.slice(0, Math.max(0, cards.length - (this.APPLIED_KEPT - 1)))){
        update[`flags.${module.id}.applied.${old}`] = globalThis._del ?? new foundry.data.operators.ForcedDeletion();
      }
    }
    if(Object.keys(update).length) await actor.update(update);
    await this.markDead(actor);
  }

  /* How many cards' applied amounts a creature remembers */
  static APPLIED_KEPT = 30;

  /* Three death save failures : Dead (dnd5e only does it in combat, with its downed setting on "all creatures") */
  static async markDead(actor){
    if(!settings.value("downedRules") || (actor?.type !== "character") || !actor.isOwner) return;
    if((Number(actor.system.attributes?.death?.failure) || 0) < 3 || actor.statuses?.has("dead")) return;
    await actor.toggleStatusEffect("dead", { active : true, overlay : true });
    log.debug("Dead", actor.name);
  }
}
