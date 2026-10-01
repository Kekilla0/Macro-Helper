import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { tokenOf, pushAway } from '../helpers/tokens.js';
import { getSize, setStatus } from '../helpers/actors.js';
import { masteries } from './masteries.js';
const log = logger.for(import.meta.url);

/**
 * Grapple and Shove (2024 Unarmed Strike) : save activities the target makes (STR or DEX, its choice) instead of
 * taking the strike's damage. dnd5e rolls the save; these do what a failure means.
 *
 *   Grapple : on a failed save the target is Grappled, applied as soon as the save is rolled (from any card).
 *   Shove   : on a failed save the shover chooses : Prone, or pushed 5 ft away. Roll Item's save card shows both
 *             buttons per target that failed, for its roller; the GM carries them out (pushing an enemy).
 *   Both    : only a creature no more than one size larger than you.
 *
 * Recognised by dnd5e's own Unarmed Strike activities : named Grapple / Shove, or applying its grapple / shove effect.
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
    for(const key of ["grapple", "shove"]){
      if(name.startsWith(key) || effects.some(id => id.startsWith(key))) return key;
    }
    return null;
  }

  /* No more than one size larger than you */
  static fits(target, attacker){
    return (getSize(target)?.value ?? 2) <= ((getSize(attacker)?.value ?? 2) + 1);
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("createChatMessage", message => this.onSaveRolled(message));
    gm.handle("shove", (data, user)=> this.shoveAsGM(data, user));
  }

  /* A save rolled from a Grapple / Shove card : Grapple's failure applies, and the card refreshes (Shove's buttons) */
  static async onSaveRolled(message){
    if(!this.enabled()) return;
    const card = game.messages.get(message.system?.origin);
    const [roll] = message.rolls ?? [];
    if(!card || !(roll instanceof CONFIG.Dice.D20Roll)) return;
    const key = this.of(card.getAssociatedActivity?.());
    if(!key) return;

    ui.chat?.updateMessage(card);
    if((key !== "grapple") || !roll.isFailure || (message.author?.id !== game.user.id)) return;

    const token = message.getAssociatedToken?.();
    const target = token?.actor;
    const attacker = card.getAssociatedActor();
    if(!target) return;
    if(attacker && !this.fits(target, attacker)){
      return ui.notifications.warn(module.format("rollItem.maneuver.tooBig", { name : token.name, action : module.i18n("rollItem.maneuver.grapple") }));
    }
    if(target.isOwner) await setStatus(target, "grappled", true);
    log.debug("Grappled", token.name, "by", attacker?.name);
  }

  /* ---------- Shove's choice ---------- */

  /**
   * Done by the GM's client : the card must be a Shove save card the asker made, the target must have failed its
   * save from it, and each target is shoved once.
   */
  static async shoveAsGM({ message : id, target : uuid, choice } = {}, user){
    const card = game.messages.get(id);
    if(!card || (this.of(card.getAssociatedActivity?.()) !== "shove")) throw new Error("Not a Shove card.");
    if(!user?.isGM && (card.author?.id !== user?.id)) throw new Error("Only the card's roller can choose the shove.");
    if(card.system.outcomes?.get(uuid) !== "failure") return [module.i18n("rollItem.maneuver.notFailed")];

    const key = uuid.replaceAll(".", "-");
    if(card.getFlag(module.id, `shove.${key}`)) return [module.i18n("rollItem.maneuver.done")];

    const token = fromUuidSync(uuid, { strict : false })?.object;
    const attacker = card.getAssociatedActor();
    const attackerToken = tokenOf(card.getAssociatedToken?.() ?? attacker);
    if(!token?.actor) return [];
    if(attacker && !this.fits(token.actor, attacker)){
      return [module.format("rollItem.maneuver.tooBig", { name : token.name, action : module.i18n("rollItem.maneuver.shove") })];
    }

    const notes = [];
    if(choice === "push"){
      const moved = await pushAway(token, attackerToken, 5);
      if(settings.value("homebrewPush")) await masteries.pushCollision(token, moved, 5, card.getAssociatedItem?.());
      else if(!moved) notes.push(module.format("rollItem.mastery.blocked", { name : token.name }));
    }
    else await setStatus(token.actor, "prone", true);

    await card.setFlag(module.id, `shove.${key}`, choice);
    return notes;
  }

  /**
   * Shove's buttons on the save card : one row per target that failed, for the card's roller.
   * @param {ChatMessage} card
   * @returns {object[]}  [{ uuid, name, done, choice }]
   */
  static shoveContext(card){
    if(!this.enabled() || !card.isOwner || !card.isContentVisible) return [];
    if(this.of(card.getAssociatedActivity?.()) !== "shove") return [];
    return [...(card.system.outcomes ?? new Map())]
      .filter(([, outcome]) => outcome === "failure")
      .map(([uuid]) => {
        const done = card.getFlag(module.id, `shove.${uuid.replaceAll(".", "-")}`) ?? null;
        return { uuid, name : fromUuidSync(uuid, { strict : false })?.name ?? "", done, prone : done === "prone", push : done === "push" };
      });
  }

  /* The button : ask the GM to shove that target */
  static async shove(card, uuid, choice){
    const notes = await gm.run("shove", { message : card.id, target : uuid, choice });
    for(const note of notes ?? []) ui.notifications.info(note);
  }
}
