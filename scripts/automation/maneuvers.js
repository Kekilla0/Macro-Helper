import { module } from '../module.js';
import { settings } from '../settings.js';
import { limits } from './limits.js';
import { logger } from '../log.js';
import { tokenOf, pushAway } from '../helpers/tokens.js';
import { getSize, setStatus } from '../helpers/actors.js';
import { masteries } from './masteries.js';
import { originOf } from '../helpers/utils.js';
import { conditions } from './conditions.js';
import { uses } from '../uses.js';
const log = logger.for(import.meta.url);

/**
 * Grapple and Shove (2024 Unarmed Strike) : save activities the target makes (STR or DEX, its choice) instead of
 * taking the strike's damage. dnd5e rolls the save; these do what a failure means.
 *
 *   Grapple : on a failed save the GM applies Grappled with the row's Apply effect, like any save's effect.
 *   Shove   : on a failed save the shover chooses : Prone, or pushed 5 ft away. Roll Item's save card shows both
 *             buttons per target that failed, for its roller; the choice then shows as the GM's button on that
 *             target's row (where a save's effects are applied), and the GM carries it out.
 *   Both    : only a creature no more than one size larger than you.
 *
 * Recognised by dnd5e's own Unarmed Strike activities : named Grapple / Shove, or applying its grapple / shove effect.
 * One activity for both ("Grapple/Shove", the class-feature Unarmed Strike) asks which when used, and its card is
 * that one from then on. Either way they're alternatives to the strike's attack, chosen before rolling, never riders
 * on it : 2024 Grapple and Shove have no attack roll, the target only saves.
 */
export class maneuvers{
  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("rollItemManeuvers");
  }

  /**
   * Is this activity Grapple or Shove ?
   * @param {Activity} activity
   * @returns {"grapple"|"shove"|null}
   */
  static of(activity){
    if(activity?.type !== "save") return null;
    const name = (activity.name ?? "").toLowerCase();
    const effects = (activity.effects ?? []).map(e => String(e._id ?? e.id ?? "").toLowerCase());
    /* One activity for both ("Grapple/Shove", the class-feature Unarmed Strike) : the effect tray offers the choice */
    if(name.includes("grapple") && name.includes("shove")) return null;
    for(const key of ["grapple", "shove"]){
      if(name.startsWith(key) || effects.some(id => id.startsWith(key))) return key;
    }
    return null;
  }

  /**
   * Is this activity Grapple, Shove, or one activity for both ?
   * @param {Activity} activity
   * @returns {boolean}
   */
  static isManeuver(activity){
    return !!this.of(activity) || this.isCombined(activity);
  }

  /* One save activity for both ("Grapple/Shove") */
  static isCombined(activity){
    const name = (activity?.name ?? "").toLowerCase();
    return (activity?.type === "save") && name.includes("grapple") && name.includes("shove");
  }

  /**
   * Which one a card is : the choice made when a combined activity was used, else the activity's own.
   * @param {ChatMessage} card
   * @returns {"grapple"|"shove"|null}
   */
  static ofCard(card){
    return card?.getFlag?.(module.id, "maneuver") ?? this.of(card?.getAssociatedActivity?.());
  }

  /**
   * Using a combined Grapple/Shove : which one ? Asked before anything is rolled.
   * @param {Activity} activity
   * @returns {Promise<"grapple"|"shove"|null>}  null when closed
   */
  static async choose(activity){
    return foundry.applications.api.DialogV2.wait({
      window : { title : activity.item?.name ?? activity.name, icon : "fa-solid fa-hand-fist" },
      content : `<p>${module.i18n("rollItem.maneuver.choose")}</p>`,
      buttons : [
        { action : "grapple", label : module.i18n("rollItem.maneuver.grapple").capitalize(), icon : "fa-solid fa-hand", default : true },
        { action : "shove", label : module.i18n("rollItem.maneuver.shove").capitalize(), icon : "fa-solid fa-hand-back-fist" },
      ],
      rejectClose : false,
    }) ?? null;
  }

  /* No more than one size larger than you */
  static fits(target, attacker){
    return (getSize(target)?.value ?? 2) <= ((getSize(attacker)?.value ?? 2) + 1);
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("createChatMessage", message => this.onSaveRolled(message));
    /* Roll Item's save card : Shove's buttons, and Grapple only on a creature that fits */
    foundry.applications.handlebars.loadTemplates({ [`${module.id}.shove`] : `${module.path}/templates/shove.hbs` });
    Hooks.on(`${module.id}.cardSections`, (message, sections) => this.cardSection(message, sections));
    Hooks.on(`${module.id}.cardButton`, (message, id, { button } = {}) => { if(id === "shove") this.shoveClicked(message, button); });
    Hooks.on(`${module.id}.preApplyEffects`, (message, actor, effects, { uuid } = {}) => {
      if(this.ofCard(message) === "shove"){ this.shoveAsGM(message, uuid); return false; }
      return this.mayGrapple(message, actor);
    });
    /* The GM's row button : the shover's choice (nothing until it's made) */
    Hooks.on(`${module.id}.rowEffect`, (message, uuid, row, { success } = {}) => this.shoveRow(message, uuid, row, success));
    /* Grapple and Shove are alternatives to the strike's attack, never riders on it (Roll Item) */
    Hooks.on(`${module.id}.isRider`, activity => !this.isManeuver(activity));
    /* One activity for both : choose first, the card is that one */
    uses.onActivity("maneuver", async (activity, ctx, next) => {
      if(this.enabled() && this.isCombined(activity) && !ctx.config?.[module.id]?.maneuver){
        const choice = await this.choose(activity);
        if(!choice) return;
        uses.flag(ctx, { maneuver : choice });
        uses.mark(ctx, { maneuver : choice });
      }
      return next();
    });
  }

  /* A save rolled from a Grapple / Shove card : Grapple's failure applies, and the card refreshes (Shove's buttons) */
  static async onSaveRolled(message){
    if(!this.enabled()) return;
    const card = originOf(message);
    const [roll] = message.rolls ?? [];
    if(!card || !(roll instanceof CONFIG.Dice.D20Roll)) return;
    const key = this.ofCard(card);
    if(!key) return;

    ui.chat?.updateMessage(card);
  }

  /* ---------- Shove's choice ---------- */

  static keyOf(uuid){
    return String(uuid ?? "").replaceAll(".", "-");
  }

  /* The GM's row button on a Shove card : hidden until the shover chooses, then that choice ("Apply Push 5 ft") */
  static shoveRow(card, uuid, row, success){
    if(this.ofCard(card) !== "shove") return;
    const choice = card.getFlag(module.id, `shove.${this.keyOf(uuid)}`);
    row.show = !success && !!choice;
    if(choice) row.names = module.i18n((choice === "push") ? "rollItem.maneuver.push" : "rollItem.maneuver.prone");
  }

  /**
   * The GM's row button : carry out the shover's choice, once. The target must have failed its save from the card.
   * @param {ChatMessage} card
   * @param {string} uuid   the target's token uuid
   */
  static async shoveAsGM(card, uuid){
    if(!game.user.isGM || (this.ofCard(card) !== "shove") || !uuid) return;
    const key = this.keyOf(uuid);
    const choice = card.getFlag(module.id, `shove.${key}`);
    if(!choice) return;
    if(card.getFlag(module.id, `effects.${key}`)) return ui.notifications.info(module.i18n("rollItem.maneuver.done"));
    if(card.system.outcomes?.get(uuid) !== "failure") return ui.notifications.info(module.i18n("rollItem.maneuver.notFailed"));

    const token = fromUuidSync(uuid, { strict : false })?.object;
    const attacker = card.getAssociatedActor();
    const attackerToken = tokenOf(card.getAssociatedToken?.() ?? attacker);
    if(!token?.actor) return;
    const notes = [];
    if(attacker && !this.fits(token.actor, attacker)
      && !limits.allow(module.format("rollItem.maneuver.tooBig", { name : token.name, action : module.i18n("rollItem.maneuver.shove") }), { who : attacker.name, what : `Shove ${token.name}` })) return;

    if(choice === "push"){
      const moved = await pushAway(token, attackerToken, 5);
      if(settings.value("homebrewPush")) await masteries.pushCollision(token, moved, 5, card.getAssociatedItem?.());
      else if(!moved) notes.push(module.format("rollItem.mastery.blocked", { name : token.name }));
    }
    else await setStatus(token.actor, "prone", true);

    await card.setFlag(module.id, `effects.${key}`, true);
    for(const note of notes) ui.notifications.info(note);
  }

  /* Grapple : only a creature no more than one size larger than the grappler (Rule Limits decides past that) */
  static mayGrapple(message, actor){
    const grappler = message.getAssociatedActor?.();
    if((this.ofCard(message) !== "grapple") || !grappler || this.fits(actor, grappler)) return true;
    return limits.allow(module.format("rollItem.maneuver.tooBig", { name : actor.name, action : module.i18n("rollItem.maneuver.grapple") }), { who : grappler.name, what : `Grapple ${actor.name}` });
  }

  /* Shove's section on Roll Item's save card */
  static cardSection(card, sections){
    const rows = this.shoveContext(card);
    if(rows.length) sections.push({ partial : `${module.id}.shove`, context : { rows } });
  }

  /* The shover's choice for one target (the card's roller, or the GM) : data-target is its token uuid, data-choice
     "prone" or "push". The GM's row button then carries it out. */
  static async shoveClicked(card, button){
    const { target : uuid, choice } = button?.dataset ?? {};
    if(!uuid || !["prone", "push"].includes(choice) || !card.isOwner) return;
    if(card.system.outcomes?.get(uuid) !== "failure") return ui.notifications.info(module.i18n("rollItem.maneuver.notFailed"));
    if(card.getFlag(module.id, `shove.${this.keyOf(uuid)}`)) return;
    button.disabled = true;
    await card.setFlag(module.id, `shove.${this.keyOf(uuid)}`, choice);
  }


  /**
   * Shove's buttons on the save card : one row per target that failed, for the card's roller.
   * @param {ChatMessage} card
   * @returns {object[]}  [{ uuid, name, done, choice }]
   */
  static shoveContext(card){
    if(!this.enabled() || !card.isOwner || !card.isContentVisible) return [];
    if(this.ofCard(card) !== "shove") return [];
    return [...(card.system.outcomes ?? new Map())]
      .filter(([, outcome]) => outcome === "failure")
      .map(([uuid]) => {
        const done = card.getFlag(module.id, `shove.${uuid.replaceAll(".", "-")}`) ?? null;
        return { uuid, name : fromUuidSync(uuid, { strict : false })?.name ?? "", done, prone : done === "prone", push : done === "push" };
      });
  }
}
