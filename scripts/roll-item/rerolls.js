import { module } from '../module.js';
import { buttonRow, addButton, makeButton, esc } from '../helpers/utils.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { spendUses } from '../helpers/items.js';
const log = logger.for(import.meta.url);

/**
 * A die added to a roll already made (Bardic Inspiration) : the same roll, with "+ 1d6" rolled onto its end; with
 * subtract, "- 1d6" (Cutting Words). A number ("4") adds that, already rolled elsewhere.
 * @param {Roll} roll
 * @param {string} formula   "1d6"
 * @param {object} [options]
 * @param {boolean} [options.subtract=false]
 * @returns {Promise<{ updated : Roll, extra : Roll }>}
 */
export async function addDie(roll, formula, { subtract = false } = {}){
  const extra = await new Roll(String(formula)).evaluate();
  const updated = roll.constructor.fromData(foundry.utils.deepClone(roll.toJSON()));
  const { RollTerm } = foundry.dice.terms;
  updated.terms.push(RollTerm.fromData({ class : "OperatorTerm", operator : subtract ? "-" : "+", evaluated : true }));
  for(const term of extra.terms) updated.terms.push(RollTerm.fromData(term.toJSON()));
  updated._formula = updated.constructor.getFormula(updated.terms);
  updated._total = updated._evaluateTotal();
  return { updated, extra };
}

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

  const updated = roll.constructor.fromData(foundry.utils.deepClone(roll.toJSON()));
  const d20 = updated.dice[0];
  let extra = null;
  if(mode === -want){
    /* The opposite : they cancel, a straight roll on the first d20 */
    d20.modifiers = (d20.modifiers ?? []).filter(m => !/^(k[hl]|adv|dis)/i.test(m));
    d20.results.forEach((r, i) => { r.active = (i === 0); r.discarded = (i !== 0); });
    updated.options.advantageMode = 0;
  }
  else {
    extra = await new Roll("1d20").evaluate();
    /* Made straight before (advantage and disadvantage cancelled) : the d20 it kept and the new one */
    d20.results = d20.results.filter(r => r.active);
    d20.number = d20.results.length + 1;
    d20.modifiers = [...(d20.modifiers ?? []).filter(m => !/^(k[hl]|adv|dis)/i.test(m)), keep];
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
 * Reroll buttons go on their messages, and on our cards' rows for the saves they link.
 * Rules plug in through hooks (Roll Item knows none of them) :
 *   macro-helper.rerollButtons (message, buttons, { actor, roll }) : push { id, icon, label, run() } (Lucky, Bardic
 *                                Inspiration, Tactical Mind); shown beside Reroll, on the message and on card rows
 *   macro-helper.rerollable (message) : return false when the test can't be changed at all (an automatic failure)
 *   macro-helper.preReroll (who, what) : return false to stop a reroll (Rule Limits)
 * A save rolled from one of our cards (a row, an on-hit rider) is linked to it : the card re-reads the result, so its
 * ✓/✗ and Apply follow. Rerolled initiative moves the combatant in the tracker too.
 */
export class rerolls{
  static register(){
    if(game.system.id !== "dnd5e") return;
    /* dnd5e rebuilds its roll messages after core's render hook : add the buttons once it's done */
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.addButtons(message, html));
    /* Debug (the GM, Debug setting) : the d20 set to 20 or 1, small icons by the reroll (save card rows too) */
    Hooks.on(`${module.id}.rerollButtons`, (message, buttons) => {
      if(!game.user.isGM || !settings.value("debug")) return;
      buttons.push({ id : "debug20", icon : "fa-bug", label : module.i18n("rollItem.debug.nat20"), iconOnly : true, run : () => this.force(message, 20) });
      buttons.push({ id : "debug1", icon : "fa-bug-slash", label : module.i18n("rollItem.debug.nat1"), iconOnly : true, run : () => this.force(message, 1) });
    });
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

  /* May this reroll happen : false when a rule stops it (Rule Limits) */
  static mayReroll(who, what){
    return Hooks.call(`${module.id}.preReroll`, who, what) !== false;
  }

  /**
   * Which buttons a d20 message offers this user : Reroll (the roller and the GM), and what rules add (rerollButtons).
   * Also used by our cards' rows.
   * @param {ChatMessage} message
   * @returns {{ reroll : boolean, buttons : object[], actor : Actor|null }}
   */
  static optionsFor(message){
    const [roll] = message?.rolls ?? [];
    const actor = message?.getAssociatedActor?.() ?? null;
    if(Hooks.call(`${module.id}.rerollable`, message) === false) return { reroll : false, buttons : [], actor };
    const reroll = !!(message?.isOwner || game.user.isGM);
    const buttons = [];
    Hooks.callAll(`${module.id}.rerollButtons`, message, buttons, { actor, roll });
    return { reroll, buttons : buttons.filter(b => b?.id && b?.label && (typeof b.run === "function")), actor };
  }

  /* The buttons, styled like an attack card's (icon buttons in an icon row) */
  static addButtons(message, html){
    if(!settings.value("rollItem") || !this.isTest(message) || !message.isContentVisible) return;
    if(html.querySelector(`.${module.id}-rerolls`)) return;
    const { reroll, buttons : added } = this.optionsFor(message);
    const buttons = [];
    if(reroll) buttons.push({ id : "reroll", icon : "fa-rotate", label : module.i18n("rerolls.reroll"), run : event => this.reroll(message, event) });
    buttons.push(...added);
    if(!buttons.length) return;

    const row = buttonRow(html, { key : `${module.id}-rerolls`, layout : "icons" });
    for(const b of buttons){
      /* Words on the button, not just an icon : easy to miss otherwise (the GM's debug ones : just the icon) */
      if(b.iconOnly) addButton(row, makeButton({ icon : b.icon, label : b.label, className : "icon", onClick : event => b.run(event) }));
      else addButton(row, makeButton({ icon : b.icon, label : b.label, text : b.short ?? b.label, className : `${module.id}-labelled`,
        onClick : event => b.run(event) }));
    }
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
    if(!this.mayReroll(message.getAssociatedActor?.()?.name ?? message.speaker?.alias, message.flavor || message.rolls?.[0]?.formula)) return;
    const mode = await this.modeFor(event);
    if(!mode) return;
    const [roll] = message.rolls;
    let updated = await roll.reroll();
    const keep = (mode.advantage && !mode.disadvantage) ? "kh" : (mode.disadvantage && !mode.advantage) ? "kl" : null;
    if(keep) updated = (await extraD20(updated, keep))?.updated ?? updated;
    await this.replace(message, updated, [updated]);
  }

  /* Debug : the message's d20 shows a set number */
  static async force(message, value){
    const [roll] = message.rolls;
    if(!roll || !game.user.isGM) return;
    const updated = Roll.fromData(foundry.utils.deepClone(roll.toJSON()));
    const d20 = updated.dice?.[0];
    if(!d20) return;
    d20.results = d20.results.map(r => ({ ...r, result : value }));
    updated._total = updated._evaluateTotal();
    await this.replace(message, updated, []);
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

/* ---------- The failed-test lego ---------- */

const failRules = [];
let failHooked = false;

/**
 * The failed-test lego : a die a creature adds to one of its D20 Tests that failed (Bardic Inspiration), said once. Its
 * owner gets a button on the failed roll : a missed attack on a card, or a failed save or check (its message, and the
 * card rows that link it; not initiative). The die is rolled onto that roll (the card re-judges it), once per roll.
 *
 *   onFailedTest({
 *     id : "bardic",                          its key (the roll's flag)
 *     tests : ["attack", "save", "check"],    which D20 Tests (default : all three)
 *     source : actor => ({ die }) | null,     what the creature can add now (null : no button)
 *     formula : source => "1d6",
 *     label : source => "Use Bardic Inspiration (1d6)", icon : "fa-music",
 *     after : (actor, source, message) => {}, once it's added (the die used up)
 *     cost : (actor, source) => item,         an item one use of which pays for it (Second Wind); none : nothing spent
 *     pay : "use" | "success",                when `cost` is spent : on the button (default), or only if the roll
 *                                             then succeeds (Tactical Mind); a save or check with no DC known : the
 *                                             GM's Spend button on its message
 *     when : ({ actor, message, roll, ability }) => true,   which failed saves or checks (Guarded Mind : INT, WIS, CHA saves)
 *     succeed : true,                         no die : the save or check succeeds instead (what it was short of its DC is
 *                                             added; with no DC known, it's said in chat)
 *   })
 * A roll with no DC or AC known counts as failed (its owner judges).
 */
export function onFailedTest(rule){
  if(!rule?.id || failRules.some(r => r.id === rule.id)) return;
  failRules.push(rule);
  if(failHooked) return;
  failHooked = true;
  Hooks.on(`${module.id}.rerollButtons`, (message, buttons, { actor, roll }) => failTestButtons(message, buttons, actor, roll));
  Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => failAttackButtons(message, buttons, ray ?? null));
  Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => {
    if(String(id).startsWith("failedTest|")) failAttackClicked(message, String(id).slice(11), ray ?? null);
  });
}

/* A D20 Test that failed : below its DC / AC, or with none known */
export function failedRoll(roll){
  if(!roll) return false;
  const target = roll.options?.target;
  return !Number.isFinite(target) || (roll.total < target);
}

const testsOf = rule => rule.tests ?? ["attack", "save", "check"];
const rayKey = ray => Number.isInteger(ray) ? String(ray) : "single";

/* A save / check message : its owner's button, once; the GM's Spend button while the result isn't known */
function failTestButtons(message, buttons, actor, roll){
  if(!actor?.isOwner || message.getFlag?.("core", "initiativeRoll")) return;
  for(const rule of failRules){
    const done = message.getFlag?.(module.id, rule.id);
    if(game.user.isGM && rule.cost && (done?.pay === "unknown")){
      const item = rule.cost(actor, null);
      if(item) buttons.push({ id : `${rule.id}Spend`, icon : "fa-heart-crack", label : module.format("rerolls.spend", { item : item.name }), run : async () => {
        if(message.getFlag(module.id, rule.id)?.pay !== "unknown") return;
        await spendUses(item, 1, { warn : true });
        await message.setFlag(module.id, `${rule.id}.pay`, "spent");
      } });
    }
    if(!failedRoll(roll) || !testsOf(rule).includes(message.type) || done) continue;
    const ability = message.system?.ability ?? roll?.options?.ability ?? message.flags?.dnd5e?.roll?.ability ?? null;
    try { if(rule.when && !rule.when({ actor, message, roll, ability })) continue; } catch(error){ log.error("Failed test rule", rule.id, error); continue; }
    const source = rule.source(actor);
    if(!source) continue;
    buttons.push({ id : rule.id, icon : rule.icon ?? "fa-dice", label : rule.label(source), run : async () => {
      const now = rule.source(actor);
      if(!now || !message.isOwner || message.getFlag?.(module.id, rule.id)) return;
      const dc = message.rolls[0]?.options?.target;
      if(rule.succeed && !Number.isFinite(dc)){
        await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
          content : `<p>${esc(module.format("rerolls.succeeds", { name : actor.name, source : rule.label(now) }))}</p>` });
        await message.setFlag(module.id, rule.id, { pay : await payFor(rule, actor, now, true) });
        await rule.after?.(actor, now, message);
        return;
      }
      const formula = rule.succeed ? String(Math.max(0, dc - message.rolls[0].total)) : rule.formula(now);
      const { updated, extra } = await addDie(message.rolls[0], formula);
      await rerolls.replace(message, updated, [extra]);
      const target = updated.options?.target;
      const pay = await payFor(rule, actor, now, Number.isFinite(target) ? (updated.total >= target) : null);
      await message.setFlag(module.id, rule.id, { pay });
      await rule.after?.(actor, now, message);
    } });
  }
}

/* The rule's cost, by its `pay` : "spent", "none" (it failed anyway, or nothing to pay) or "unknown" (the GM's button) */
async function payFor(rule, actor, source, success){
  const item = rule.cost?.(actor, source);
  if(!item) return "none";
  if((rule.pay === "success") && (success !== true)) return (success === false) ? "none" : "unknown";
  await spendUses(item, 1, { warn : true });
  return "spent";
}

/* A missed attack on a card : the attacker's owner's button, once per attack */
function failAttackButtons(message, buttons, ray){
  if(typeof message.system?.addBonus !== "function") return;
  const attacker = message.getAssociatedActor?.();
  if(!attacker?.isOwner || !message.system.attackOf?.(ray) || message.system.isHitOn?.(ray)) return;
  for(const rule of failRules){
    if(!testsOf(rule).includes("attack") || message.getFlag?.(module.id, `${rule.id}.${rayKey(ray)}`)) continue;
    const source = rule.source(attacker);
    if(source) buttons.push({ id : `failedTest|${rule.id}`, label : rule.label(source), icon : rule.icon ?? "fa-dice" });
  }
}

async function failAttackClicked(message, id, ray){
  const rule = failRules.find(r => r.id === id);
  const attacker = message.getAssociatedActor?.();
  const source = rule && attacker && rule.source(attacker);
  if(!source || !message.isOwner || message.getFlag?.(module.id, `${rule.id}.${rayKey(ray)}`)) return;
  if(!await message.system.addBonus(ray, rule.formula(source))) return;
  await message.setFlag(module.id, `${rule.id}.${rayKey(ray)}`, true);
  await payFor(rule, attacker, source, !!message.system.isHitOn?.(ray));
  await rule.after?.(attacker, source, message);
}
