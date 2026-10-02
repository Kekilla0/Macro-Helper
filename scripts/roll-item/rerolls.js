import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { findItem } from '../helpers/actors.js';
import { spendUses } from '../helpers/items.js';
const log = logger.for(import.meta.url);

/**
 * A second d20 for a roll already made, keeping the higher ("kh", advantage) or lower ("kl", disadvantage).
 * Advantage and disadvantage don't stack : the same as the roll already had changes nothing ("same"); the opposite
 * cancels to a straight roll on the first d20 ("cancelled"). Shared by attack cards and save / check messages.
 * @param {D20Roll} roll
 * @param {"kh"|"kl"} keep
 * @returns {Promise<{ status : "applied"|"cancelled"|"same", updated : D20Roll|null, extra : Roll|null }|null>}
 *          null if the roll has no d20
 */
export async function extraD20(roll, keep){
  const term = roll?.dice?.[0];
  if(term?.faces !== 20) return null;
  const want = (keep === "kh") ? 1 : -1;
  const mode = Number(roll.options?.advantageMode ?? 0);
  if(mode === want) return { status : "same", updated : null, extra : null };

  const updated = roll.constructor.fromData(roll.toJSON());
  const d20 = updated.dice[0];
  let extra = null;
  if(mode === -want){
    /* The opposite : they cancel, a straight roll on the first d20 */
    d20.modifiers = (d20.modifiers ?? []).filter(m => !/^k[hl]/i.test(m));
    d20.results.forEach((r, i) => { r.active = (i === 0); r.discarded = (i !== 0); });
    updated.options.advantageMode = 0;
  }
  else {
    extra = await new Roll("1d20").evaluate();
    d20.number = (d20.number ?? 1) + 1;
    d20.modifiers = [...(d20.modifiers ?? []).filter(m => !/^k[hl]/i.test(m)), keep];
    d20.results.push({ result : extra.total, active : true });
    const active = d20.results.filter(r => r.active);
    const best = (keep === "kh") ? Math.max(...active.map(r => r.result)) : Math.min(...active.map(r => r.result));
    let kept = false;
    for(const r of d20.results){
      if(!r.active) continue;
      if(!kept && (r.result === best)){ kept = true; continue; }
      r.active = false; r.discarded = true;
    }
    updated.options.advantageMode = want;
  }
  updated._total = updated._evaluateTotal();
  return { status : extra ? "applied" : "cancelled", updated, extra };
}

/**
 * dnd5e's own d20 tests : saving throws, ability checks (skills, tools), death saves and initiative.
 *   No dialog     : with the Advantage setting on keys or neither, they roll straight away (keys still count); on
 *                   "ask", dnd5e's own dialog is the asking.
 *   Reroll        : the roller and the GM; replaces the roll, with advantage / disadvantage chosen the same way.
 * Reroll and Lucky buttons go on their messages, and on our cards' rows for the saves they link.
 *   Lucky (n)     : the owner of a creature with the Lucky feat and a Luck Point left; a second d20, the higher kept.
 * A save rolled from one of our cards (a row, an on-hit rider) is linked to it : the card re-reads the result, so its
 * ✓/✗ and Apply follow. Rerolled initiative moves the combatant in the tracker too.
 */
export class rerolls{
  static register(){
    if(game.system.id !== "dnd5e") return;
    /* dnd5e rebuilds its roll messages after core's render hook : add the buttons once it's done */
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.addButtons(message, html));
    for(const hook of ["AbilityCheck", "SavingThrow", "DeathSave", "Concentration"]){
      Hooks.on(`dnd5e.preRoll${hook}V2`, (config, dialog) => this.skipDialog(config, dialog));
    }
  }

  /* No roll dialog unless the Advantage setting asks; on "neither", held keys don't count either */
  static skipDialog(config, dialog){
    if(!settings.value("rollItem") || !dialog) return;
    const mode = settings.value("rollItemAdvantage");
    if(mode === "prompt") return;
    dialog.configure = false;
    if(mode === "none") config.event = undefined;
  }

  /**
   * Advantage / disadvantage for a reroll, chosen like Roll Item's : the keys held, the prompt, or neither.
   * @param {Event} [event]
   * @returns {Promise<{ advantage? : boolean, disadvantage? : boolean }|null>}  null when the prompt was closed
   */
  static async modeFor(event){
    const setting = settings.value("rollItemAdvantage");
    const { rollItem } = await import('./roll-item.js');
    if(setting === "prompt") return rollItem.chooseMode(null, event);
    if(setting !== "keys") return {};
    const keys = dnd5e.utils?.areKeysPressed;
    const held = rollItem.keyEvent(event);
    return { advantage : !!keys?.(held, "skipDialogAdvantage"), disadvantage : !!keys?.(held, "skipDialogDisadvantage") };
  }

  static isInitiative(message){
    return !!message.getFlag?.("core", "initiativeRoll");
  }

  /* A d20 test we offer buttons on : a save, a check (skill, tool), or initiative */
  static isTest(message){
    const [roll] = message.rolls ?? [];
    if(!(roll instanceof CONFIG.Dice.D20Roll) || (roll.dice?.[0]?.faces !== 20)) return false;
    return ["save", "check"].includes(message.type) || this.isInitiative(message);
  }

  static luckyOf(actor){
    const feat = actor && findItem(actor, "lucky");
    return (feat && (Number(feat.system.uses?.value) > 0)) ? feat : null;
  }

  /**
   * Which buttons a d20 message offers this user : Reroll (the roller and the GM), Lucky (the owner of a creature with
   * the Lucky feat and a point left, once, not on a roll that already has advantage). Also used by our cards' rows.
   * @param {ChatMessage} message
   * @returns {{ reroll : boolean, lucky : Item|null, actor : Actor|null }}
   */
  static optionsFor(message){
    const [roll] = message?.rolls ?? [];
    const actor = message?.getAssociatedActor?.() ?? null;
    /* An automatic failure fails whatever is rolled */
    if(message?.getFlag?.(module.id, "autoFail")) return { reroll : false, lucky : null, actor };
    const reroll = !!(message?.isOwner || game.user.isGM);
    const feat = actor?.isOwner && settings.value("traitRules") && this.luckyOf(actor);
    const lucky = (feat && !message.getFlag(module.id, "lucky") && (Number(roll?.options?.advantageMode ?? 0) !== 1)) ? feat : null;
    return { reroll, lucky, actor };
  }

  /* The buttons, styled like an attack card's (icon buttons in an icon row) */
  static addButtons(message, html){
    if(!settings.value("rollItem") || !this.isTest(message) || !message.isContentVisible) return;
    if(html.querySelector(`.${module.id}-rerolls`)) return;
    const { reroll, lucky, actor } = this.optionsFor(message);
    const buttons = [];
    if(reroll) buttons.push({ id : "reroll", icon : "fa-rotate", label : module.i18n("rerolls.reroll") });
    if(lucky) buttons.push({ id : "lucky", icon : "fa-clover", label : module.format("feats.lucky.adv", { name : lucky.name, left : lucky.system.uses.value }) });
    if(!buttons.length) return;

    const row = document.createElement("section");
    row.className = `icon-row ${module.id}-rerolls`;
    row.innerHTML = `<i class="fa-solid fa-fw fa-circle-play" inert></i><ul class="unlist"></ul>`;
    const list = row.querySelector("ul");
    for(const b of buttons){
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "icon";
      button.dataset.tooltip = b.label;
      button.ariaLabel = b.label;
      button.innerHTML = `<i class="fa-solid ${b.icon}" inert></i>`;
      button.addEventListener("click", async event => {
        event.preventDefault();
        button.disabled = true;
        try { await ((b.id === "lucky") ? this.lucky(message, actor) : this.reroll(message, event)); }
        catch(error){ console.error("Macro Helper | reroll", error); ui.notifications.warn(error.message); }
        finally { button.disabled = false; }
      });
      li.append(button);
      list.append(li);
    }
    (html.querySelector(".message-content") ?? html).append(row);
  }

  /* Swap the message's d20 roll for another, shown first; initiative moves the combatant too */
  static async replace(message, updated, shown){
    const { rollItem } = await import('./roll-item.js');
    await rollItem.showDice(shown, message);
    const update = { rolls : [updated, ...message.rolls.slice(1)].map(r => JSON.stringify(r)) };
    if(game.dice3d) update["flags.dice-so-nice.skip"] = true;
    await message.update(update);
    if(this.isInitiative(message)) await this.moveInitiative(message, updated.total);
    log.debug("Rerolled", message.id, updated.total);
  }

  /* A fresh roll; advantage / disadvantage chosen now adds a second d20 (cancelling with any already on it) */
  static async reroll(message, event){
    if(!(message.isOwner || game.user.isGM)) return;
    const mode = await this.modeFor(event);
    if(!mode) return;
    const [roll] = message.rolls;
    let updated = await roll.reroll();
    const keep = (mode.advantage && !mode.disadvantage) ? "kh" : (mode.disadvantage && !mode.advantage) ? "kl" : null;
    if(keep) updated = (await extraD20(updated, keep))?.updated ?? updated;
    await this.replace(message, updated, [updated]);
  }

  static async lucky(message, actor){
    const feat = actor?.isOwner && this.luckyOf(actor);
    if(!feat || !message.isOwner) return;
    const result = await extraD20(message.rolls[0], "kh");
    if(!result) return;
    if(result.status === "same") return ui.notifications.info(module.i18n("feats.lucky.same"));
    await this.replace(message, result.updated, result.extra ? [result.extra] : []);
    await spendUses(feat, 1, { warn : false });
    await message.setFlag(module.id, "lucky", true);
  }

  /* The initiative in the tracker follows a rerolled initiative message */
  static async moveInitiative(message, total){
    const { token, actor } = message.speaker ?? {};
    for(const combat of game.combats){
      const combatant = combat.combatants.find(c => (token && (c.tokenId === token)) || (!token && (c.actorId === actor)));
      if(combatant?.isOwner) await combatant.update({ initiative : total });
    }
  }
}
