import { module } from '../module.js';
import { esc, whisperGMTable } from '../helpers/utils.js';
import { settings } from '../settings.js';
import { gm } from '../gm.js';

/**
 * Rule Limits (System Automation) : what happens when something the rules don't allow is tried. One setting for all of
 * them (the key is still "weaponRules", the weapon handling checks were the first) :
 *   off    : nothing is checked
 *   warn   : a notice, it goes ahead
 *   block  : a notice, it's stopped
 * Rule Fixes (ruleFixes) : when changing something meets the rule (a weapon put in hand or equipped, hands freed, a
 * Versatile weapon held one-handed, a Druid leaving Wild Shape to cast) :
 *   off    : Rule Limits decides
 *   offer  : a Fix button (resolve : asked now; weapons : a card to fix it before rolling again), Rule Limits decides the rest
 *   auto   : fixed without asking
 *
 * Covered : weapon handling (weapons.js), Rage (no spells, not in heavy armor), Reckless Attack off your turn,
 * Savage Attacker and Cleave once a turn, Cleave melee only, Grapple / Shove / Push size, a spell from a Wild Shape
 * form, Interception and Protection's requirements.
 */
export class limits{
  static mode(){
    return settings.value("weaponRules") ?? "warn";
  }

  /* Rule Fixes : "off", "offer" or "auto" */
  static fixMode(){
    return settings.value("ruleFixes") ?? "off";
  }

  /* Anything to check at all : Rule Limits or Rule Fixes on */
  static checks(){
    return (this.mode() !== "off") || (this.fixMode() !== "off");
  }

  /**
   * Something the rules don't allow that a change would fix (Rule Fixes). Fix Automatically : fixed; Offer a Fix : asked
   * (Fix / Go ahead, when Rule Limits lets it / Cancel); Off : Rule Limits decides.
   * @param {string} rule              what the rules say
   * @param {object} options
   * @param {Function} options.fix     async : make the change
   * @param {string} [options.fixLabel]  the Fix button ("Leave the form and cast")
   * @param {string} [options.who]
   * @param {string} [options.what]
   * @returns {Promise<"fixed"|"allowed"|"stopped">}
   */
  static async resolve(rule, { fix, fixLabel, who = "", what = "" } = {}){
    const mode = this.fixMode();
    if(mode === "auto"){
      await fix();
      return "fixed";
    }
    if(mode === "offer"){
      const goAhead = this.mode() !== "block";
      const choice = await foundry.applications.api.DialogV2.wait({
        window : { title : what || module.i18n("limits.fixTitle"), icon : "fa-solid fa-scale-balanced" },
        content : `<p>${esc(rule)}</p>`,
        buttons : [
          { action : "fix", label : fixLabel ?? module.i18n("limits.fix"), icon : "fa-solid fa-wrench", default : true },
          ...(goAhead ? [{ action : "ahead", label : module.i18n("limits.goAhead"), icon : "fa-solid fa-forward" }] : []),
          { action : "cancel", label : module.i18n("limits.cancel"), icon : "fa-solid fa-xmark" },
        ],
        rejectClose : false,
      });
      if(choice === "fix"){
        await fix();
        return "fixed";
      }
      if(choice !== "ahead") return "stopped";
    }
    return this.allow(rule, { who, what }) ? "allowed" : "stopped";
  }

  static register(){
    gm.handle("limitsLog", (data, user) => this.logAsGM(data, user));
    /* Roll Item's rerolls (its cards and dnd5e's test messages) */
    Hooks.on(`${module.id}.preReroll`, (who, what) => this.mayReroll(who, what));
  }

  /* A player may replace more than the rules allow (forms, masteries, a Fighting Style) : only on Off and Warn, never the GM (free anyway) */
  static canGoPast(){
    return !game.user.isGM && ["off", "warn"].includes(this.mode());
  }

  /**
   * May it go ahead ? Says why when it isn't allowed (a notice here, or a note for the GM's answer to a player), and the
   * GM gets a line in the Rule Limits log (Warn : allowed; Block : stopped).
   * @param {string} rule     what the rules say ("Rage : no spells")
   * @param {object} [options]
   * @param {string} [options.who]       the creature
   * @param {string} [options.what]      what it tried ("Cast Fire Bolt")
   * @param {string[]} [options.notes]   collect the notice here instead of showing it (GM queries return notes)
   * @returns {boolean}  true : go ahead (Off, or Warn); false : stop
   */
  static allow(rule, { who = "", what = "", notes } = {}){
    const mode = this.mode();
    if(mode === "off") return true;
    const allowed = mode === "warn";
    const text = allowed ? module.format("limits.warned", { message : rule }) : rule;
    if(notes) notes.push(text);
    else ui.notifications.warn(text);
    this.log({ who, what, rule, status : allowed ? "allowed" : "blocked" });
    return allowed;
  }

  /**
   * A free reroll isn't in the rules : the GM always may; anyone else follows Rule Limits (logged on Warn / Block).
   * @param {string} who    whose roll
   * @param {string} what   which roll ("Athletics", "Longsword attack")
   * @returns {boolean}
   */
  static mayReroll(who, what){
    if(game.user.isGM) return true;
    return this.allow(module.i18n("rerolls.rule"), { who, what : module.format("rerolls.did", { roll : what || "—" }) });
  }

  /**
   * A player went past the rules on purpose (Warn) : a line in the GM's log, not shown to them.
   * @param {object} entry   { who, what, rule }
   */
  static async tellGM(entry){
    if(this.mode() !== "warn") return;
    await this.log({ ...entry, status : "past" });
  }

  /* The GM's log : from anyone's client, written by the GM's */
  static async log(entry){
    try { await gm.run("limitsLog", entry); }
    catch(error){ console.warn("Macro Helper | Rule Limits log", error); }
  }

  /* One whispered table per entry, like the equipment log : Round (Time), Who, What they did, Status, Rule */
  static async logAsGM({ who = "", what = "", rule = "", status = "allowed" } = {}, user){
    const combat = game.combat;
    const when = combat?.started
      ? `${String(combat.round ?? 0).padStart(2, "0")} (${esc(combat.combatant?.name ?? "—")})`
      : esc(module.format("limits.outOfCombat", { time : new Date().toLocaleTimeString([], { hour : "2-digit", minute : "2-digit" }) }));
    const rows = [
      ["limits.logRound", when],
      ["limits.logWho", esc(who || user?.character?.name || user?.name || "—")],
      ["limits.logWhat", esc(what || "—")],
      ["limits.logStatus", `<strong>${esc(module.i18n(`limits.status.${status}`))}</strong>`],
      ["limits.logRule", esc(rule)],
    ];
    await whisperGMTable(rows, { alias : module.i18n("limits.title") });
    return true;
  }
}
