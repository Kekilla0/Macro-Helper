import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf, esc, ownerIds, gmIds, buttonRow, addButton, makeButton } from '../../helpers/utils.js';
import { usedThisTurn, markUsedThisTurn, setStatus } from '../../helpers/actors.js';
import { tokenOf, distanceBetween, canSee } from '../../helpers/tokens.js';
import { uses } from '../../uses.js';
import { limits } from '../limits.js';
import { actions } from '../actions.js';
import { TYPES } from '../../roll-item/message.js';
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
 *                    qualifying hit.
 *   Cunning Action : Dash and Disengage are the Default Actions' marks. Hide (2024 : Heavily Obscured or behind three-
 *                    quarters / total cover, out of enemies' sight) asks the GM first : a card naming the enemies whose
 *                    tokens see the Rogue, with Allow / Deny; allowed, its owner rolls DEX (Stealth) against DC 15 (a
 *                    reroll counts) and is Invisible on a success, until the GM ends it. Nothing is used (the activity,
 *                    its Bonus Action) until the GM allows it. On the Rogue's own token.
 */
export class rogue{
  static SNEAK = "sneak-attack";
  static CUNNING = "cunning-action";
  static KEY = "sneakAttack";
  static OUT = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => this.cardButtons(message, buttons, context));
    Hooks.on(`${module.id}.cardButton`, (message, id, context) => { if(id === "sneak") this.sneak(message, context?.ray ?? null); });
    /* Applied to a creature : that's the turn's Sneak Attack */
    Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => this.onApply(options));
    /* Sneak Attack used from the sheet : the latest qualifying hit */
    uses.onItem("sneak", (item, ctx, next) => {
      if(!this.enabled() || (idOf(item) !== this.SNEAK) || !item.actor) return next();
      return this.sneakFromSheet(item.actor);
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
  }

  /* ---------- Sneak Attack ---------- */

  static itemOf(actor){
    return actor?.items?.find?.(i => idOf(i) === this.SNEAK) ?? null;
  }

  /* The class's die : its Sneak Attack scale, else by Rogue level (1d6 at 1-2, +1d6 every odd level) */
  static formulaOf(actor){
    const scale = actor?.system?.scale?.rogue?.["sneak-attack"];
    if(scale?.formula) return scale.formula;
    if(scale?.faces) return `${scale.number ?? 1}d${scale.faces}`;
    const level = Number(actor?.classes?.rogue?.system?.levels) || 1;
    return `${Math.ceil(level / 2)}d6`;
  }

  /* An ally of the attacker (not it, not Incapacitated) within 5 ft of the target */
  static allyNear(attacker, target){
    const side = attacker?.document?.disposition;
    return (canvas.tokens?.placeables ?? []).some(t => (t !== attacker) && (t !== target) && t.actor && (t.document.disposition === side)
      && !this.OUT.some(s => t.actor.statuses?.has?.(s)) && (distanceBetween(t, target) <= 5));
  }

  /**
   * Does this hit on the card allow Sneak Attack : a Finesse or ranged weapon, advantage or an ally by the target,
   * no disadvantage.
   * @returns {Token|null}  the creature hit, when it does
   */
  static qualifies(message, ray){
    const card = message?.system;
    if((message?.type !== TYPES.attack) || !card?.isHitOn?.(ray)) return null;
    const activity = message.getAssociatedActivity?.();
    const item = activity?.item;
    if((activity?.type !== "attack") || (item?.type !== "weapon")) return null;
    const attack = card.attackOf(ray);
    const ranged = String(activity.getActionType?.(attack?.options?.attackMode) ?? "").startsWith("r");
    if(!item.system.properties?.has?.("fin") && !ranged) return null;
    if(attack?.hasDisadvantage) return null;
    const target = card.hitTargets?.(ray)?.[0] ?? null;
    const attacker = tokenOf(message.getAssociatedActor?.());
    if(!attack?.hasAdvantage && !(target && attacker && this.allyNear(attacker, target))) return null;
    return target ?? attacker;
  }

  static cardButtons(message, buttons, { ray } = {}){
    if(!this.enabled() || !message.isOwner) return;
    const actor = message.getAssociatedActor?.();
    if(!actor?.isOwner || !this.itemOf(actor) || usedThisTurn(actor, "sneak")) return;
    if(message.system.extraRolls?.(ray, this.KEY)?.length || !this.qualifies(message, ray)) return;
    buttons.push({ id : "sneak", label : this.itemOf(actor).name, icon : "fa-user-ninja" });
  }

  /* The die onto the card (nothing used yet : that's when it's applied) */
  static async sneak(message, ray){
    const actor = message.getAssociatedActor?.();
    if(!this.enabled() || !actor?.isOwner || message.system.extraRolls?.(ray, this.KEY)?.length || !this.qualifies(message, ray)) return false;
    const formula = this.formulaOf(actor);
    const item = message.getAssociatedItem?.();
    const type = [...(item?.system?.damage?.base?.types ?? [])][0] ?? "piercing";
    const isCritical = !!message.system.attackOf(ray)?.isCritical;
    const roll = await new CONFIG.Dice.DamageRoll(formula, {}, { type, types : [type], isCritical }).evaluate();
    await message.system.addDamage([roll], { key : this.KEY, ray, label : this.itemOf(actor)?.name ?? "Sneak Attack", onHit : true, formula });
    log.debug("Sneak Attack rolled", actor.name, formula);
    return true;
  }

  /* Its box applied to a creature : the turn's Sneak Attack (a second one that turn : Rule Limits) */
  static onApply(options = {}){
    if(!this.enabled() || !String(options?.[module.id]?.part ?? "").startsWith(`tray-extra-${this.KEY}`)) return;
    const attacker = options.origin?.getAssociatedActor?.();
    if(!attacker) return;
    if(usedThisTurn(attacker, "sneak")
      && !limits.allow(module.format("classes.rogue.sneakUsed", { name : attacker.name }), { who : attacker.name, what : this.itemOf(attacker)?.name ?? "Sneak Attack" })) return false;
    markUsedThisTurn(attacker, "sneak");
  }

  /* From the sheet : the latest of this actor's attack cards with a qualifying hit and no Sneak Attack yet */
  static async sneakFromSheet(actor){
    for(const message of game.messages.contents.slice(-15).reverse()){
      if((message.type !== TYPES.attack) || (message.getAssociatedActor?.()?.id !== actor.id)) continue;
      const rays = message.system.isMulti ? message.system.rays.map((_, i) => i) : [null];
      const ray = rays.find(r => !message.system.extraRolls?.(r, this.KEY)?.length && this.qualifies(message, r));
      if(ray !== undefined){
        await this.sneak(message, ray);
        return message;
      }
      break;
    }
    ui.notifications.warn(module.format("classes.rogue.noHit", { name : actor.name }));
    return null;
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
