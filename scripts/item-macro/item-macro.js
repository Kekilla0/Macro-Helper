import { module } from '../module.js';
import { settings } from '../settings.js';
import { patch } from '../patch.js';
import { logger } from '../log.js';
import { MacroEditor } from './editor.js';
import { itemHooks } from './item-hooks.js';
const log = logger.for(import.meta.url);

/* What happens when an item/activity with a macro is used */
export const MODES = {
  default : "itemMacro.mode.default",
  macro : "itemMacro.mode.macro",
  both : "itemMacro.mode.both",
};

export class itemMacro{
  static get flag(){ return `flags.${module.id}.macro`; }

  /* Raw stored macro data { name, type, command, img, mode } for an item or activity */
  static data(target){
    return foundry.utils.getProperty(target, this.flag) ?? null;
  }

  /* Stored macro data, only if there is something to run */
  static get(target){
    const data = this.data(target);
    return data?.command?.trim() ? data : null;
  }

  static async set(target, data){
    return await target.update({ [this.flag] : data });
  }

  static isActivity(target){
    return target?.documentName === "Activity";
  }

  /* Variables available inside the macro, on top of Foundry's speaker/actor/token/character/scope.
     hook / args are set when it runs from a hook (see item-hooks.js), null / [] when the item is used */
  static scope(target, extra = {}){
    const activity = this.isActivity(target) ? target : null;
    const item = activity ? target.item : target;
    const actor = item?.actor ?? null;
    const token = actor?.token?.object ?? actor?.getActiveTokens()[0] ?? null;
    return { actor, token, item, activity, hook : null, args : [], ...extra };
  }

  static async execute(target, scope = this.scope(target)){
    const data = this.get(target);
    if(!data) return;

    const macro = new CONFIG.Macro.documentClass({
      name : data.name || target.name,
      type : data.type ?? "script",
      command : data.command,
      img : data.img || undefined,
      author : game.user.id,
    });

    log.debug("Executing", target.name, scope);
    try {
      return await macro.execute(scope);
    } catch(err) {
      log.error(`Macro failed on ${target.name}`, err);
      ui.notifications.error("itemMacro.error.execute", { localize : true });
    }
  }

  /* Shared use() wrapper : run the macro and/or the default based on the stored mode */
  static async use(target, wrapped, args, extra){
    const data = this.get(target);
    if(!data || data.mode === "default") return wrapped(...args);

    const result = await this.execute(target, this.scope(target, extra));
    if(data.mode === "macro" || result === false) return;

    return wrapped(...args);
  }

  static register(){
    if(!settings.value("itemMacro")) return;
    log.info("Registering item macros.");

    this.registerSheets();
    this.wrapItems();
    this.wrapActivities();
    itemHooks.register();
  }

  static canEdit(app){
    return app.isEditable && game.user.can("MACRO_SCRIPT");
  }

  /* Entry in the sheet's ⋯ header menu */
  static control(app){
    return {
      icon : "fa-solid fa-code",
      label : "itemMacro.control",
      visible : ()=> this.canEdit(app),
      onClick : ()=> MacroEditor.open(app.document),
    };
  }

  /**
   * Button in the sheet's title bar, next to the close button, styled like Foundry's own frame buttons.
   * The frame is built once per window, so it is added on the first render and its "has a macro" state refreshed after.
   */
  static titleBarButton(app){
    const header = app.window?.header;
    const close = app.window?.close;
    if(!header || !close) return;

    let button = header.querySelector(`.${module.id}-item-macro`);
    if(!this.canEdit(app)) return button?.remove();

    if(!button){
      button = document.createElement("button");
      button.type = "button";
      button.className = `header-control icon fa-solid fa-code ${module.id}-item-macro`;
      button.dataset.tooltip = "";
      button.ariaLabel = module.i18n("itemMacro.control");
      /* Own listener, not data-action : the sheet's action handler doesn't know this button */
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        MacroEditor.open(app.document);
      });
      close.before(button);
    }
    button.classList.toggle("has-macro", !!this.get(app.document));
  }

  static registerSheets(){
    const titleBar = settings.value("itemMacroTitleBar");

    if(titleBar){
      Hooks.on("renderDocumentSheetV2", app => {
        if(app.document?.documentName === "Item") this.titleBarButton(app);
      });
      Hooks.on("renderActivitySheet", app => this.titleBarButton(app));
      return;
    }

    Hooks.on("getHeaderControlsDocumentSheetV2", (app, controls)=> {
      if(app.document?.documentName === "Item") controls.push(this.control(app));
    });

    /* dnd5e activity sheets */
    Hooks.on("getHeaderControlsActivitySheet", (app, controls)=> controls.push(this.control(app)));
  }

  static wrapItems(){
    if(typeof CONFIG.Item.documentClass.prototype.use !== "function")
      return log.info("Item class has no use(), item macros will not run on use.");

    patch.wrap("CONFIG.Item.documentClass.prototype.use", async function(wrapped, ...args){
      const [usage, dialog, message] = args;
      return itemMacro.use(this, wrapped, args, { usage, dialog, message, event : usage?.event });
    });
  }

  static wrapActivities(){
    const types = CONFIG.DND5E?.activityTypes;
    if(!types) return;

    /* Only wrap each use() once, in case a registered type inherits from another */
    const owners = new Set();
    for(const [type, { documentClass }] of Object.entries(types)){
      let proto = documentClass?.prototype;
      while(proto && !Object.hasOwn(proto, "use")) proto = Object.getPrototypeOf(proto);
      if(!proto || owners.has(proto)) continue;
      owners.add(proto);

      patch.wrap(`CONFIG.DND5E.activityTypes.${type}.documentClass.prototype.use`, async function(wrapped, ...args){
        const [usage, dialog, message] = args;
        return itemMacro.use(this, wrapped, args, { usage, dialog, message, event : usage?.event });
      });
    }
  }
}
