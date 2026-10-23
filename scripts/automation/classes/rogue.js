import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { onHit, useOnLatestHit } from '../../roll-item/hit-bonus.js';
import { idOf, esc, ownerIds, gmIds, buttonRow, addButton, makeButton } from '../../helpers/utils.js';
import { setStatus, addTimedEffect } from '../../helpers/actors.js';
import { tokenOf, distanceBetween, canSee, movedThisTurn } from '../../helpers/tokens.js';
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
 *   Cunning Action : Dash and Disengage are the Default Actions' marks. Hide (2024 : Heavily Obscured or behind three-
 *                    quarters / total cover, out of enemies' sight) asks the GM first : a card naming the enemies whose
 *                    tokens see the Rogue, with Allow / Deny; allowed, its owner rolls DEX (Stealth) against DC 15 (a
 *                    reroll counts) and is Invisible on a success, until the GM ends it. Nothing is used (the activity,
 *                    its Bonus Action) until the GM allows it. On the Rogue's own token.
 *   Steady Aim     : (level 3) only if it hasn't moved this turn (Rule Limits); then Steady Aim until the end of the
 *                    turn : advantage on its next attack roll, Speed 0.
 */
export class rogue{
  static SNEAK = "sneak-attack";
  static CUNNING = "cunning-action";
  static STEADY = "steady-aim";
  static KEY = "sneakAttack";
  static OUT = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];

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
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.onCunning(activity, usage, results));
    /* Hide : nothing is used until the GM allows it (a denied Hide costs nothing) */
    uses.onActivity("hide", async (activity, ctx, next) => {
      if(!this.isHide(activity) || ctx.config?.[module.id]?.hideAllowed || !activity.actor?.isOwner) return next();
      await this.hide(activity.getUsageToken?.()?.actor ?? activity.actor, activity);
    });
    /* Hide : the GM's Allow / Deny, then the owner's Stealth roll; a reroll to 15+ hides too */
    Hooks.on("renderChatMessageHTML", (message, html) => this.hideButtons(message, html));
    Hooks.on("updateChatMessage", (message, changes, options, userId) => this.onHideReroll(message, changes, userId));
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
    const side = attacker?.document?.disposition;
    return (canvas.tokens?.placeables ?? []).some(t => (t !== attacker) && (t !== target) && t.actor && (t.document.disposition === side)
      && !this.OUT.some(s => t.actor.statuses?.has?.(s)) && (distanceBetween(t, target) <= 5));
  }

  /* Does this hit allow Sneak Attack : a Finesse or ranged weapon attack, advantage or an ally by the target, no disadvantage */
  static qualifies(hit){
    if((hit.activity?.type !== "attack") || !hit.weapon || (!hit.finesse && !hit.ranged) || hit.disadvantage) return false;
    return hit.advantage || !!(hit.target && hit.token && this.allyNear(hit.token, hit.target));
  }

  /* ---------- Cunning Action ---------- */

  static isHide(activity){
    return this.enabled() && (idOf(activity?.item) === this.CUNNING) && String(activity?.name ?? "").toLowerCase().includes("hide");
  }

  static async onCunning(activity, usage, results){
    const actor = activity?.actor;
    if(!this.enabled() || (idOf(activity?.item) !== this.CUNNING) || !actor?.isOwner) return;
    const own = activity.getUsageToken?.()?.actor ?? actor;
    const name = String(activity.name ?? "").toLowerCase();
    if(name.includes("dash")) await actions.mark(own, "dash", "actions.dash.mark", "icons/skills/movement/feet-winged-boots-glowing-yellow.webp");
    else if(name.includes("disengage")) await actions.mark(own, "disengage", "actions.disengage.mark", "icons/skills/movement/arrow-upward-yellow.webp");
    /* Hide, used once the GM allowed it : the Stealth roll */
    else if(name.includes("hide")) await this.rollHide(own);
    else return;
    await actions.autoApplied(results);
  }

  /* ---------- Hide ---------- */

  /* Enemies whose tokens see this one (the vision rules) */
  static seenBy(token){
    const side = token?.document?.disposition;
    return (canvas.tokens?.placeables ?? []).filter(t => (t !== token) && t.actor && (t.document.disposition !== side)
      && (t.document.disposition !== CONST.TOKEN_DISPOSITIONS?.NEUTRAL) && !this.OUT.some(st => t.actor.statuses?.has?.(st)) && canSee(t, token));
  }

  /* Hide asked for : the GM decides (Heavily Obscured or in cover, out of sight), on a card for the GM and the owner.
     Nothing used yet : allowed, the owner's button uses the Hide activity (dnd5e's card, the Stealth roll) */
  static async hide(actor, activity = null){
    const token = tokenOf(actor);
    const seen = token ? this.seenBy(token).map(t => t.name) : [];
    const lines = [`<p>${esc(module.format("classes.rogue.hideAsk", { name : actor.name }))}</p>`,
      `<p class="hint">${esc(seen.length ? module.format("classes.rogue.seenBy", { names : seen.join(", ") }) : module.i18n("classes.rogue.unseen"))}</p>`];
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }), content : lines.join(""),
      whisper : [...new Set([...ownerIds(actor), ...gmIds()])],
      flags : { [module.id] : { hide : { actor : actor.uuid, activity : activity?.uuid ?? null, state : "asked" } } },
    });
  }

  static hideButtons(message, html){
    const hide = message.getFlag?.(module.id, "hide");
    if(!hide) return;
    const actor = fromUuidSync(hide.actor ?? "", { strict : false });
    const row = buttonRow(html, { key : `${module.id}-hide` });
    if(row.childElementCount) return;
    if(hide.state === "asked" && game.user.isGM){
      addButton(row, makeButton({ icon : "fa-check", text : module.i18n("classes.rogue.allow"), once : true,
        onClick : () => message.setFlag(module.id, "hide", { ...hide, state : "allowed" }) }));
      addButton(row, makeButton({ icon : "fa-xmark", text : module.i18n("classes.rogue.deny"), once : true,
        onClick : () => message.setFlag(module.id, "hide", { ...hide, state : "denied" }) }));
    }
    else if(hide.state === "allowed" && actor?.isOwner){
      addButton(row, makeButton({ icon : "fa-user-secret", text : module.i18n("classes.rogue.rollStealth"), once : true,
        onClick : async () => {
          const activity = hide.activity ? fromUuidSync(hide.activity, { strict : false }) : null;
          if(activity) await activity.use({ [module.id] : { hideAllowed : true } });
          else await this.rollHide(actor);
          await message.setFlag(module.id, "hide", { ...hide, state : "used" });
        } }));
    }
    else if(hide.state === "denied"){
      const p = document.createElement("p");
      p.textContent = module.i18n("classes.rogue.denied");
      row.append(p);
    }
  }

  /* 2024 Hide : DEX (Stealth) against DC 15; a success : Invisible, until the GM ends it (found, attacked, made noise) */
  static async rollHide(actor){
    const [roll] = await actor.rollSkill({ skill : "ste", target : 15 }, { configure : false },
      { data : { flags : { [module.id] : { hideRoll : actor.uuid } } } }) ?? [];
    if(roll) await this.hidden(actor, roll.total);
  }

  static async hidden(actor, total){
    if(total >= 15){
      await setStatus(actor, "invisible", true);
      ui.notifications.info(module.format("classes.rogue.hidden", { name : actor.name }));
      return true;
    }
    ui.notifications.info(module.format("classes.rogue.notHidden", { name : actor.name }));
    return false;
  }

  /* The Stealth roll rerolled to 15+ : hidden after all */
  static async onHideReroll(message, changes, userId){
    const uuid = message.getFlag?.(module.id, "hideRoll");
    if(!uuid || (userId !== game.user.id) || !("rolls" in (changes ?? {})) || message.getFlag(module.id, "hid")) return;
    const total = message.rolls?.[0]?.total ?? 0;
    if(total < 15) return;
    const actor = fromUuidSync(uuid, { strict : false });
    if(!actor?.isOwner) return;
    if(message.isOwner) await message.setFlag(module.id, "hid", true);
    await this.hidden(actor, total);
  }
}
