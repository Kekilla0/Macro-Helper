import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { esc } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Combat log (Action Tracker on) : the whole fight in one list, kept on the Combat (flags.macro-helper.log, written by
 * the GM's client) : every creature's turn log (its uses, attacks, movement, readied actions...), effects that end and
 * death saves that change. The book button in the combat tracker's top bar opens it : by round, [token + name : entry],
 * live. Export : a text file. Players see the lines about creatures they own or can see; the GM all of them.
 * Rolls : an attack once its card is revealed (its total, hit or miss on each target), saves / checks / death saves
 * (total, against the DC), damage and healing as applied. An NPC's numbers show as "?" to players with DM Screen on.
 * Combat Log : Journal (setting) : when the combat is deleted, its log is kept as a journal entry.
 */
export class combatLog{
  static MAX = 600;
  static #app = null;

  static enabled(){
    return (game.system.id === "dnd5e") && !!settings.value("actionTracker");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    gm.handle("combatLogAdd", (data, user) => this.addAsGM(data, user));
    Hooks.on("renderCombatTracker", (app, html) => this.drawButton(html));
    Hooks.on("updateCombat", (combat, changes) => {
      if(foundry.utils.hasProperty(changes ?? {}, `flags.${module.id}.log`) && this.#app?.rendered) this.#app.render();
    });
    /* Rolls */
    Hooks.on("updateChatMessage", (message, changes, options, userId) => this.onAttackCard(message, changes));
    Hooks.on("createChatMessage", (message, options, userId) => this.onRoll(message, userId));
    Hooks.on("dnd5e.applyDamage", (actor, amount, options) => this.onDamage(actor, amount, options));
    /* E2 : the log kept as a journal entry when the combat goes */
    Hooks.on("deleteCombat", combat => this.toJournal(combat));
  }

  /* The started combat a creature is in, and its token there */
  static whereIs(actor){
    const combats = game.combats?.filter?.(c => c.started) ?? [];
    for(const combat of [game.combat, ...combats].filter(Boolean)){
      const combatant = combat.combatants.find(c => c.actor?.uuid === actor?.uuid) ?? combat.combatants.find(c => (c.actorId === actor?.id) && c.token?.actorLink);
      if(combatant) return { combat, token : combatant.token };
    }
    return null;
  }

  /**
   * A line in the fight's log.
   * @param {Actor} actor
   * @param {string} text
   * @param {object} [options]
   * @param {boolean} [options.gmOnly]   only the GM sees it
   */
  static async add(actor, text, { gmOnly = false, numbers = false } = {}){
    if(!this.enabled() || !actor || !text) return;
    const where = this.whereIs(actor);
    if(!where?.combat) return;
    /* An NPC's numbers behind the DM Screen : players see "?" */
    const masked = (numbers && !actor.hasPlayerOwner && settings.value("rollItemDmScreen")) ? String(text).replace(/\d+/g, "?") : null;
    await gm.run("combatLogAdd", { combat : where.combat.id, token : where.token?.uuid ?? null, actor : actor.uuid,
      name : where.token?.name ?? actor.name, img : where.token?.texture?.src ?? actor.img, text, masked, gmOnly }).catch(error => log.debug(error));
  }

  static async addAsGM({ combat : id, token, actor, name, img, text, masked = null, gmOnly = false } = {}, user){
    const combat = game.combats.get(id);
    const owner = actor ? fromUuidSync(actor, { strict : false }) : null;
    if(!combat || !text || !(user.isGM || owner?.testUserPermission(user, "OWNER") || owner?.testUserPermission(user, "OBSERVER"))) return false;
    const entries = [...(combat.getFlag(module.id, "log") ?? []), { round : combat.round, turn : combat.turn, token, actor, name, img, text : String(text), masked, gmOnly, at : Date.now() }];
    await combat.setFlag(module.id, "log", entries.slice(-this.MAX));
    return true;
  }

  /* What this user sees : the GM all; a player its own creatures' lines and those of creatures it can see */
  static visible(entry){
    if(game.user.isGM) return true;
    if(entry.gmOnly) return false;
    const actor = entry.actor ? fromUuidSync(entry.actor, { strict : false }) : null;
    if(actor?.isOwner) return true;
    const token = entry.token ? fromUuidSync(entry.token, { strict : false }) : null;
    return !!token && !token.hidden && ((token.parent !== canvas.scene) || !!token.object?.visible);
  }

  static entriesOf(combat){
    return (combat?.getFlag(module.id, "log") ?? []).filter(e => this.visible(e))
      .map(e => (!game.user.isGM && e.masked) ? { ...e, text : e.masked } : e);
  }

  /* ---------- Rolls ---------- */

  /* An attack card, once revealed : its total, hit or miss on each target (the active GM, once per card) */
  static async onAttackCard(message, changes){
    if(!this.enabled() || !game.users.activeGM?.isSelf || (message.type !== "macro-helper.rollItem")) return;
    if(message.getFlag(module.id, "reveal") !== 2 || message.getFlag(module.id, "logged")) return;
    const attack = message.system?.attackRoll;
    const actor = message.getAssociatedActor?.();
    if(!attack || !actor) return;
    await message.setFlag(module.id, "logged", true);
    const item = message.getAssociatedItem?.()?.name ?? "";
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const hits = new Set((message.system.hitTargets?.(null) ?? []).map(t => t?.document?.uuid ?? t?.uuid ?? t));
    const targets = (message.system.targets ?? []).map(d => {
      const name = TargetsField.resolve(d)?.token?.name ?? d.name ?? "?";
      return module.format(hits.has(d.token) ? "combatLog.hit" : "combatLog.miss", { name });
    });
    const crit = attack.isCritical ? ` ${module.i18n("combatLog.crit")}` : attack.isFumble ? ` ${module.i18n("combatLog.fumble")}` : "";
    await this.add(actor, module.format("combatLog.attack", { item, total : attack.total, targets : targets.join(", ") || "—" }) + crit, { numbers : true });
  }

  /* A save, check or death save (its roller's client) */
  static async onRoll(message, userId){
    if(!this.enabled() || (userId !== game.user.id)) return;
    const roll = message.rolls?.[0];
    const type = message.getFlag?.("dnd5e", "roll")?.type ?? message.system?.type ?? null;
    if(!(roll instanceof CONFIG.Dice.D20Roll) || !["save", "check", "skill", "tool", "death", "ability"].includes(type)) return;
    if(String(message.type).startsWith(module.id)) return;
    const actor = message.getAssociatedActor?.() ?? ChatMessage.implementation.getSpeakerActor(message.speaker);
    if(!actor) return;
    const label = (message.flavor || "").replace(/<[^>]+>/g, "").trim() || module.i18n("combatLog.roll");
    const dc = Number(roll.options?.target);
    const result = Number.isFinite(dc) ? ` ${module.format((roll.total >= dc) ? "combatLog.success" : "combatLog.failure", { dc })}` : "";
    await this.add(actor, module.format("combatLog.rolled", { label, total : roll.total }) + result, { numbers : true });
  }

  /* Damage or healing applied (the client that applied it) */
  static async onDamage(actor, amount, options = {}){
    if(!this.enabled() || !amount || !actor) return;
    const from = options.origin?.getAssociatedItem?.()?.name ?? "";
    const key = (amount > 0) ? "combatLog.damage" : "combatLog.healing";
    await this.add(actor, module.format(key, { n : Math.abs(amount) }) + (from ? ` (${from})` : ""), { numbers : true });
  }

  /* ---------- E2 : a journal entry when the combat is deleted ---------- */

  static async toJournal(combat){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !settings.value("combatLogJournal")) return;
    const entries = combat?.getFlag?.(module.id, "log") ?? [];
    if(!entries.length) return;
    let round = null;
    const html = entries.map(e => {
      const head = (e.round !== round) ? `<h3>${esc(module.format("combatLog.round", { n : e.round }))}</h3>` : "";
      round = e.round;
      return `${head}<p><img src="${esc(e.img ?? "")}" width="24" height="24" style="vertical-align:middle;border:none"> <strong>${esc(e.name)}</strong> : ${esc(e.text)}</p>`;
    }).join("\n");
    const name = module.format("combatLog.journalName", { scene : combat.scene?.name ?? "—", date : new Date().toLocaleString() });
    await JournalEntry.implementation.create({ name, pages : [{ name, type : "text", text : { content : html } }] }).catch(error => log.error(error));
  }

  /* ---------- The window ---------- */

  static drawButton(html){
    if(!this.enabled()) return;
    const root = (html instanceof HTMLElement) ? html : html?.[0];
    if(!root || root.querySelector(`.${module.id}-log-button`)) return;
    const bar = root.querySelector(".encounter-controls, .combat-tracker-header, header");
    if(!bar) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${module.id}-log-button inline-control icon fa-solid fa-book`;
    button.dataset.tooltip = module.i18n("combatLog.open");
    button.ariaLabel = module.i18n("combatLog.open");
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.open(); });
    bar.prepend(button);
  }

  static open(){
    const combat = ui.combat?.viewed ?? game.combat;
    if(!combat) return ui.notifications.info(module.i18n("combatLog.none"));
    if(!this.#app){
      const self = this;
      class CombatLogApp extends foundry.applications.api.ApplicationV2{
        static DEFAULT_OPTIONS = { id : `${module.id}-combat-log`, classes : [`${module.id}-combat-log`],
          window : { title : "combatLog.title", icon : "fa-solid fa-book", resizable : true }, position : { width : 480, height : 600 } };
        async _renderHTML(){ return self.html(ui.combat?.viewed ?? game.combat); }
        _replaceHTML(result, content){
          content.innerHTML = result;
          content.querySelector("[data-action=export]")?.addEventListener("click", () => self.export(ui.combat?.viewed ?? game.combat));
          const list = content.querySelector(".entries");
          if(list) list.scrollTop = list.scrollHeight;
        }
      }
      this.#app = new CombatLogApp();
    }
    this.#app.render({ force : true });
  }

  static html(combat){
    const entries = this.entriesOf(combat);
    let round = null;
    const rows = entries.map(e => {
      const head = (e.round !== round) ? `<li class="round">${esc(module.format("combatLog.round", { n : e.round }))}</li>` : "";
      round = e.round;
      return `${head}<li class="entry"><img src="${esc(e.img ?? "icons/svg/mystery-man.svg")}" alt=""><span class="name">${esc(e.name)}</span><span class="text">${esc(e.text)}</span></li>`;
    }).join("");
    return `<div class="toolbar"><button type="button" data-action="export"><i class="fa-solid fa-file-export" inert></i> ${esc(module.i18n("combatLog.export"))}</button></div>
      <ol class="entries unlist">${rows || `<li class="empty">${esc(module.i18n("combatLog.empty"))}</li>`}</ol>`;
  }

  /* E1 : the fight as a text file, by round */
  static export(combat){
    const entries = this.entriesOf(combat);
    if(!entries.length) return ui.notifications.info(module.i18n("combatLog.empty"));
    const lines = [module.format("combatLog.fileTitle", { scene : combat.scene?.name ?? "—", date : new Date().toLocaleString() }), ""];
    let round = null;
    for(const e of entries){
      if(e.round !== round){ lines.push("", module.format("combatLog.round", { n : e.round })); round = e.round; }
      lines.push(`  ${e.name} : ${e.text}`);
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    foundry.utils.saveDataToFile(lines.join("\n"), "text/plain", `combat-log-${stamp}.txt`);
  }
}
