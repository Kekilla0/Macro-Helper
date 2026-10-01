import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { findItem } from '../helpers/actors.js';
import { rollItem } from './roll-item.js';
const log = logger.for(import.meta.url);

/**
 * Feats on Roll Item attack cards.
 *
 * Savage Attacker (2024 origin feat) : "Once per turn when you hit a target with a weapon, you can roll the weapon's
 * damage dice twice and use either roll against the target."
 *   Each weapon attack that hit gets a "Savage Attacker" button, for its roller only, so they choose which attack.
 *   It rolls that attack's damage again (crits included) next to the first roll, each with its own APPLY;
 *   applying one hides the other. Once per turn in combat : using it on any card hides the button everywhere until
 *   their next turn. Out of combat there are no turns, so it's once per attack.
 */
export class features{
  static SAVAGE = ["savage-attacker", "Savage Attacker"];

  static savageEnabled(){
    return (game.system.id === "dnd5e") && settings.value("rollItemSavage");
  }

  static hasSavageAttacker(actor){
    return !!findItem(actor, this.SAVAGE);
  }

  /* Used already this turn (in combat) */
  static savageUsed(actor){
    const now = gm.stamp(actor, "turnEnd");
    const last = actor?.getFlag(module.id, "savage");
    return !!(now && last && (last.combat === now.combat) && (last.round === now.round) && (last.turn === now.turn));
  }

  /* Can this attack still use it : a weapon attack, the feat, not used this turn */
  static canSavage(message, activity){
    if(!this.savageEnabled() || !message.isOwner) return false;
    const actor = message.getAssociatedActor();
    if(activity?.item?.type !== "weapon" || !actor) return false;
    return this.hasSavageAttacker(actor) && !this.savageUsed(actor);
  }

  /**
   * The button : roll the attack's damage again, tagged "savage" (with its ray on a multi card).
   * @param {ChatMessage} message
   * @param {number|null} ray
   */
  static async savage(message, ray){
    const system = message.system;
    const activity = message.getAssociatedActivity({ scaled : true });
    const actor = message.getAssociatedActor();
    if(!activity || !actor) return;
    if(system.savageRolls(ray).length) return;
    if(this.savageUsed(actor)) return ui.notifications.warn(module.i18n("rollItem.savage.used"));

    const attack = system.attackOf(ray);
    const rolls = await rollItem.rollDamage(activity, attack);
    if(!rolls.length) return;
    for(const roll of rolls) roll.options[module.id] = Number.isInteger(ray) ? { ray, part : "savage" } : { part : "savage" };

    await rollItem.showDice(rolls, message);
    const update = { rolls : [...message.rolls, ...rolls].map(r => JSON.stringify(r)) };
    /* Already shown : Dice So Nice mustn't animate the added rolls a second time */
    if(game.dice3d) update["flags.dice-so-nice.skip"] = true;
    await message.update(update);

    const stamp = gm.stamp(actor, "turnEnd");
    if(stamp) await actor.setFlag(module.id, "savage", { combat : stamp.combat, round : stamp.round, turn : stamp.turn });
    log.debug("Savage Attacker", message.id, ray, rolls.map(r => r.total));
  }
}
