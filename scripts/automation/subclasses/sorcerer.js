import { module } from '../../module.js';
import { logger } from '../../log.js';
import { idOf, esc, buttonRow, addButton, makeButton } from '../../helpers/utils.js';
import { usedThisTurn, markUsedThisTurn } from '../../helpers/actors.js';
import { tokenOf, distanceBetween, canSee } from '../../helpers/tokens.js';
import { spendUses } from '../../helpers/items.js';
import { giveMode } from '../../roll-item/reasons.js';
import { TYPES } from '../../roll-item/message.js';
import { uses } from '../../uses.js';
import { rollModes } from '../roll-modes.js';
import { casting } from '../casting.js';
import { actionTracker } from '../action-tracker.js';
import { sorcerer } from '../classes/sorcerer.js';
import { subclasses } from './common.js';
const log = logger.for(import.meta.url);

/**
 * Sorcerer subclasses, level 3 (Subclasses setting). The subclass spells are the import's; Telepathic Speech and
 * Draconic Resilience (AC and Hit Points) are the items' data.
 *
 *   Clockwork  Restore Balance   a creature the Sorcerer sees within 60 ft rolls a d20 with Advantage or Disadvantage
 *                                (an attack, a save, a check) : a button (a use, its Reaction) makes it a straight roll
 *                                (its first d20), after the roll rather than before.
 *   Wild Magic Tides of Chaos    using it : Advantage on its next D20 Test (an attack, a save or a check). Then it waits
 *                                for a Sorcerer spell cast with a slot (that cast rolls on the surge table, and it's back)
 *                                or a Long Rest.
 *              Wild Magic Surge  once a turn, a Sorcerer spell cast with a slot : a button on its card rolls the 1d20 (the
 *                                player's choice); a 20 : the surge. The
 *                                surge draws from a world Roll Table named "Wild Magic Surge" (the GM's own : the module
 *                                has no table), else its d100 is posted for the GM to read off the book's.
 */
export class sorcererOrigins{
  static RESTORE = "restore-balance";
  static TIDES = "tides-of-chaos";
  static SURGE = "wild-magic-surge";
  static TABLE = "Wild Magic Surge";

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => this.balanceButtons(message, buttons, ray ?? null));
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => { if(String(id).startsWith("balance|")) this.restore(message, ray ?? null, String(id).slice(8)); });
    Hooks.on(`${module.id}.rerollButtons`, (message, buttons, { roll }) => this.testButtons(message, buttons, roll));
    /* Tides of Chaos */
    uses.onItem("subclassItem", (item, ctx, next) => (this.enabled() && (idOf(item) === this.TIDES) && !item.system.activities?.size) ? this.tides(item) : next());
    Hooks.on("dnd5e.postUseActivity", (activity, usage) => { if(this.enabled() && (idOf(activity?.item) === this.TIDES)) this.tides(activity.item, { used : true }); });
    rollModes.add("tides", config => { const e = this.tidesEffect(config.subject?.actor); if(e && config.rolls?.[0]) giveMode(config.rolls[0], "advantage", e.name); });
    for(const hook of ["dnd5e.preRollSavingThrowV2", "dnd5e.preRollAbilityCheckV2", "dnd5e.preRollSkillV2", "dnd5e.preRollToolCheckV2"]){
      Hooks.on(hook, config => { const e = this.tidesEffect(config?.subject); if(e){ config.advantage = true; for(const r of config.rolls ?? []) if(r.options) r.options.advantage = true; } });
    }
    for(const hook of ["dnd5e.rollAttackV2", "dnd5e.rollSavingThrow", "dnd5e.rollAbilityCheck", "dnd5e.rollSkill", "dnd5e.rollToolCheck"]){
      Hooks.on(hook, (rolls, data = {}) => this.tidesSpent(data.subject?.actor ?? data.subject));
    }
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.afterSpell(activity, usage, results));
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.surgeButton(message, html));
    Hooks.on("dnd5e.restCompleted", (actor, result) => { if(result?.longRest && actor?.isOwner && subclasses.has(actor, this.TIDES)?.getFlag(module.id, "tidesUsed")) subclasses.has(actor, this.TIDES).unsetFlag(module.id, "tidesUsed"); });
  }

  /* ---------- Clockwork : Restore Balance ---------- */

  static #done = new Set();

  /* This user's Clockwork Sorcerers that can steady that creature's roll */
  static balancers(creature){
    if(!this.enabled() || !creature) return [];
    return (canvas.tokens?.placeables ?? []).filter(t => t.actor?.isOwner && subclasses.has(t.actor, this.RESTORE)
      && ((t === creature) || ((distanceBetween(t, creature) <= 60) && canSee(t, creature))) && actionTracker.left(t.actor, "reaction")
      && (Number(subclasses.has(t.actor, this.RESTORE).system?.uses?.value) > 0) && !actionTracker.OUT_OF_ACTION.some(s => t.actor.statuses?.has?.(s)));
  }

  static uneven(roll){
    const mode = Number(roll?.options?.advantageMode ?? 0);
    return (mode !== 0) && ((roll?.dice?.[0]?.results?.length ?? 0) > 1);
  }

  static balanceButtons(message, buttons, ray){
    if((message.type !== TYPES.attack) || !this.uneven(message.system?.attackOf?.(ray)) || this.#done.has(`${message.id}|${ray}`)) return;
    const creature = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    for(const t of this.balancers(creature)) buttons.push({ id : `balance|${t.document.uuid}`, icon : "fa-scale-balanced", label : subclasses.has(t.actor, this.RESTORE).name });
  }

  static testButtons(message, buttons, roll){
    if(!["save", "check"].includes(message?.type) || !this.uneven(roll) || this.#done.has(`${message.id}|test`)) return;
    const creature = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    for(const t of this.balancers(creature)){
      buttons.push({ id : `balance-${t.id}`, icon : "fa-scale-balanced", label : subclasses.has(t.actor, this.RESTORE).name,
        run : () => this.restore(message, null, t.document.uuid, "test") });
    }
  }

  static async restore(message, ray, uuid, kind = null){
    const token = tokenOf(fromUuidSync(uuid ?? "", { strict : false }));
    const key = `${message.id}|${kind ?? ray}`;
    const item = subclasses.has(token?.actor, this.RESTORE);
    if(!token?.actor?.isOwner || !item || this.#done.has(key) || !await spendUses(item, 1)) return;
    this.#done.add(key);
    await actionTracker.spend(token.actor, { kind : "reaction", what : item.name }).catch(() => null);
    await subclasses.changeRoll(message, { ray, straight : true }, token.actor);
  }

  /* ---------- Wild Magic ---------- */

  static tidesEffect(actor){
    return this.enabled() ? (actor?.effects?.find?.(e => e.getFlag(module.id, "tides")) ?? null) : null;
  }

  /* Tides of Chaos used : Advantage on the next D20 Test, then it waits */
  static async tides(item, { used = false } = {}){
    const actor = item.actor;
    if(!actor?.isOwner) return null;
    if(item.getFlag(module.id, "tidesUsed") && !used){
      ui.notifications.warn(module.format("subclasses.sorcerer.tidesSpent", { name : actor.name }));
      return null;
    }
    await item.setFlag(module.id, "tidesUsed", true);
    /* The sheet's use too (an activity's use spends it already) */
    if(!used) await spendUses(item, 1, { warn : false });
    if(!this.tidesEffect(actor)) await actor.createEmbeddedDocuments("ActiveEffect", [{ name : item.name, img : item.img, origin : item.uuid,
      showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2, flags : { [module.id] : { tides : true } } }]);
    log.debug("Tides of Chaos", actor.name);
    return null;
  }

  static async tidesSpent(actor){
    const effect = this.tidesEffect(actor);
    if(effect?.isOwner) await effect.delete();
  }

  /* A Sorcerer spell from a slot : Tides of Chaos back (with a surge), or the once-a-turn d20 button on its card */
  static async afterSpell(activity, usage, results){
    const actor = activity?.actor;
    if(!this.enabled() || !actor?.isOwner || !sorcerer.isSorcererSpell(activity.item) || !casting.spendsSlot(activity, usage ?? {})) return;
    const tides = subclasses.has(actor, this.TIDES);
    if(tides?.getFlag(module.id, "tidesUsed")){
      await tides.unsetFlag(module.id, "tidesUsed");
      await spendUses(tides, -1, { warn : false });
      return this.surge(actor);
    }
    if(!subclasses.has(actor, this.SURGE) || usedThisTurn(actor, "wildSurge")) return;
    const card = await uses.cardOf(results);
    const message = (card?.documentName === "ChatMessage") ? card : (card?.message ?? results?.message);
    if(message?.isOwner) await message.setFlag(module.id, "wildSurge", actor.uuid);
  }

  /* Roll on Wild Magic Surge : its owner, until rolled or another spell this turn rolled */
  static surgeButton(message, html){
    const uuid = message.getFlag?.(module.id, "wildSurge");
    const actor = uuid ? fromUuidSync(uuid, { strict : false }) : null;
    if(!this.enabled() || !actor?.isOwner || !subclasses.has(actor, this.SURGE) || message.getFlag(module.id, "wildSurgeRolled")) return;
    const row = buttonRow(html, { key : `${module.id}-wild-surge` });
    if(row.childElementCount) return;
    addButton(row, makeButton({ icon : "fa-dice-d20", text : module.i18n("subclasses.sorcerer.surgeRoll"), once : true,
      onClick : () => this.surgeCheck(message, actor) }));
  }

  static async surgeCheck(message, actor){
    if(usedThisTurn(actor, "wildSurge")) return ui.notifications.warn(module.format("subclasses.sorcerer.surgeUsed", { name : actor.name }));
    await markUsedThisTurn(actor, "wildSurge");
    if(message.isOwner) await message.setFlag(module.id, "wildSurgeRolled", true);
    const roll = await new Roll("1d20").evaluate();
    await roll.toMessage({ speaker : ChatMessage.implementation.getSpeaker({ actor }), flavor : subclasses.has(actor, this.SURGE).name });
    if(roll.total === 20) await this.surge(actor);
  }

  /* The surge : the world's table, else its d100 for the GM */
  static async surge(actor){
    const table = game.tables?.getName?.(this.TABLE);
    if(table) return table.draw({ rollMode : CONST.DICE_ROLL_MODES?.PUBLIC ?? "publicroll" });
    const roll = await new Roll("1d100").evaluate();
    await roll.toMessage({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
      flavor : esc(module.format("subclasses.sorcerer.surge", { name : actor.name, table : this.TABLE })) });
  }
}
