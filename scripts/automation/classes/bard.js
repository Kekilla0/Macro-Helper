import { module } from '../../module.js';
import { idOf, originItem } from '../../helpers/utils.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { tokenOf } from '../../helpers/tokens.js';
import { masteries } from '../masteries.js';
import { rerolls, addDie } from '../../roll-item/rerolls.js';
const log = logger.for(import.meta.url);

/**
 * Bard, levels 1-2 (Class Rules setting). Expertise and Jack of All Trades are dnd5e's own (from the items' data).
 *
 *   Bardic Inspiration : "Inspire" (a Bonus Action, 60 ft) marks another creature as Inspired, with the Bard's die
 *                        (@scale.bard.inspiration : d6), for an hour : dnd5e's own Apply on the card's effect (the GM's,
 *                        for a creature its player doesn't own).
 *                        When the Inspired creature fails a D20 Test (a missed attack, a failed save or check), its
 *                        owner gets a button : the die is rolled and added to that roll (the card re-judges it), and
 *                        the mark goes. Saves and checks from the sheet and on card rows, attack cards.
 */
export class bard{
  static BARDIC = "bardic-inspiration";

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on(`${module.id}.targets`, (activity, tokens) => this.onTargets(activity, tokens));
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => this.cardButtons(message, buttons, context));
    Hooks.on(`${module.id}.cardButton`, (message, id, context) => this.cardClicked(message, id, context));
    Hooks.on(`${module.id}.rerollButtons`, (message, buttons, { actor, roll }) => this.testButtons(message, buttons, actor, roll));
    /* Inspire's formula is the die the creature keeps : Roll Item mustn't roll it on the card */
    Hooks.on(`${module.id}.preRollItem`, activity => !this.keepsDie(activity));
  }


  static isBardic(activity){
    return this.enabled() && (idOf(activity?.item) === this.BARDIC);
  }

  /* Bardic Inspiration on a save / check message : the creature's owner, on a failed test (not initiative), once */
  static testButtons(message, buttons, actor, roll){
    if(!actor?.isOwner || message.getFlag?.("core", "initiativeRoll") || message.getFlag?.(module.id, "bardic") || !this.failed(roll)) return;
    const inspiration = this.inspirationOf(actor);
    if(inspiration) buttons.push({ id : "bardic", icon : "fa-music", label : module.format("classes.bard.use", { die : inspiration.die }), run : () => this.inspireTest(message, actor) });
  }

  /* Its die added to the roll, the mark gone */
  static async inspireTest(message, actor){
    const inspiration = this.inspirationOf(actor);
    if(!inspiration || !message.isOwner) return;
    const { updated, extra } = await addDie(message.rolls[0], inspiration.die);
    await rerolls.replace(message, updated, [extra]);
    await message.setFlag(module.id, "bardic", true);
    if(inspiration.effect.isOwner) await inspiration.effect.delete();
  }

  /* Inspire's formula is the die the creature keeps : Roll Item mustn't roll it on the card */
  static keepsDie(activity){
    return this.isBardic(activity) && (activity?.type === "utility");
  }

  /* The Bard's die, from Inspire's roll formula ("@scale.bard.inspiration" : "1d6") */
  static dieOf(item){
    const formula = item?.system?.activities?.find?.(a => a.roll?.formula)?.roll?.formula;
    if(!formula) return "1d6";
    const text = String(Roll.replaceFormulaData(formula, item.getRollData?.() ?? {}, { missing : "" })).trim();
    if(/^d\d+$/i.test(text)) return `1${text}`;
    return /\d*d\d+/i.test(text) ? text : "1d6";
  }

  /**
   * A creature's Bardic Inspiration : the mark this module gave, or the Bard item's effect applied from its card.
   * @param {Actor} actor
   * @returns {{ effect : ActiveEffect, die : string, by : string }|null}
   */
  static inspirationOf(actor){
    if(!this.enabled()) return null;
    for(const effect of actor?.appliedEffects ?? actor?.effects ?? []){
      const mark = effect.getFlag?.(module.id, "bardic");
      if(mark) return { effect, die : mark.die || "1d6", by : mark.by ?? "" };
      /* The Bard's own effect, applied from its card (dnd5e's tray gives the Inspire activity as its origin) */
      const origin = originItem(effect);
      if(origin && (idOf(origin) === this.BARDIC) && (origin.actor !== actor)){
        return { effect, die : this.dieOf(origin), by : origin.actor?.name ?? "" };
      }
    }
    return null;
  }

  /* A D20 Test that failed : below its DC / AC, or with none known (its owner judges) */
  static failed(roll){
    if(!roll) return false;
    const target = roll.options?.target;
    return !Number.isFinite(target) || (roll.total < target);
  }

  /* ---------- Giving it ---------- */

  /* "Another creature", holding no die yet : the Bard and the already Inspired are dropped from the targets */
  static onTargets(activity, tokens){
    if(!this.isBardic(activity)) return;
    const me = tokenOf(activity.actor);
    for(let i = tokens.length - 1; i >= 0; i--){
      const t = tokens[i];
      if(t === me){ tokens.splice(i, 1); continue; }
      if(this.inspirationOf(t.actor)){
        ui.notifications.info(module.format("classes.bard.already", { name : t.name }));
        tokens.splice(i, 1);
      }
    }
  }





  /* ---------- Using it : attack cards ---------- */

  static cardButtons(message, buttons, { ray } = {}){
    if(!this.enabled() || (typeof message.system?.addBonus !== "function")) return;
    const attacker = message.getAssociatedActor?.();
    if(!attacker?.isOwner || message.getFlag?.(module.id, `bardic.${masteries.rayKey(ray)}`)) return;
    const inspiration = this.inspirationOf(attacker);
    if(!inspiration) return;
    const attack = message.system.attackOf?.(ray);
    if(!attack || message.system.isHitOn?.(ray)) return;
    buttons.push({ id : "bardic", label : module.format("classes.bard.use", { die : inspiration.die }), icon : "fa-music" });
  }

  static async cardClicked(message, id, { ray } = {}){
    if(!this.enabled() || (id !== "bardic")) return;
    const attacker = message.getAssociatedActor?.();
    const inspiration = this.inspirationOf(attacker);
    if(!inspiration || !message.isOwner) return;
    if(!await message.system.addBonus(ray, inspiration.die, module.i18n("classes.bard.inspired"))) return;
    await message.setFlag(module.id, `bardic.${masteries.rayKey(ray)}`, true);
    if(inspiration.effect.isOwner) await inspiration.effect.delete();
  }
}
