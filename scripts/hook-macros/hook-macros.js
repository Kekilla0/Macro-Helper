import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { MacroEditor } from '../item-macro/editor.js';
const log = logger.for(import.meta.url);

/**
 * Hook Macros (the spirit of World Scripter) : a world macro can be set to run when a hook fires,
 * so a small bit of automation doesn't need a whole module. Set from the macro's own config window.
 *
 * Stored on the macro : flags[module.id] = { hooks : [...], customHooks : [...], runAs : "gm" | "all" }
 * The macro gets `hook` (the hook's name) and `args` (the hook's arguments) as variables.
 * Macros run straight away, inside the hook : until its first `await` a macro can still change what the hook
 * passed (dnd5e.preApplyDamage's updates...). Returning false doesn't cancel the hook.
 */

/* The hooks offered in the dropdown, by group. Any other hook can be typed in as a custom hook. */
export const CATALOG = {
  startup : ["ready", "canvasReady"],
  combat : ["combatStart", "combatTurnChange", "deleteCombat"],
  tokens : ["createToken", "moveToken", "updateToken", "deleteToken", "targetToken"],
  actors : ["updateActor", "createItem", "deleteItem", "createActiveEffect", "deleteActiveEffect"],
  chat : ["createChatMessage"],
  game : ["pauseGame", "updateWorldTime"],
  macroHelper : ["macro-helper.targets", "macro-helper.preAttack", "macro-helper.attack", "macro-helper.preDamage",
    "macro-helper.damage", "macro-helper.cardButtons", "macro-helper.cardButton"],
  dnd5e : ["dnd5e.preRollAttackV2", "dnd5e.preRollSavingThrowV2", "dnd5e.rollAttack", "dnd5e.rollDamage", "dnd5e.preApplyDamage", "dnd5e.applyDamage", "dnd5e.rollInitiative",
    "dnd5e.restCompleted", "dnd5e.beginConcentrating", "dnd5e.endConcentration"],
};

/* Too early : world macros don't exist yet when these fire */
const UNSUPPORTED = new Set(["init", "i18nInit", "setup"]);

export class hookMacros{
  /* hook name -> Hooks.on id */
  static #registered = new Map();

  static get flag(){ return `flags.${module.id}`; }

  static hooksOf(macro){
    const data = foundry.utils.getProperty(macro, this.flag) ?? {};
    const hooks = [...(data.hooks ?? []), ...(data.customHooks ?? [])].map(h => String(h).trim()).filter(Boolean);
    return [...new Set(hooks)].filter(h => !UNSUPPORTED.has(h));
  }

  static runAsOf(macro){
    return foundry.utils.getProperty(macro, `${this.flag}.runAs`) ?? "gm";
  }

  /* Called at ready, world macros exist from here on */
  static register(){
    if(!settings.value("hookMacros")) return;
    log.info("Registering hook macros.");

    this.sync();
    for(const hook of ["createMacro", "updateMacro", "deleteMacro"]) Hooks.on(hook, ()=> this.sync());
    Hooks.on("renderMacroConfig", (app, element)=> this.renderFields(app, element));

    /* ready (and the first canvasReady) fired before we got here */
    this.run("ready", []);
    if(canvas.ready) this.run("canvasReady", [canvas]);
  }

  /* Keep one listener per hook that any macro uses */
  static sync(){
    const wanted = new Set(game.macros.contents.flatMap(m => this.hooksOf(m)));

    for(const [hook, id] of this.#registered){
      if(wanted.has(hook)) continue;
      Hooks.off(hook, id);
      this.#registered.delete(hook);
    }
    for(const hook of wanted){
      /* ready only ever fires once, before this : it is run at startup instead */
      if(this.#registered.has(hook) || (hook === "ready")) continue;
      this.#registered.set(hook, Hooks.on(hook, (...args)=> this.run(hook, args)));
    }
    log.debug("Hooks in use", [...wanted]);
  }

  /**
   * Only macros written by a GM run on their own, so a player can't have their script run on the GM's client.
   * "gm" runs once, on the active GM. "all" runs on every client the hook fires on, for users who can run the macro.
   */
  static shouldRun(macro){
    if(!macro.author?.isGM) return false;
    if(this.runAsOf(macro) === "gm") return !!game.users.activeGM?.isSelf;
    return macro.canExecute;
  }

  static run(hook, args){
    for(const macro of game.macros){
      if(!this.hooksOf(macro).includes(hook) || !this.shouldRun(macro)) continue;
      log.debug("Running", macro.name, "for", hook);
      const failed = err => log.error(`Hook macro "${macro.name}" failed on ${hook}`, err);
      try { Promise.resolve(macro.execute({ hook, args })).catch(failed); }
      catch(err){ failed(err); }
    }
  }

  /* ---------- Macro config : hook fields under the Type line ---------- */

  static async renderFields(app, element){
    if(!game.user.isGM || (app instanceof MacroEditor) || (app.document?.documentName !== "Macro")) return;
    if(element.querySelector(`.${module.id}-hooks`)) return;

    const typeGroup = element.querySelector("[name=type]")?.closest(".form-group");
    if(!typeGroup) return;

    const macro = app.document;
    const data = foundry.utils.getProperty(macro, this.flag) ?? {};
    const html = await this.renderHookFields(this.flag, data, {
      runAs : this.runAsOf(macro),
      runAsChoices : { gm : "hookMacros.runAs.gm", all : "hookMacros.runAs.all" },
      count : this.hooksOf(macro).length,
    });
    typeGroup.insertAdjacentHTML("afterend", html);

    const section = typeGroup.nextElementSibling;
    this.fitWindow(app, section);
    section.addEventListener("toggle", ()=> this.fitWindow(app, section));
  }

  /**
   * The collapsible "Run on Hooks" fields, also used by the item macro editor (item hooks).
   * @param {string} flag     form name prefix the fields save under
   * @param {object} data     { hooks, customHooks }
   * @param {object} extra    runAs, runAsChoices, count, and for items self / showSelf
   */
  static async renderHookFields(flag, data, extra){
    const chosen = new Set(data.hooks ?? []);
    const known = new Set(Object.values(CATALOG).flat());
    return foundry.applications.handlebars.renderTemplate(`${module.path}/templates/hook-macro-fields.hbs`, {
      flag,
      groups : Object.entries(CATALOG)
        .filter(([group]) => (group !== "dnd5e") || (game.system.id === "dnd5e"))
        .map(([group, hooks]) => ({
          label : module.i18n(`hookMacros.groups.${group}`),
          options : hooks.map(hook => ({ value : hook, label : `${module.i18n(`hookMacros.hooks.${hook}`)} (${hook})`, selected : chosen.has(hook) })),
        })),
      /* Hooks set some other way that aren't in the catalog show up as custom */
      custom : [...(data.customHooks ?? []), ...[...chosen].filter(h => !known.has(h))].join(","),
      ...extra,
    });
  }

  /* Height this module has added to each macro window, so re-renders (which rebuild the section) only apply the difference */
  static #added = new WeakMap();

  /**
   * Grow / shrink the macro window by the section's height (plus the form's row gap), so the code editor keeps
   * its size and the Save / Execute buttons stay visible, collapsed or open.
   */
  static fitWindow(app, section){
    const gap = parseFloat(getComputedStyle(section.parentElement).rowGap) || 0;
    const height = Math.ceil(section.getBoundingClientRect().height + gap);
    const previous = this.#added.get(app) ?? 0;
    if(height === previous) return;

    this.#added.set(app, height);
    const current = Number(app.position.height) || app.element.offsetHeight;
    app.setPosition({ height : current + (height - previous) });
  }
}
