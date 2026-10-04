import { module } from '../module.js';
import { settings } from '../settings.js';
import { gm } from '../gm.js';

/**
 * Rule Limits (Roll Item → Rules) : what happens when something the rules don't allow is tried. One setting for all of
 * them (the key is still "weaponRules", the weapon handling checks were the first) :
 *   off    : nothing is checked
 *   warn   : a notice, it goes ahead
 *   block  : a notice, it's stopped
 *   change : weapon handling fixes what it can (equips, changes grip); anything else is stopped like block
 *
 * Covered : weapon handling (weapons.js), Rage (no spells, not in heavy armor), Reckless Attack off your turn,
 * Savage Attacker and Cleave once a turn, Cleave melee only, Grapple / Shove / Push size, a spell from a Wild Shape
 * form, Interception and Protection's requirements.
 */
export class limits{
  static mode(){
    return settings.value("weaponRules") ?? "warn";
  }

  static register(){
    gm.handle("limitsLog", (data, user) => this.logAsGM(data, user));
  }

  /* A player may replace more than the rules allow (forms, masteries, a Fighting Style) : only on Off and Warn, never the GM (free anyway) */
  static canGoPast(){
    return !game.user.isGM && ["off", "warn"].includes(this.mode());
  }

  /**
   * May it go ahead ? Says why when it isn't allowed (a notice here, or a note for the GM's answer to a player), and the
   * GM gets a line in the Rule Limits log (Warn : allowed; Block / Change : stopped).
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
    const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
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
    const table = rows.map(([label, value]) => `<tr><th>${module.i18n(label)}</th><td>${value}</td></tr>`).join("");
    await ChatMessage.implementation.create({
      content : `<table class="${module.id}-equip-log">${table}</table>`,
      whisper : game.users.filter(u => u.isGM).map(u => u.id),
      speaker : { alias : module.i18n("limits.title") },
    });
    return true;
  }
}
