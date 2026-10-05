import { module } from '../module.js';
import { esc } from '../helpers/utils.js';
import { logger } from '../log.js';
const log = logger.for(import.meta.url);

/**
 * Rest Choices : the things a character may change when it finishes a rest or gains a level (Wild Shape's known forms,
 * Weapon Mastery, a Fighting Style...), in one window that opens for the player afterwards. Each feature registers a
 * choice; only the ones the character has are shown. The character sheet's header has a Rest Choices button too :
 * what's free any time (filling up to the limit) needs no rest.
 *
 * A choice : {
 *   id, label (i18n key), rest : "long" | "short" | "level",
 *   classes         : for "level", the class identifiers whose level-up allows it (["fighter", "paladin", "ranger"]),
 *   applies(actor)  : does the character have it,
 *   grant(actor)    : the rest / level happened : allow its change (a swap...), may be async,
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
    /* The GM rested or levelled the character : its player's client opens the window (not waited on) */
    CONFIG.queries[`${module.id}.restChoicesOpen`] = ({ actor : uuid, choices = [] } = {}) => {
      const actor = fromUuidSync(uuid ?? "", { strict : false });
      if(!actor?.isOwner) return false;
      const list = choices.map(id => this.#choices.get(id)).filter(Boolean);
      this.open(actor, list.length ? list : undefined);
      return true;
    };
    /* The class's level before the change, to tell a level gained */
    Hooks.on("preUpdateItem", (item, changes, options) => {
      if((item?.type === "class") && foundry.utils.hasProperty(changes ?? {}, "system.levels")) options.macroHelperLevels = Number(item.system.levels) || 0;
    });
    Hooks.on("updateItem", (item, changes, options, userId) => this.onLevel(item, changes, options, userId));
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

  static async onRest(actor, result, config){
    if(!actor?.isOwner) return;
    const rest = (result?.longRest || (config?.type === "long")) ? "long" : "short";
    /* A long rest counts as a short one too */
    const choices = [...this.#choices.values()].filter(c => ((c.rest === rest) || ((rest === "long") && (c.rest === "short"))) && c.applies(actor));
    await this.grantAndOpen(actor, choices);
  }

  /* A class's level going up (by the user who changed it) : its level choices */
  static async onLevel(item, changes, options = {}, userId){
    if((item?.type !== "class") || (userId !== game.user.id) || !item.actor?.isOwner) return;
    const levels = foundry.utils.getProperty(changes ?? {}, "system.levels");
    if((levels === undefined) || !Number.isFinite(options.macroHelperLevels)) return;
    if(!(Number(levels) > options.macroHelperLevels)) return;
    const cls = item.identifier ?? item.system?.identifier;
    const choices = [...this.#choices.values()].filter(c => (c.rest === "level") && (c.classes ?? []).includes(cls) && c.applies(item.actor));
    await this.grantAndOpen(item.actor, choices);
  }

  static async grantAndOpen(actor, choices){
    if(!choices.length) return;
    for(const choice of choices){
      try { await choice.grant?.(actor); }
      catch(error){ log.error(choice.id, error); }
    }
    /* The player's window : here for a player; from the GM, on an owning player's client when one is online, else here */
    const player = game.user.isGM ? game.users.find(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER")) : null;
    if(!player) return this.open(actor, choices);
    player.query(`${module.id}.restChoicesOpen`, { actor : actor.uuid, choices : choices.map(c => c.id) }, { timeout : 10000 })
      .catch(error => log.debug("Rest Choices on the player's client", error));
  }

  /**
   * The window : one row per choice, each with a Change button. Closing keeps everything.
   * @param {Actor} actor
   * @param {object[]} [choices]
   */
  static async open(actor, choices = this.choicesFor(actor)){
    if(!choices.length) return;
    const rows = choices.map(c => `<div class="form-group ${module.id}-rest-choice">
        <label>${esc(module.i18n(c.label))}</label>
        <div class="form-fields"><span class="summary">${esc(c.summary(actor))}</span>
          <button type="button" data-choice="${esc(c.id)}"><i class="fa-solid fa-pen" inert></i> ${esc(module.i18n("restChoices.change"))}</button>
        </div>
      </div>`).join("");
    await foundry.applications.api.DialogV2.wait({
      window : { title : module.format("restChoices.title", { name : actor.name }), icon : "fa-solid fa-bed" },
      content : `<p>${esc(module.i18n("restChoices.prompt"))}</p>${rows}`,
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
