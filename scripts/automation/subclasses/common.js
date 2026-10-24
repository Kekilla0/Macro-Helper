import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf, esc, ownerIds, buttonRow, addButton, makeButton } from '../../helpers/utils.js';
import { cardBuilder } from '../../roll-item/card-builder.js';
import { gm } from '../../gm.js';
import { uses } from '../../uses.js';
import { rerolls, addDie } from '../../roll-item/rerolls.js';
import { rollSave } from '../../helpers/actors.js';
import { actorOf, tokenOf } from '../../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * Shared by the subclass rules (System Automation → Characters → Subclasses).
 *
 *   subclasses.enabled()                       the switch
 *   subclasses.has(actor, id)                  its item with that identifier
 *   subclasses.offer(actor, { item, activity, text, label, data })
 *                                              a card for the creature's owners (and the GM) with a button that uses
 *                                              that item's activity (item.roll : its card, its cost, its targets), once :
 *                                              "you may now ..." (Life-Giving Force at the start of a turn, Inspiring
 *                                              Smite after a smite). Without an activity : run(data) of the rule that
 *                                              registered `label` with onOffer.
 *   subclasses.onOffer(key, run)               what a key's button does (run(actor, data, message))
 *   subclasses.giveEffect(target, data, { save, dc, from, until, of })
 *                                              an effect on a creature (a maneuver's Goaded, Addle), after its save
 *                                              when one is given (a success : none); until "turnStart" / "turnEnd" of
 *                                              `of`'s next turn (default : the item's owner). The GM's client puts it on;
 *                                              on a creature that isn't the user's own (gm.mine), after the GM's
 *                                              button on a card (asked).
 *   subclasses.onUseStep(id, fn)               a use step (uses.js, "subclassUse") for one item identifier :
 *                                              fn(activity, ctx, next), before the targets are picked
 *   subclasses.changeRoll(message, change, by) a reaction's change to someone else's roll, made by the GM (a roll on a
 *                                              card isn't a creature's data) : change = { ray, add : "3" | subtract : "3"
 *                                              | d20 : "kh"/"kl" | straight : true | ac : { uuid, amount } | value : 15 };
 *                                              an attack card's attack (ray), or a save / check message's d20 roll.
 *                                              by : the reacting creature (the asking user must own it).
 */
export class subclasses{
  static #runs = new Map();

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("subclassRules");
  }

  static has(actor, id){
    return actor?.items?.find?.(i => idOf(i) === id) ?? null;
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("renderChatMessageHTML", (message, html) => this.offerButtons(message, html));
    gm.handle("subclassRoll", (data, user) => this.changeRollAsGM(data, user));
    gm.handle("subclassEffectsEnd", (data, user) => this.endEffectsAsGM(data, user));
    gm.handle("subclassEffect", (data, user) => this.giveEffectAsGM(data, user));
    /* GM : the button of giveEffect's ask card (the GM said yes) */
    gm.handle("subclassEffectAsk", data => this.giveEffectAsGM(data, game.user));
    gm.handle("subclassOfferDone", (data, user) => this.offerDoneAsGM(data, user));
    uses.onActivity("subclassUse", (activity, ctx, next) => {
      const fn = this.enabled() ? this.#useSteps.get(idOf(activity?.item)) : null;
      return fn ? fn(activity, ctx, next) : next();
    });
  }

  static #useSteps = new Map();

  /**
   * An effect on a creature, after its save (see above).
   * @returns {Promise<{ applied : boolean, asked : boolean, save : object|null }>}
   */
  static async giveEffect(thing, data, { save = null, dc = null, from = null, until = null, of = null } = {}){
    const actor = actorOf(thing);
    if(!actor) return { applied : false, save : null };
    let rolled = null;
    if(save && Number.isFinite(Number(dc))){
      rolled = await rollSave(thing, save, Number(dc), { from });
      if(!rolled || rolled.success) return { applied : false, save : rolled };
    }
    const effect = foundry.utils.mergeObject({ showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2, origin : from?.uuid ?? null, img : from?.img ?? null }, data, { inplace : false });
    if(until) foundry.utils.setProperty(effect, `flags.${module.id}.expires`, gm.timedStamp(actorOf(of) ?? from?.actor ?? actor, until));
    const payload = { actor : actor.uuid, data : effect, item : from?.uuid ?? null };
    /* Not the user's own creature : the GM's button puts it on */
    if(!gm.mine(actor)){
      const name = tokenOf(thing)?.name ?? actor.name;
      await gm.ask("subclassEffectAsk", payload, { actor : from?.actor ?? null,
        text : module.format("subclasses.effectAsk", { item : from?.name ?? "", name, effect : effect.name }),
        label : module.format("subclasses.effectButton", { name, effect : effect.name }) });
      return { applied : false, asked : true, save : rolled };
    }
    const applied = !!await gm.run("subclassEffect", payload);
    return { applied, asked : false, save : rolled };
  }

  static async giveEffectAsGM({ actor : uuid, data, item : itemUuid } = {}, user){
    const actor = fromUuidSync(uuid ?? "", { strict : false });
    const item = fromUuidSync(itemUuid ?? "", { strict : false });
    if(!actor || !data || !(user?.isGM || gm.mine(actor, user))) return false;
    await actor.createEmbeddedDocuments("ActiveEffect", [data]);
    return true;
  }

  /* GM : effects an item of the user's gave others, ended (a blessing given again, the giver's Long Rest) */
  static async endEffectsAsGM({ effects = [], item : itemUuid } = {}, user){
    const item = fromUuidSync(itemUuid ?? "", { strict : false });
    if(!item?.actor || !(user?.isGM || item.actor.testUserPermission(user, "OWNER"))) return false;
    for(const uuid of effects){
      const effect = fromUuidSync(uuid, { strict : false });
      if(effect && ((effect.origin === item.uuid) || (effect.origin?.startsWith?.(`${item.uuid}.`)))) await effect.delete();
    }
    return true;
  }

  static onUseStep(id, fn){
    this.#useSteps.set(id, fn);
  }

  /**
   * Change a roll on a message the user may not own (see above).
   * @returns {Promise<any>}  the change's result (false : not made)
   */
  static changeRoll(message, change, by){
    return gm.run("subclassRoll", { message : message.id, change, by : by?.uuid ?? by ?? null });
  }

  static async changeRollAsGM({ message : id, change = {}, by } = {}, user){
    const message = game.messages.get(id);
    const actor = by ? fromUuidSync(by, { strict : false }) : null;
    if(!message || !(user?.isGM || actor?.testUserPermission?.(user, "OWNER"))) return false;
    const ray = Number.isInteger(change.ray) ? change.ray : null;
    const system = message.system;
    /* An attack card */
    if(typeof system?.attackOf === "function"){
      if(change.ac) return system.raiseAC(change.ac.uuid, change.ac.amount);
      if(change.add) return system.addBonus(ray, String(change.add));
      if(change.subtract) return system.addBonus(ray, String(change.subtract), { subtract : true });
      if(change.d20) return system.addD20(ray, change.d20);
      if(Number.isFinite(change.value)) return system.forceD20(ray, change.value);
      if(change.straight) return this.straightAttack(message, ray);
      return false;
    }
    /* A save or check */
    const [roll] = message.rolls ?? [];
    if(!(roll instanceof CONFIG.Dice.D20Roll)) return false;
    let updated = null;
    if(change.add || change.subtract) updated = (await addDie(roll, String(change.add ?? change.subtract), { subtract : !!change.subtract })).updated;
    else if(Number.isFinite(change.value) || change.straight) updated = this.setD20(roll, change.straight ? null : change.value);
    if(!updated) return false;
    await rerolls.replace(message, updated, []);
    return true;
  }

  /**
   * A d20 roll's d20 set : to a value (Portent), or straight (null : its first die only, Restore Balance).
   * @returns {Roll}
   */
  static setD20(roll, value){
    const updated = roll.constructor.fromData(roll.toJSON());
    const d20 = updated.dice?.[0];
    if(!d20 || (d20.faces !== 20)) return null;
    if(value === null){
      /* dnd5e 6 writes the mode as an adv / dis modifier, older rolls as kh / kl */
      d20.modifiers = (d20.modifiers ?? []).filter(m => !/^(k[hl]|adv|dis)/i.test(m));
      d20.results.forEach((r, i) => { r.active = (i === 0); r.discarded = (i !== 0); });
      if(updated.options) updated.options.advantageMode = 0;
    }
    else d20.results = d20.results.map((r, i) => ({ ...r, result : value, active : i === 0, discarded : i !== 0 }));
    updated._total = updated._evaluateTotal();
    return updated;
  }

  /* An attack card's attack made straight (its first d20) */
  static async straightAttack(message, ray){
    const old = message.system.attackOf(ray);
    const updated = old ? this.setD20(old, null) : null;
    if(!updated) return false;
    await message.system._swapAttack(ray, old, updated, []);
    return true;
  }

  static onOffer(key, run){
    this.#runs.set(key, run);
  }

  /**
   * Offer a use to the creature's owners.
   * @param {Actor} actor
   * @param {object} options
   * @param {Item} [options.item]           the item to use
   * @param {string} [options.activity]     its activity (id or name; else the item's)
   * @param {string} [options.key]          instead of an item : a registered onOffer key
   * @param {object} [options.data]         for the key's run
   * @param {string} options.text           the card's line
   * @param {string} [options.label]        the button (default : the item's name)
   * @param {object} [options.roll]         more item.roll options (targets...)
   * @returns {Promise<ChatMessage|null>}
   */
  static async offer(actor, { item = null, activity = null, key = null, data = {}, text, label = null, roll = {} } = {}){
    if(!actor || (!item && !key)) return null;
    const act = activity ? [...(item?.system?.activities ?? [])].find(a => (a.id === activity) || (a.name === activity)) : null;
    return ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }),
      whisper : [...new Set([...ownerIds(actor), ...game.users.filter(u => u.isGM).map(u => u.id)])],
      content : `<p>${esc(text)}</p>`,
      flags : { [module.id] : { offer : { actor : actor.uuid, item : item?.uuid ?? null, activity : act?.id ?? null, key, data, roll,
        label : label ?? item?.name ?? key, done : false } } },
    });
  }

  /* GM : an offer a player used (the GM's card : its owner can't mark it) */
  static async offerDoneAsGM({ message : id } = {}, user){
    const message = game.messages.get(id ?? "");
    const offer = message?.getFlag(module.id, "offer");
    const actor = fromUuidSync(offer?.actor ?? "", { strict : false });
    if(!offer || !(user?.isGM || actor?.testUserPermission?.(user, "OWNER"))) return false;
    await message.setFlag(module.id, "offer.done", true);
    return true;
  }

  static offerButtons(message, html){
    const offer = message.getFlag?.(module.id, "offer");
    if(!offer) return;
    const actor = fromUuidSync(offer.actor ?? "", { strict : false });
    if(!actor?.isOwner) return;
    const row = buttonRow(html, { key : `${module.id}-offer` });
    if(row.childElementCount) return;
    addButton(row, makeButton({ icon : "fa-circle-play", text : offer.label, once : true, disabled : !!offer.done,
      onClick : async () => {
        try {
          let used = false;
          if(offer.key) used = (await this.#runs.get(offer.key)?.(actor, offer.data ?? {}, message)) !== false;
          else {
            const item = fromUuidSync(offer.item ?? "", { strict : false });
            if(!item) return;
            const targets = (offer.roll?.targets ?? []).map(uuid => fromUuidSync(uuid, { strict : false })?.object).filter(Boolean);
            const card = await cardBuilder.roll(item, { ...(offer.activity ? { activity : offer.activity } : {}), ...offer.roll,
              ...(targets.length ? { targets } : { targets : undefined }) });
            used = !!card;
          }
          if(!used) return;
          if(message.isOwner) await message.setFlag(module.id, "offer.done", true);
          else await gm.run("subclassOfferDone", { message : message.id });
        }
        catch(error){ log.error(error); ui.notifications.warn(error.message); }
      } }));
  }
}
