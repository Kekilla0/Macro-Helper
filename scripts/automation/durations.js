import { module } from '../module.js';
import { logger } from '../log.js';
import { actorOf } from '../helpers/tokens.js';
import { rollModes, giveRollMode } from './roll-modes.js';
import { uses } from '../uses.js';
const log = logger.for(import.meta.url);

/**
 * Longer durations : an item's Concentration and the effects it puts on creatures last longer (Extended Spell; a
 * homebrew "your blessings last twice as long"; a monster's lingering curse).
 *
 *   await MacroHelper.extendDurations(actor, spell, { multiplier : 2, max : 86400, concentration : "advantage" });
 *
 * Called once the item has been used : its Concentration (when it has one) lasts `multiplier` times as long, at most
 * `max` seconds, and with `concentration` its Concentration saves get that mode. Effects from the item that land on
 * other creatures afterwards (its card's Apply) last as long too, while that Concentration lasts (no Concentration :
 * until the item is used again). Those changes are made as dnd5e makes the effects, by whoever makes them.
 *
 * Ends on damage : an effect on an item with the rule endsOnDamage (flags["macro-helper"].rule) ends once that item's
 * card deals damage to a creature (Poisoner's poison on a weapon; a homebrew oil that burns off on the first hit). It's
 * switched off then (that card's rider rows still work : an enchantment's riders stay while it's off), and removed when
 * the item is next used.
 */
export class durations{
  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("preCreateActiveEffect", (effect, data, options, userId) => { if(userId === game.user.id) this.onEffect(effect); });
    /* Used again : the last use's longer durations are over */
    Hooks.on("dnd5e.preUseActivity", activity => {
      const item = activity?.item, actor = item?.actor;
      if(actor?.isOwner && actor.getFlag(module.id, `extended.${item.id}`)) actor.unsetFlag(module.id, `extended.${item.id}`).catch(() => {});
    });
    rollModes.add("extended", config => this.concentrationMode(config), { rolls : "concentration" });
    Hooks.on("dnd5e.applyDamage", (actor, amount, options) => this.onDamage(amount, options));
    uses.onActivity("endedOnDamage", async (activity, ctx, next) => {
      const item = activity?.item;
      const spent = item?.effects?.filter?.(e => e.disabled && e.getFlag(module.id, "rule")?.endsOnDamage) ?? [];
      if(spent.length && item.isOwner) await item.deleteEmbeddedDocuments("ActiveEffect", spent.map(e => e.id)).catch(error => log.debug(error));
      return next();
    });
  }

  /* An item's card dealt damage : its effects that end on damage are switched off (the item's owner, or the GM) */
  static async onDamage(amount, options = {}){
    if(!(amount > 0)) return;
    const item = options.origin?.getAssociatedItem?.() ?? options.originatingMessage?.getAssociatedItem?.();
    const ended = item?.effects?.filter?.(e => !e.disabled && e.getFlag(module.id, "rule")?.endsOnDamage) ?? [];
    if(!ended.length || !item.isOwner) return;
    log.debug("Ends on damage", item.name, ended.map(e => e.name));
    await item.updateEmbeddedDocuments("ActiveEffect", ended.map(e => ({ _id : e.id, disabled : true }))).catch(error => log.debug(error));
  }

  /* `multiplier` times a duration, as dnd5e stores it (value in its units), at most `max` seconds */
  static scaled(duration, multiplier = 2, max = 86400){
    const toSeconds = { seconds : 1, minutes : 60, hours : 3600, days : 86400, rounds : 6, turns : 6 }[duration?.units] ?? 1;
    const value = (Number(duration?.value) || 0) * multiplier;
    return Number.isFinite(max) ? Math.min(value, Math.floor(max / toSeconds)) : value;
  }

  /* The creature's Concentration on that item */
  static concentrationOn(actor, item){
    return actor?.effects?.find?.(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && (e.getFlag("dnd5e", "item")?.id === item.id)) ?? null;
  }

  static async extend(thing, item, { multiplier = 2, max = 86400, concentration = null, reason = null } = {}){
    const actor = actorOf(thing) ?? item?.actor;
    if(!actor?.isOwner || !item) return false;
    const effect = this.concentrationOn(actor, item);
    if(effect) await effect.update({ "duration.value" : this.scaled(effect.duration, multiplier, max),
      [`flags.${module.id}.extended`] : { mode : concentration, reason : reason ?? item.name } });
    await actor.setFlag(module.id, `extended.${item.id}`, { at : game.time.worldTime, concentration : effect?.uuid ?? null, multiplier, max });
    log.debug("Extended", actor.name, item.name, multiplier);
    return true;
  }

  /* An effect from an extended item landing on another creature : longer too (while its Concentration lasts) */
  static onEffect(effect){
    if(!(effect.parent?.documentName === "Actor") || effect.getFlag?.(module.id, "extended")) return;
    const origin = effect.origin ? fromUuidSync(effect.origin, { strict : false }) : null;
    const item = (origin?.documentName === "Item") ? origin : (origin?.item ?? null);
    const mark = item?.actor?.getFlag?.(module.id, `extended.${item.id}`);
    if(!mark || (effect.parent === item.actor)) return;
    if(mark.concentration && !fromUuidSync(mark.concentration, { strict : false })) return;
    if(!(Number(effect.duration?.value) > 0)) return;
    effect.updateSource({ "duration.value" : this.scaled(effect.duration, mark.multiplier ?? 2, mark.max ?? 86400), [`flags.${module.id}.extended`] : { mode : null } });
  }

  /* Concentration saves while concentrating on an extended item with a mode */
  static concentrationMode(config){
    const actor = config?.subject;
    const extended = actor?.effects?.find?.(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && e.getFlag(module.id, "extended")?.mode);
    if(!extended) return;
    const { mode, reason } = extended.getFlag(module.id, "extended");
    giveRollMode(config, mode, reason);
  }
}

/**
 * @param {Actor|Token} thing     the creature that used it
 * @param {Item} item
 * @param {object} [options]
 * @param {number} [options.multiplier=2]
 * @param {number} [options.max=86400]          the longest it may become, in seconds (Infinity : no limit)
 * @param {"advantage"|"disadvantage"} [options.concentration]   its Concentration saves' mode
 * @param {string} [options.reason]              shown with that mode (default : the item's name)
 * @returns {Promise<boolean>}
 */
export function extendDurations(thing, item, options){
  return durations.extend(thing, item, options);
}
