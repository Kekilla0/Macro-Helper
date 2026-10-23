import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { onHit, useOnLatestHit } from '../../roll-item/hit-bonus.js';
import { idOf } from '../../helpers/utils.js';
import { addTimedEffect } from '../../helpers/actors.js';
import { tokenOf, movedThisTurn } from '../../helpers/tokens.js';
import { alliesNear } from '../../helpers/targets.js';
import { rollModes } from '../roll-modes.js';
import { giveMode } from '../../roll-item/reasons.js';
import { uses } from '../../uses.js';
import { limits } from '../limits.js';
import { actions } from '../actions.js';
const log = logger.for(import.meta.url);

/**
 * Rogue, levels 1-2 (Classes setting). Expertise and Thieves' Cant are the items' own data; Weapon Mastery is
 * automation/weapon-mastery.js. Works from item identifiers and the class's Sneak Attack scale, whatever made the items.
 *
 *   Sneak Attack   : a hit with a Finesse or ranged weapon that had advantage, or with an ally of the Rogue (not
 *                    Incapacitated) within 5 ft of the target, and no disadvantage : its owner's Sneak Attack button on
 *                    the card rolls the class's die (the weapon's damage type, doubled on a crit) into a box of its own.
 *                    Rolling isn't using it : once a turn counts when that damage is applied to a creature; applying
 *                    another that turn follows Rule Limits, and the button stops showing. From the sheet : the latest
 *                    qualifying hit. Built on the on-hit lego (onHit, counted : "apply").
 *   Cunning Action : its Dash, Disengage or Hide uses that Default Action (actions.useDefault) as a Bonus Action.
 *                    Hide asks the GM first; nothing is spent until allowed.
 *   Steady Aim     : (level 3) only if it hasn't moved this turn (Rule Limits); then Steady Aim until the end of the
 *                    turn : advantage on its next attack roll, Speed 0.
 */
export class rogue{
  static SNEAK = "sneak-attack";
  static CUNNING = "cunning-action";
  static STEADY = "steady-aim";
  static KEY = "sneakAttack";

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* Sneak Attack : the on-hit lego, once a turn counted when its damage is applied */
    onHit({
      id : this.KEY, feature : this.SNEAK, icon : "fa-user-ninja", enabled : () => this.enabled(),
      when : hit => this.qualifies(hit),
      formula : hit => this.formulaOf(hit.actor, hit.message),
      types : hit => [[...(hit.item.system?.damage?.base?.types ?? [])][0] ?? "piercing"],
      once : "turn", counted : "apply",
      again : actor => limits.allow(module.format("classes.rogue.sneakUsed", { name : actor.name }), { who : actor.name, what : this.itemOf(actor)?.name ?? "Sneak Attack" }),
      label : hit => hit.feature?.name ?? "Sneak Attack",
      noHit : actor => module.format("classes.rogue.noHit", { name : actor?.name ?? "" }),
    });
    /* Sneak Attack used from the sheet : the latest qualifying hit */
    uses.onItem("sneak", (item, ctx, next) => {
      if(!this.enabled() || (idOf(item) !== this.SNEAK) || !item.actor) return next();
      return useOnLatestHit(this.KEY, item.actor);
    });
    /* Cunning Action : the Default Action itself (Dash, Disengage, Hide), as a Bonus Action; Hide asks the GM first */
    uses.onActivity("cunningAction", (activity, ctx, next) => {
      const id = this.cunningOf(activity);
      if(!id || !activity.actor?.isOwner) return next();
      return actions.useDefault(activity.getUsageToken?.()?.actor ?? activity.actor, id, { economy : "bonus" });
    });
    /* Steady Aim */
    Hooks.on("dnd5e.preUseActivity", activity => this.steadyCheck(activity));
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && (idOf(activity?.item) === this.STEADY)));
    Hooks.on("dnd5e.postUseActivity", activity => this.steadyAim(activity));
    rollModes.add("steadyAim", config => this.steadyMode(config));
    Hooks.on("dnd5e.rollAttackV2", (rolls, { subject } = {}) => this.steadySpent(subject?.actor));
  }

  /* ---------- Steady Aim ---------- */

  static steadyOf(actor){
    return actor?.effects?.find?.(e => e.getFlag(module.id, "steadyAim")) ?? null;
  }

  /* Not after moving this turn */
  static steadyCheck(activity){
    if(!this.enabled() || (idOf(activity?.item) !== this.STEADY) || !game.combat?.started) return;
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    const token = tokenOf(actor);
    if(token && (movedThisTurn(token) > 0)
      && !limits.allow(module.format("classes.rogue.steadyMoved", { name : actor.name }), { who : actor.name, what : activity.item.name })) return false;
  }

  /* Advantage on the next attack this turn, Speed 0 until the turn ends */
  static async steadyAim(activity){
    if(!this.enabled() || (idOf(activity?.item) !== this.STEADY) || !activity.actor?.isOwner) return;
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    if(this.steadyOf(actor)) return;
    await addTimedEffect(actor, { name : activity.item.name, img : activity.item.img, origin : activity.item.uuid,
      changes : ["walk", "fly", "climb", "swim", "burrow"].map(kind => ({ key : `system.attributes.movement.speeds.${kind}`, type : "override", mode : 5, value : "0" })),
      flags : { [module.id] : { steadyAim : { used : false } } } }, { until : "turnEnd", thisTurn : true });
  }

  static steadyMode(config){
    const effect = this.enabled() ? this.steadyOf(config.subject?.actor) : null;
    if(effect && !effect.getFlag(module.id, "steadyAim")?.used && config.rolls?.[0]) giveMode(config.rolls[0], "advantage", effect.name);
  }

  /* Its advantage is used by the attack (the Speed 0 stays to the end of the turn) */
  static async steadySpent(actor){
    const effect = this.enabled() ? this.steadyOf(actor) : null;
    if(effect?.isOwner && !effect.getFlag(module.id, "steadyAim")?.used) await effect.setFlag(module.id, "steadyAim", { used : true });
  }

  /* ---------- Sneak Attack ---------- */

  static itemOf(actor){
    return actor?.items?.find?.(i => idOf(i) === this.SNEAK) ?? null;
  }

  /* The class's die : its Sneak Attack scale, else by Rogue level (1d6 at 1-2, +1d6 every odd level); and what other
     rules add to it (the Assassin's Rogue level in the first round) : Hooks "macro-helper.sneakAttack" (actor, message, parts) */
  static formulaOf(actor, message = null){
    const scale = actor?.system?.scale?.rogue?.["sneak-attack"];
    const level = Number(actor?.classes?.rogue?.system?.levels) || 1;
    const parts = [scale?.formula || (scale?.faces ? `${scale.number ?? 1}d${scale.faces}` : `${Math.ceil(level / 2)}d6`)];
    if(message) Hooks.callAll(`${module.id}.sneakAttack`, actor, message, parts);
    return parts.filter(Boolean).join(" + ");
  }

  /* An ally of the attacker (not it, not Incapacitated) within 5 ft of the target */
  static allyNear(attacker, target){
    return alliesNear(target, attacker, { feet : 5 }).length > 0;
  }

  /* Does this hit allow Sneak Attack : a Finesse or ranged weapon attack, advantage or an ally by the target, no disadvantage */
  static qualifies(hit){
    if((hit.activity?.type !== "attack") || !hit.weapon || (!hit.finesse && !hit.ranged) || hit.disadvantage) return false;
    return hit.advantage || !!(hit.target && hit.token && this.allyNear(hit.token, hit.target));
  }

  /* ---------- Cunning Action ---------- */

  /* Which Default Action a Cunning Action activity is : "dash", "disengage", "hide" or null */
  static cunningOf(activity){
    if(!this.enabled() || (idOf(activity?.item) !== this.CUNNING)) return null;
    const name = String(activity?.name ?? "").toLowerCase();
    return ["dash", "disengage", "hide"].find(id => name.includes(id)) ?? null;
  }
}
