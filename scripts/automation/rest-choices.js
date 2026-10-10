import { module } from '../module.js';
import { esc } from '../helpers/utils.js';
import { logger } from '../log.js';
const log = logger.for(import.meta.url);

/**
 * Rest Choices : the things a character may change when it finishes a rest or gains a level (Wild Shape's known forms,
 * Weapon Mastery, a Fighting Style...), in one window that opens for the player afterwards. Each feature registers a
 * choice; only the ones the character has are shown. The character sheet's header has a Rest Choices button too :
 * what's free any time (filling up to the limit) needs no rest. dnd5e's Short / Long Rest window lists the choices that
 * rest would bring, each ticked : after the rest, each ticked one's own window opens in turn (the next when the last is
 * closed), no summary window; an unticked one isn't granted or opened (its values stay). Resting without that window,
 * or gaining a level : the summary window, as before.
 *
 * Gaining a level : once the level-up is done (dnd5e's advancement, Plutonium's importer, the sheet : whatever changed
 * the classes, by this user), when the character's total level went up : the level choices of the classes that gained
 * (a new class too). It waits until the character's items stop changing (LEVEL_SETTLE) and dnd5e's advancement window
 * for it is closed, so it opens after everything the level-up adds.
 *
 * A choice : {
 *   id, label (i18n key), rest : "long" | "short" | "level",
 *   classes         : for "level", the class identifiers whose level-up allows it (["fighter", "paladin", "ranger"]),
 *   applies(actor)  : does the character have it,
 *   grant(actor, { levels }) : the rest / level happened : allow its change (a swap...), may be async; levels : how
 *                     many levels the class gained,
 *   summary(actor)  : one line for the window ("3 / 4 known · 1 swap"),
 *   open(actor)     : change it (its own window), async
 * }
 */
export class restChoices{
  static #choices = new Map();

  static add(choice){
    this.#choices.set(choice.id, choice);
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.restCompleted", (actor, result, config) => this.onRest(actor, result, config));
    /* dnd5e's rest windows : the choices that rest brings, as checkboxes (their values arrive with the rest's config) */
    Hooks.on("renderShortRestDialog", (app, html) => this.restBoxes(app, html, "short"));
    Hooks.on("renderLongRestDialog", (app, html) => this.restBoxes(app, html, "long"));
    /* The GM rested or levelled the character : its player's client opens the window (not waited on) */
    CONFIG.queries[`${module.id}.restChoicesOpen`] = ({ actor : uuid, choices = [], sequence = false, level = false } = {}) => {
      const actor = fromUuidSync(uuid ?? "", { strict : false });
      if(!actor?.isOwner) return false;
      const list = choices.map(id => this.#choices.get(id)).filter(Boolean);
      if(sequence) this.sequence(actor, list);
      else this.open(actor, list.length ? list : undefined, { level });
      return true;
    };
    /* The class's level before the change, to tell a level gained */
    Hooks.on("preUpdateItem", (item, changes, options) => {
      if((item?.type === "class") && foundry.utils.hasProperty(changes ?? {}, "system.levels")) options.macroHelperLevels = Number(item.system.levels) || 0;
    });
    Hooks.on("updateItem", (item, changes, options, userId) => this.onLevel(item, changes, options, userId));
    /* A class added (a new class) or removed; anything else the level-up adds or changes keeps it waiting */
    Hooks.on("createItem", (item, options, userId) => this.onClassAdded(item, userId, 1));
    Hooks.on("deleteItem", (item, options, userId) => this.onClassAdded(item, userId, -1));
    Hooks.on("updateActor", (actor, changes, options, userId) => { if(userId === game.user.id) this.keepWaiting(actor); });
    /* The sheet's header : the window any time (adding up to a limit is always free) */
    Hooks.on("getHeaderControlsDocumentSheetV2", (app, controls) => {
      const actor = app.document;
      if((actor?.documentName !== "Actor") || !actor.isOwner) return;
      controls.push({ icon : "fa-solid fa-bed", label : "restChoices.button", visible : () => this.choicesFor(actor).length > 0,
        onClick : () => this.open(actor) });
    });
  }

  /* The choices this character has, for this kind of rest (or all) */
  static choicesFor(actor, rest = null){
    return [...this.#choices.values()].filter(c => (!rest || (c.rest === rest)) && c.applies(actor));
  }

  /* The choices a rest brings (a long rest counts as a short one too) */
  static forRest(actor, rest){
    return [...this.#choices.values()].filter(c => ((c.rest === rest) || ((rest === "long") && (c.rest === "short"))) && c.applies(actor));
  }

  static async onRest(actor, result, config){
    if(!actor?.isOwner) return;
    const rest = (result?.longRest || (config?.type === "long")) ? "long" : "short";
    let choices = this.forRest(actor, rest);
    /* Chosen in dnd5e's rest window : only the ticked ones, each its own window in turn */
    const picked = config?.[module.id]?.restChoices;
    if(picked?.shown) return this.grantAndOpen(actor, choices.filter(c => picked[c.id] === true), { sequence : true });
    await this.grantAndOpen(actor, choices);
  }

  /* The rest window's checkboxes : one per choice that rest brings, ticked */
  static restBoxes(app, html, rest){
    const actor = app.actor ?? app.options?.document;
    const root = (html instanceof HTMLElement) ? html : (app.element ?? html?.[0]);
    if(!actor || (actor.type === "group") || !actor.isOwner || !root || root.querySelector(`.${module.id}-rest-boxes`)) return;
    const choices = this.forRest(actor, rest);
    if(!choices.length) return;
    const section = root.querySelector("section.flexcol") ?? root.querySelector("form") ?? root;
    const fieldset = document.createElement("fieldset");
    fieldset.className = `${module.id}-rest-boxes`;
    fieldset.innerHTML = `<legend>${esc(module.i18n("restChoices.restLegend"))}</legend>
      <input type="hidden" name="${module.id}.restChoices.shown" value="true">
      ${choices.map(c => `<div class="form-group">
          <label>${esc(module.i18n(c.label))}</label>
          <div class="form-fields"><input type="checkbox" name="${module.id}.restChoices.${esc(c.id)}" checked></div>
          <p class="hint">${esc(c.summary(actor))}</p>
        </div>`).join("")}`;
    section.append(fieldset);
  }

  /* ---------- Gaining a level ---------- */

  /* How long the character's items must stay unchanged before the level-up counts as done (ms) */
  static LEVEL_SETTLE = 1500;
  /* actor uuid -> { actor, before (total level), gained : Map(class identifier -> levels), timer } */
  static #levelling = new Map();

  /* A class's level changed (by this user) */
  static onLevel(item, changes, options = {}, userId){
    if(userId !== game.user.id) return;
    if(item?.parent) this.keepWaiting(item.parent);
    if((item?.type !== "class") || !item.actor?.isOwner) return;
    const levels = foundry.utils.getProperty(changes ?? {}, "system.levels");
    if((levels === undefined) || !Number.isFinite(options.macroHelperLevels)) return;
    this.noteLevels(item.actor, item.identifier ?? item.system?.identifier, Number(levels) - options.macroHelperLevels);
  }

  /* A class added (+1 : its levels) or removed (-1) by this user; any other item keeps the wait going */
  static onClassAdded(item, userId, sign){
    if(userId !== game.user.id || !item?.parent) return;
    this.keepWaiting(item.parent);
    if((item.type !== "class") || !item.actor?.isOwner) return;
    this.noteLevels(item.actor, item.identifier ?? item.system?.identifier, sign * (Number(item.system?.levels) || 0));
  }

  static noteLevels(actor, cls, delta){
    if(!cls || !delta || (actor.documentName !== "Actor")) return;
    let entry = this.#levelling.get(actor.uuid);
    if(!entry){
      /* The total before this level-up : now, less what just changed */
      entry = { actor, before : (Number(actor.system?.details?.level) || 0) - delta, gained : new Map(), timer : null };
      this.#levelling.set(actor.uuid, entry);
    }
    entry.gained.set(cls, (entry.gained.get(cls) ?? 0) + delta);
    this.keepWaiting(actor);
  }

  /* Something changed on a character levelling up : wait a little longer */
  static keepWaiting(actor){
    const entry = this.#levelling.get(actor?.uuid);
    if(!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.levelDone(actor.uuid), this.LEVEL_SETTLE);
  }

  /* dnd5e's advancement window still open for the character */
  static advancing(actor){
    return [...(foundry.applications.instances?.values?.() ?? [])].some(app => app.rendered && (app.constructor?.name === "AdvancementManager") && (app.actor === actor || app.clone?.id === actor.id || app.actor?.id === actor.id));
  }

  static async levelDone(uuid){
    const entry = this.#levelling.get(uuid);
    if(!entry) return;
    if(this.advancing(entry.actor)) return this.keepWaiting(entry.actor);
    this.#levelling.delete(uuid);
    const actor = entry.actor;
    const after = Number(actor.system?.details?.level) || 0;
    /* The total level went up : the choices of the classes that gained */
    if(!(after > entry.before)) return;
    const gained = [...entry.gained].filter(([, n]) => n > 0);
    const levels = new Map();
    const choices = [];
    for(const choice of this.#choices.values()){
      if(choice.rest !== "level") continue;
      const n = gained.filter(([cls]) => (choice.classes ?? []).includes(cls)).reduce((sum, [, n]) => sum + n, 0);
      if((n > 0) && choice.applies(actor)){ choices.push(choice); levels.set(choice.id, n); }
    }
    log.debug("Level gained", actor.name, entry.before, "->", after, gained);
    await this.grantAndOpen(actor, choices, { levels, level : true });
  }

  static async grantAndOpen(actor, choices, { sequence = false, levels = null, level = false } = {}){
    if(!choices.length) return;
    for(const choice of choices){
      try { await choice.grant?.(actor, { levels : levels?.get(choice.id) ?? 1 }); }
      catch(error){ log.error(choice.id, error); }
    }
    /* The player's window : here for a player; from the GM, on an owning player's client when one is online, else here */
    const player = game.user.isGM ? game.users.find(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER")) : null;
    if(!player) return sequence ? this.sequence(actor, choices) : this.open(actor, choices, { level });
    player.query(`${module.id}.restChoicesOpen`, { actor : actor.uuid, choices : choices.map(c => c.id), sequence, level }, { timeout : 10000 })
      .catch(error => log.debug("Rest Choices on the player's client", error));
  }

  /* Each choice's own window, one after the other (the next once the last is closed) */
  static async sequence(actor, choices){
    for(const choice of choices){
      try { await choice.open?.(actor); }
      catch(error){ log.error(choice.id, error); }
    }
  }

  /**
   * The window : one row per choice, each with a Change button. Closing keeps everything.
   * @param {Actor} actor
   * @param {object[]} [choices]
   */
  static async open(actor, choices = this.choicesFor(actor), { level = false } = {}){
    if(!choices.length) return;
    const rows = choices.map(c => `<div class="form-group ${module.id}-rest-choice">
        <label>${esc(module.i18n(c.label))}</label>
        <div class="form-fields"><span class="summary">${esc(c.summary(actor))}</span>
          <button type="button" data-choice="${esc(c.id)}"><i class="fa-solid fa-pen" inert></i> ${esc(module.i18n("restChoices.change"))}</button>
        </div>
      </div>`).join("");
    await foundry.applications.api.DialogV2.wait({
      window : { title : module.format(level ? "restChoices.levelTitle" : "restChoices.title", { name : actor.name }), icon : level ? "fa-solid fa-arrow-up" : "fa-solid fa-bed" },
      content : `<p>${esc(module.i18n(level ? "restChoices.levelPrompt" : "restChoices.prompt"))}</p>${rows}`,
      buttons : [{ action : "done", label : module.i18n("restChoices.done"), icon : "fa-solid fa-check", default : true }],
      render : (event, dialog) => {
        dialog.element.querySelectorAll("button[data-choice]").forEach(button => button.addEventListener("click", async () => {
          const choice = this.#choices.get(button.dataset.choice);
          await choice?.open(actor);
          const summary = button.closest(".form-fields")?.querySelector(".summary");
          if(summary && choice) summary.textContent = choice.summary(actor);
        }));
      },
      rejectClose : false,
    });
  }
}
