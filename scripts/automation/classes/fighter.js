import { module } from '../../module.js';
import { idOf } from '../../helpers/utils.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { actionTracker } from '../action-tracker.js';
import { compendiums, pickFromCompendium } from '../compendiums.js';
import { restChoices } from '../rest-choices.js';
import { onFailedTest } from '../../roll-item/rerolls.js';
import { findItem } from '../../helpers/actors.js';
import { replaceItem } from '../../helpers/items.js';
const log = logger.for(import.meta.url);

/**
 * Fighter, levels 1-2 (Classes setting). Second Wind is the item's own data; Weapon Mastery is automation/weapon-mastery.js;
 * the Fighting Style feats are automation/fighting-styles.js.
 *
 *   Action Surge   : using it gives one more Action this turn (actionTracker.modify; not a Magic action).
 *   Tactical Mind  : on a failed ability check, its owner rolls Tactical Mind : 1d10 added to the check (onFailedTest).
 *                    Second Wind is spent only if that makes it a success; with no DC known, the GM's Spend button.
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
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && (idOf(activity?.item) === this.ACTION_SURGE)));
    Hooks.on("dnd5e.postUseActivity", activity => this.onUse(activity));
    /* Tactical Mind : 1d10 on a failed ability check; Second Wind spent only if it then succeeds */
    onFailedTest({ id : "tacticalMind", tests : ["check"], icon : "fa-chess-knight",
      source : actor => (this.enabled() && findItem(actor, this.TACTICAL_MIND) && (Number(this.secondWindOf(actor)?.system?.uses?.value) > 0)) ? {} : null,
      formula : () => "1d10", label : () => module.i18n("classes.fighter.tactical"),
      cost : actor => this.secondWindOf(actor), pay : "success" });
    restChoices.add({
      id : "fightingStyle", label : "restChoices.fightingStyle", rest : "level", classes : ["fighter", "paladin", "ranger"], count : 1,
      applies : actor => this.enabled() && !!this.styleOf(actor),
      summary : actor => module.format("classes.fighter.styleSummary", { name : this.styleOf(actor)?.name ?? "—",
        swaps : restChoices.swapsText(actor, "fightingStyle") }),
      state : actor => [this.styleOf(actor)?.name].filter(Boolean),
      open : (actor, swap) => this.swapStyle(actor, swap),
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

  /* One more Action this turn (the action tracker's pip) */
  static async onUse(activity){
    if(!this.enabled() || (idOf(activity?.item) !== this.ACTION_SURGE) || !activity.actor?.isOwner) return;
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    await actionTracker.modify(actor, "action", 1, activity.item.name);
    log.debug("Action Surge", actor.name);
  }

  /* ---------- Tactical Mind ---------- */

  static secondWindOf(actor){
    return actor?.items?.find(i => idOf(i) === this.SECOND_WIND) ?? null;
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
  static async swapStyle(actor, swap){
    const current = this.styleOf(actor);
    if(swap && !await swap.allow()) return;
    const owned = new Set(actor.items.map(i => this.styleId(i)).filter(Boolean));
    const all = (await compendiums.entries(compendiums.FIGHTING_STYLES)).filter(i => this.styleId(i));
    if(!all.length) return ui.notifications.warn(module.i18n("classes.fighter.noStyles"));
    if(all.every(i => owned.has(this.styleId(i)))) return ui.notifications.warn(module.format("classes.fighter.allStyles", { name : actor.name }));
    const source = await pickFromCompendium(i => this.styleId(i) && !owned.has(this.styleId(i)), { pack : compendiums.FIGHTING_STYLES,
      title : module.format("classes.fighter.styleTitle", { name : actor.name }), icon : "fa-solid fa-shield-halved", columns : 3,
      prompt : module.format("classes.fighter.stylePrompt", { name : current?.name ?? "—" }) });
    if(!source) return;
    /* In the old one's place, with its class link, so the sheet files it under the class's features */
    await replaceItem(current, source, { actor, origin : this.styleOrigin(actor) });
    await swap?.spend();
    log.debug("Fighting Style", actor.name, current?.name, "->", source.name);
  }
}
