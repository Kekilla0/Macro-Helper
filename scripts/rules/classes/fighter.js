import { module } from '../../module.js';
import { idOf } from '../../helpers/utils.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { addTimedEffect } from '../../helpers/actors.js';
import { spendUses } from '../../helpers/items.js';
import { chooseOne } from '../../helpers/creatures.js';
import { compendiums } from '../compendiums.js';
import { limits } from '../limits.js';
import { restChoices } from '../rest-choices.js';
const log = logger.for(import.meta.url);

/**
 * Fighter, levels 1-2 (Classes setting). Second Wind is the item's own data; Weapon Mastery is rules/weapon-mastery.js;
 * the Fighting Style feats are rules/fighting-styles.js.
 *
 *   Action Surge   : using it marks the Fighter (Action Surge) until the end of its turn, for the action tracker's
 *                    extra action (not a Magic action).
 *   Tactical Mind  : on a failed ability check, its owner rolls Tactical Mind : 1d10 added to the check, nothing
 *                    spent. If that makes it a success, the GM spends the Second Wind use from the message.
 *   Fighting Style : gaining a Fighter, Paladin or Ranger level allows one swap (Rest Choices), from the
 *                    compendium "Fighting Styles" (Macro Helper; Plutonium's feats, dragged in).
 */
export class fighter{
  static ACTION_SURGE = "action-surge";
  static TACTICAL_MIND = "tactical-mind";
  static SECOND_WIND = "second-wind";
  /* The Fighting Style feats, by identifier (a feat chosen through the class feature : "fighting-style-<id>") */
  static STYLES = ["archery", "blind-fighting", "defense", "dueling", "great-weapon-fighting", "interception", "protection",
    "thrown-weapon-fighting", "two-weapon-fighting", "unarmed-fighting", "blessed-warrior", "druidic-warrior"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.postUseActivity", activity => this.onUse(activity));
    restChoices.add({
      id : "fightingStyle", label : "restChoices.fightingStyle", rest : "level", classes : ["fighter", "paladin", "ranger"],
      applies : actor => this.enabled() && !!this.styleOf(actor),
      grant : actor => actor.setFlag(module.id, "styleSwaps", 1),
      summary : actor => module.format("classes.fighter.styleSummary", { name : this.styleOf(actor)?.name ?? "—",
        swaps : Number(actor.getFlag(module.id, "styleSwaps")) || 0 }),
      open : actor => this.swapStyle(actor),
    });
  }


  /* A Fighting Style feat's own name ("dueling" for "fighting-style-dueling") */
  static styleId(item){
    const id = idOf(item).replace(/^fighting-style-/, "");
    return this.STYLES.includes(id) ? id : null;
  }

  static styleOf(actor){
    return actor?.items?.find(i => (i.type === "feat") && this.styleId(i)) ?? null;
  }

  /* ---------- Action Surge ---------- */

  static async onUse(activity){
    if(!this.enabled() || (idOf(activity?.item) !== this.ACTION_SURGE) || !activity.actor?.isOwner) return;
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    if(actor.effects.some(e => e.getFlag(module.id, "actionSurge"))) return;
    await addTimedEffect(actor, { name : activity.item.name, img : activity.item.img, flags : { [module.id] : { actionSurge : true } } }, { until : "turnEnd", thisTurn : true });
    log.debug("Action Surge", actor.name);
  }

  /* ---------- Tactical Mind ---------- */

  static secondWindOf(actor){
    return actor?.items?.find(i => idOf(i) === this.SECOND_WIND) ?? null;
  }

  /* Can the owner roll it on this check : a Fighter with Tactical Mind and a Second Wind use left, not rolled yet */
  static canTactical(message, actor){
    if(!this.enabled() || (message?.type !== "check") || !actor?.isOwner) return false;
    if(message.getFlag(module.id, "tacticalMind")) return false;
    if(!actor.items.some(i => idOf(i) === this.TACTICAL_MIND)) return false;
    return Number(this.secondWindOf(actor)?.system?.uses?.value) > 0;
  }

  /* The GM's button : it was rolled and the Second Wind use isn't spent yet */
  static canSpend(message){
    const info = message?.getFlag?.(module.id, "tacticalMind");
    /* A known DC that it still missed : nothing to spend */
    return !!(game.user.isGM && info && !info.spent && (info.success !== false));
  }

  /* GM : the check succeeded with it, the Second Wind use goes */
  static async spendSecondWind(message){
    if(!this.canSpend(message)) return;
    const actor = message.getAssociatedActor?.();
    const secondWind = this.secondWindOf(actor);
    if(secondWind) await spendUses(secondWind, 1, { warn : true });
    await message.setFlag(module.id, "tacticalMind.spent", true);
  }

  /* ---------- Fighting Style ---------- */

  /**
   * The class link a Fighting Style feat should carry, so the sheet files it under the class (Plutonium's chosen feat
   * has none : it sits in Other Features) : the class's own Fighting Style feature's link, else the class itself.
   * @returns {string|null}  "<class item id>.<advancement id>"
   */
  static styleOrigin(actor){
    const feature = actor.items.find(i => (idOf(i) === "fighting-style") && i.getFlag("dnd5e", "advancementOrigin"));
    if(feature) return feature.getFlag("dnd5e", "advancementOrigin");
    const cls = ["fighter", "paladin", "ranger"].map(id => actor.classes?.[id]).find(Boolean);
    return cls ? `${cls.id}.fightingStyle` : null;
  }

  /**
   * Swap the Fighting Style feat for another from the Fighting Styles compendium : one swap per level gained
   * (the GM : freely). The new feat is a copy of the compendium.s; the old one is removed.
   */
  static async swapStyle(actor){
    const current = this.styleOf(actor);
    const swaps = game.user.isGM ? Infinity : (Number(actor.getFlag(module.id, "styleSwaps")) || 0);
    let past = false;
    if(!(swaps > 0)){
      if(!limits.canGoPast()) return ui.notifications.warn(module.format("classes.fighter.noStyleSwap", { name : actor.name }));
      /* Rule Limits on Off / Warn : allowed on purpose, the GM told */
      past = await foundry.applications.api.DialogV2.confirm({ window : { title : module.i18n("restChoices.fightingStyle") },
        content : `<p>${foundry.utils.escapeHTML(module.format("classes.fighter.pastPrompt", { name : actor.name }))}</p>`, rejectClose : false });
      if(!past) return;
    }
    const owned = new Set(actor.items.map(i => this.styleId(i)).filter(Boolean));
    const all = (await compendiums.entries(compendiums.FIGHTING_STYLES)).filter(i => this.styleId(i));
    if(!all.length) return ui.notifications.warn(module.i18n("classes.fighter.noStyles"));
    const styles = all.filter(i => !owned.has(this.styleId(i)));
    if(!styles.length) return ui.notifications.warn(module.format("classes.fighter.allStyles", { name : actor.name }));
    const chosen = await chooseOne(styles.map(i => ({ value : i.uuid, label : i.name, img : i.img })), {
      title : module.format("classes.fighter.styleTitle", { name : actor.name }), icon : "fa-solid fa-shield-halved", columns : 3,
      prompt : module.format("classes.fighter.stylePrompt", { name : current?.name ?? "—" }),
    });
    const source = chosen ? await fromUuid(chosen) : null;
    if(!source) return;
    const data = source.toObject();
    delete data._id;
    /* In the old one's place : its id (the class's advancement still points to it) and its class link, so the sheet
       files it under the class's features, not Other Features */
    const origin = current?.getFlag("dnd5e", "advancementOrigin") ?? this.styleOrigin(actor);
    if(origin) foundry.utils.setProperty(data, "flags.dnd5e.advancementOrigin", origin);
    if(current){
      data._id = current.id;
      await current.delete();
    }
    await actor.createEmbeddedDocuments("Item", [data], { keepId : !!current });
    if(Number.isFinite(swaps)) await actor.setFlag(module.id, "styleSwaps", Math.max(0, swaps - 1));
    if(past) await limits.tellGM({ who : actor.name, what : module.format("classes.fighter.styleSwapped", { from : current?.name ?? "—", to : source.name }), rule : module.i18n("classes.fighter.styleRule") });
    log.debug("Fighting Style", actor.name, current?.name, "->", source.name);
  }
}
