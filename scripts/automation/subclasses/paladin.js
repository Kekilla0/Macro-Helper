import { module } from '../../module.js';
import { logger } from '../../log.js';
import { gm } from '../../gm.js';
import { idOf, originItem } from '../../helpers/utils.js';
import { tempHP } from '../../helpers/actors.js';
import { tokenOf, addLight, removeLight } from '../../helpers/tokens.js';
import { pickTargets } from '../../helpers/targets.js';
import { spendUses } from '../../helpers/items.js';
import { divideAmong } from '../../helpers/creatures.js';
import { giveMode } from '../../roll-item/reasons.js';
import { CardBuilder } from '../../roll-item/card-builder.js';
import { uses } from '../../uses.js';
import { rollModes } from '../roll-modes.js';
import { conditions } from '../conditions.js';
import { repeating } from '../repeating.js';
import { subclasses } from './common.js';
const log = logger.for(import.meta.url);

/**
 * Paladin subclasses, level 3 (Subclasses setting). The oath spells are the import's; Peerless Athlete's advantage is
 * its own effect.
 *
 *   Ancients  Nature's Wrath   Restrained : the Strength save again at the end of each of its turns (Spells :
 *                              repeating effects).
 *   Devotion  Sacred Weapon    once the enchantment is on a weapon, the Paladin's token sheds Bright Light 20 ft
 *                              and Dim Light 20 ft more while it lasts.
 *   Glory     Inspiring Smite  after Divine Smite : a card offers it (a Channel Divinity use) : 2d8 + Paladin level
 *                              temporary Hit Points, divided among creatures you pick within 30 ft (you too). Your own
 *                              at once; others' : the GM's button.
 *   Vengeance Vow of Enmity    the vow is on the Paladin (not the target) : Advantage on its attack rolls against that
 *                              creature for 1 minute, or until it vows again. The creature drops to 0 HP : a card
 *                              offers to move the vow to another creature within 30 ft.
 */
export class paladinOaths{
  static WRATH = "natures-wrath";
  static SACRED = "sacred-weapon";
  static INSPIRING = "inspiring-smite";
  static VOW = "vow-of-enmity";
  static CHANNEL = "channel-divinity";
  static LIGHT = { bright : 20, dim : 40, color : "#fff4d6", alpha : 0.3 };

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    repeating.TABLE[this.WRATH] ??= { label : "end", roll : { type : "save", ability : "str" } };
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.afterUse(activity, results));
    Hooks.on("createActiveEffect", (effect, options, userId) => this.sacredStarts(effect, userId));
    Hooks.on("deleteActiveEffect", effect => this.sacredEnds(effect));
    Hooks.on(`${module.id}.smite`, (actor, spell) => this.afterSmite(actor, spell));
    subclasses.onOffer("inspiringSmite", actor => this.inspiringSmite(actor));
    subclasses.onOffer("vowTransfer", actor => this.transferVow(actor));
    gm.handle("inspiringSmite", data => this.tempAsGM(data));
    rollModes.add("vow", config => this.vowMode(config));
    Hooks.on("updateActor", (actor, changes) => this.onDown(actor, changes));
  }

  static async afterUse(activity, results){
    if(!this.enabled() || !activity?.actor?.isOwner) return;
    const id = idOf(activity.item);
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    try {
      if(id === this.VOW) await this.vow(actor, activity, results);
    }
    catch(error){ log.error(error); ui.notifications.warn(error.message); }
  }

  /* ---------- Devotion ---------- */

  /* The enchantment on a weapon (not the use itself) : the light, on the client that applied it */
  static async sacredStarts(effect, userId){
    if(!this.enabled() || (userId !== game.user.id) || !effect?.isAppliedEnchantment || (idOf(originItem(effect)) !== this.SACRED)) return;
    const actor = originItem(effect)?.actor;
    if(actor) await addLight(tokenOf(actor), this.LIGHT, { key : "sacredWeapon" });
  }

  /* The enchantment gone : its light too */
  static async sacredEnds(effect){
    if(!this.enabled() || (effect?.type !== "enchantment") || (idOf(originItem(effect)) !== this.SACRED)) return;
    const actor = originItem(effect)?.actor;
    if(!actor || !game.users.activeGM?.isSelf) return;
    /* the item's own enchantment is only the profile : the applied ones count */
    const left = actor.items.some(i => i.effects.some(e => (e !== effect) && e.isAppliedEnchantment && (idOf(originItem(e)) === this.SACRED)));
    if(!left) await removeLight(tokenOf(actor), { key : "sacredWeapon" });
  }

  /* ---------- Glory ---------- */

  static async afterSmite(actor, spell){
    if(!this.enabled() || (idOf(spell) !== "divine-smite") || !subclasses.has(actor, this.INSPIRING)) return;
    if(!(Number(subclasses.has(actor, this.CHANNEL)?.system?.uses?.value) > 0)) return;
    await subclasses.offer(actor, { key : "inspiringSmite", label : subclasses.has(actor, this.INSPIRING).name,
      text : module.format("subclasses.paladin.inspiringText", { name : actor.name }) });
  }

  static async inspiringSmite(actor){
    const me = tokenOf(actor);
    const item = subclasses.has(actor, this.INSPIRING);
    const channel = subclasses.has(actor, this.CHANNEL);
    if(!me || !item || !channel) return false;
    const tokens = await pickTargets(me, { count : 12, range : 30, disposition : "any", includeSelf : true, confirm : "enter", useTargets : false });
    if(!tokens?.length || !(Number(channel.system?.uses?.value) > 0)) return false;
    const roll = await new Roll("2d8 + @classes.paladin.levels", actor.getRollData()).evaluate();
    const { rollItem } = await import('../../roll-item/roll-item.js');
    await rollItem.showDice([roll]);
    const shares = await divideAmong(tokens, roll.total, { title : item.name, prompt : module.format("subclasses.paladin.inspiringPrompt", { total : roll.total }) });
    /* Cancelled : no use spent */
    if(!shares || !await spendUses(channel, 1)) return false;
    const others = [];
    for(const [t, n] of shares){
      if(!(n > 0)) continue;
      if(gm.mine(t.actor)) await tempHP(t.actor, n, item);
      else others.push([t.document.uuid, n]);
    }
    if(others.length){
      const list = others.map(([uuid, n]) => `${fromUuidSync(uuid, { strict : false })?.name ?? "?"} ${n}`).join(", ");
      await gm.ask("inspiringSmite", { shares : others, item : item.name }, { actor, label : module.i18n("subclasses.paladin.giveTemp"),
        text : module.format("subclasses.paladin.inspiringAsk", { name : actor.name, list }) });
    }
    return true;
  }

  static async tempAsGM({ shares = [], item = "" } = {}){
    for(const [uuid, n] of shares){
      const target = fromUuidSync(uuid, { strict : false });
      if(target?.actor) await tempHP(target.actor, n, item);
    }
    return true;
  }

  /* ---------- Vengeance ---------- */

  static vowOf(actor){
    return actor?.effects?.find?.(e => e.getFlag(module.id, "vow")) ?? null;
  }

  /* The vow on the Paladin, naming its creature; the item's own effect isn't put on the target */
  static async vow(actor, activity, results){
    const target = [...game.user.targets][0];
    if(!target) return;
    const card = await uses.cardOf(results);
    const message = (card?.documentName === "ChatMessage") ? card : (card?.message ?? null);
    if(message?.isOwner) for(const e of activity.item.effects) new CardBuilder(message).remove(e.name);
    await this.setVow(actor, activity.item, target);
  }

  static async setVow(actor, item, target){
    const old = this.vowOf(actor);
    if(old) await old.delete();
    await actor.createEmbeddedDocuments("ActiveEffect", [{ name : module.format("subclasses.paladin.vowName", { item : item.name, name : target.name }),
      img : item.img, origin : item.uuid, duration : { seconds : 60 }, start : { time : game.time.worldTime },
      flags : { [module.id] : { vow : { target : target.document.uuid } } } }]);
  }

  static vowMode(config){
    if(!this.enabled()) return;
    const vow = this.vowOf(config.subject?.actor);
    const target = conditions.targetOf(config);
    if(vow && target && (vow.getFlag(module.id, "vow").target === target.document.uuid) && config.rolls?.[0]) giveMode(config.rolls[0], "advantage", vow.name);
  }

  /* Its creature at 0 HP : the vow may move */
  static async onDown(actor, changes){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    const hp = foundry.utils.getProperty(changes ?? {}, "system.attributes.hp.value");
    if((hp === undefined) || (Number(hp) > 0)) return;
    const uuids = new Set([actor.token?.uuid, ...actor.getActiveTokens(false, true).map(t => t.uuid)].filter(Boolean));
    for(const paladin of game.actors.filter(a => uuids.has(this.vowOf(a)?.getFlag(module.id, "vow")?.target))){
      await subclasses.offer(paladin, { key : "vowTransfer", label : module.i18n("subclasses.paladin.transfer"),
        text : module.format("subclasses.paladin.transferText", { name : paladin.name, target : actor.name }) });
    }
  }

  static async transferVow(actor){
    const vow = this.vowOf(actor);
    const item = subclasses.has(actor, this.VOW);
    if(!vow || !item) return false;
    const [target] = await pickTargets(tokenOf(actor), { count : 1, range : 30, disposition : "nonAlly", confirm : "auto", useTargets : false }) ?? [];
    if(!target) return false;
    await vow.update({ name : module.format("subclasses.paladin.vowName", { item : item.name, name : target.name }), [`flags.${module.id}.vow.target`] : target.document.uuid });
    return true;
  }
}
