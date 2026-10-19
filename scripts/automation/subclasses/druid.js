import { module } from '../../module.js';
import { logger } from '../../log.js';
import { idOf, chooseOption, originItem } from '../../helpers/utils.js';
import { tokenOf, addLight, removeLight } from '../../helpers/tokens.js';
import { CardBuilder, push, isSmaller } from '../../roll-item/card-builder.js';
import { uses } from '../../uses.js';
import { conditions } from '../conditions.js';
import { casting } from '../casting.js';
import { subclasses } from './common.js';
const log = logger.for(import.meta.url);

/**
 * Druid subclasses, level 3 (Subclasses setting). The circle spells are the import's; Circle Forms is Wild Shape's
 * (classes/druid.js). Star Map's free Guiding Bolts aren't in Plutonium's data (the spell is cast as usual).
 *
 *   Land   Land's Aid          after its save card : a card offers its healing (one creature in the area).
 *   Sea    Wrath of the Sea    its save cards (Manifest, the Bonus Action save) : a failed save pushes a Large or
 *                              smaller creature 15 ft away (the GM's Push at the card's bottom). The spray lasts 10
 *                              minutes, until the Druid is Incapacitated; at the start of each of its turns while it
 *                              lasts, a card offers the Bonus Action save.
 *   Stars  Starry Form         using it asks the constellation; the form (10 minutes, ends when Incapacitated or used
 *                              again) sheds Bright Light 10 ft and Dim Light 10 ft more. Archer : a card offers the
 *                              Archer attack now and at the start of each of its turns. Chalice : after a spell from a
 *                              slot that restores Hit Points, a card offers the Chalice's healing. Dragon : the Dragon
 *                              item's effect (9 or lower on INT / WIS checks and Concentration saves counts as 10).
 */
export class druidCircles{
  static LANDS_AID = "lands-aid";
  static WRATH = "wrath-of-the-sea";
  static STARRY = "starry-form";
  static FORMS = ["archer", "chalice", "dragon"];
  static LIGHT = { bright : 10, dim : 20, color : "#d6e4ff", alpha : 0.3 };

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    conditions.endOnIncapacitated(this.WRATH, this.STARRY);
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.afterUse(activity, usage, results));
    Hooks.on(`${module.id}.turnStart`, (combat, combatant) => this.onTurn(combatant?.actor));
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && (idOf(activity?.item) === this.STARRY)));
    Hooks.on("deleteActiveEffect", effect => this.starryEnds(effect));
  }

  static async afterUse(activity, usage, results){
    if(!this.enabled() || !activity?.actor?.isOwner) return;
    const id = idOf(activity.item);
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    try {
      if((id === this.LANDS_AID) && (activity.type === "save")) await this.landsAid(actor, activity.item);
      else if((id === this.WRATH) && (activity.type === "save")) await this.wrathPush(results);
      else if(id === this.STARRY) await this.starryForm(actor, activity.item);
      else if((activity.item?.type === "spell") && (activity.type === "heal") && casting.spendsSlot(activity, usage ?? {})) await this.chalice(actor);
    }
    catch(error){ log.error(error); ui.notifications.warn(error.message); }
  }

  /* ---------- Land ---------- */

  static async landsAid(actor, item){
    const heal = [...(item.system.activities ?? [])].find(a => a.type === "heal");
    if(heal) await subclasses.offer(actor, { item, activity : heal.id, label : heal.name || item.name,
      text : module.format("subclasses.druid.landsAid", { name : actor.name }) });
  }

  /* ---------- Sea ---------- */

  /* A failed save : pushed 15 ft, Large or smaller */
  static async wrathPush(results){
    const card = await uses.cardOf(results);
    const message = (card?.documentName === "ChatMessage") ? card : (card?.message ?? null);
    if(!message?.isOwner) return;
    await new CardBuilder(message).append(push(15, { when : ["fail", t => isSmaller(t, "large")] }));
  }

  static wrathOf(actor){
    return [...(actor?.appliedEffects ?? [])].find(e => idOf(originItem(e)) === this.WRATH) ?? null;
  }

  /* ---------- Stars ---------- */

  static starryOf(actor){
    return actor?.effects?.find?.(e => e.getFlag(module.id, "starry")) ?? null;
  }

  static async starryForm(actor, item){
    const form = await chooseOption({ title : item.name, icon : "fa-solid fa-star", prompt : module.i18n("subclasses.druid.starryPrompt"),
      options : this.FORMS.map(value => ({ value, label : module.i18n(`subclasses.druid.${value}`) })) });
    if(!form) return;
    const old = this.starryOf(actor);
    if(old) await old.delete();
    const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{ name : `${item.name} (${module.i18n(`subclasses.druid.${form}Short`)})`,
      img : item.img, origin : item.uuid, duration : { seconds : 600 }, start : { time : game.time.worldTime },
      flags : { [module.id] : { starry : { form }, endsOnIncapacitated : true } } }]);
    await addLight(tokenOf(actor), this.LIGHT, { key : "starryForm" });
    if(form === "dragon") await this.dragon(actor, effect);
    if(form === "archer") await this.archer(actor);
    log.debug("Starry Form", actor.name, form);
  }

  /* The constellation's own item (Plutonium : Archer, Chalice, Dragon) */
  static formItem(actor, form){
    return subclasses.has(actor, form) ?? actor.items.find(i => (i.type === "feat") && (i.name.toLowerCase() === form));
  }

  static async archer(actor){
    const item = this.formItem(actor, "archer");
    const attack = [...(item?.system?.activities ?? [])].find(a => a.type === "attack");
    if(attack) await subclasses.offer(actor, { item, activity : attack.id, text : module.format("subclasses.druid.archerText", { name : actor.name }) });
  }

  /* Dragon : the item's effect for its level, on the Druid while the form lasts */
  static async dragon(actor, starry){
    const item = this.formItem(actor, "dragon");
    const level = Number(actor.classes?.druid?.system?.levels) || 0;
    const effects = [...(item?.effects ?? [])];
    const source = effects.find(e => (level >= 10) === /twinkling/i.test(e.name)) ?? effects[0];
    if(!source) return;
    const data = foundry.utils.mergeObject(source.toObject(), { disabled : false, transfer : false, origin : item.uuid,
      duration : { seconds : 600 }, start : { time : game.time.worldTime }, flags : { [module.id] : { starryBound : starry?.id ?? true } } });
    delete data._id;
    await actor.createEmbeddedDocuments("ActiveEffect", [data]);
  }

  static async chalice(actor){
    if(this.starryOf(actor)?.getFlag(module.id, "starry")?.form !== "chalice") return;
    const item = this.formItem(actor, "chalice");
    const heal = [...(item?.system?.activities ?? [])].find(a => a.type === "heal");
    if(heal) await subclasses.offer(actor, { item, activity : heal.id, text : module.format("subclasses.druid.chaliceText", { name : actor.name }) });
  }

  /* The form over : its light and the Dragon's effect go */
  static async starryEnds(effect){
    if(!effect?.getFlag?.(module.id, "starry") || !game.users.activeGM?.isSelf) return;
    const actor = effect.parent;
    const token = tokenOf(actor);
    if(token) await removeLight(token, { key : "starryForm" });
    const bound = actor?.effects?.filter?.(e => e.getFlag(module.id, "starryBound")).map(e => e.id) ?? [];
    if(bound.length) await actor.deleteEmbeddedDocuments("ActiveEffect", bound);
  }

  /* ---------- Turn starts : the Bonus Action offers ---------- */

  static async onTurn(actor){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !actor) return;
    if(this.wrathOf(actor)){
      const item = subclasses.has(actor, this.WRATH);
      const save = [...(item?.system?.activities ?? [])].filter(a => a.type === "save").at(-1);
      if(save) await subclasses.offer(actor, { item, activity : save.id, label : save.name || item.name,
        text : module.format("subclasses.druid.wrathText", { name : actor.name }) });
    }
    if(this.starryOf(actor)?.getFlag(module.id, "starry")?.form === "archer") await this.archer(actor);
  }
}
