import { module } from '../module.js';
import { logger } from '../log.js';
const log = logger.for(import.meta.url);

/**
 * Rest Choices : the things a character may change when it finishes a rest (Wild Shape's known forms, later Weapon
 * Mastery, prepared spells...), in one window that opens for the player after the rest. Each feature registers a
 * choice; only the ones the character has are shown.
 *
 * A choice : {
 *   id, label (i18n key), rest : "long" | "short",
 *   applies(actor)  : does the character have it,
 *   grant(actor)    : the rest happened : allow its change (a swap...), may be async,
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
  }

  /* The choices this character has, for this kind of rest (or all) */
  static choicesFor(actor, rest = null){
    return [...this.#choices.values()].filter(c => (!rest || (c.rest === rest)) && c.applies(actor));
  }

  static async onRest(actor, result, config){
    if(!actor?.isOwner) return;
    const rest = (result?.longRest || (config?.type === "long")) ? "long" : "short";
    /* A long rest counts as a short one too */
    const choices = [...this.#choices.values()].filter(c => ((c.rest === rest) || (rest === "long")) && c.applies(actor));
    if(!choices.length) return;
    for(const choice of choices){
      try { await choice.grant?.(actor); }
      catch(error){ log.error(choice.id, error); }
    }
    /* The player's window : on the client of a player who owns it, else here */
    if(!game.user.isGM || !game.users.some(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"))) this.open(actor, choices);
  }

  /**
   * The window : one row per choice, each with a Change button. Closing keeps everything.
   * @param {Actor} actor
   * @param {object[]} [choices]
   */
  static async open(actor, choices = this.choicesFor(actor)){
    if(!choices.length) return;
    const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
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
