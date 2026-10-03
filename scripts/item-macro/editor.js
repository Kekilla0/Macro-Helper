import { module } from '../module.js';
import { itemMacro, MODES } from './item-macro.js';
import { hookMacros } from '../hook-macros/hook-macros.js';

const { MacroConfig } = foundry.applications.sheets;

/**
 * Foundry's macro editor, backed by an unsaved Macro.
 * Saving writes to the item/activity flag instead of creating a Macro document.
 * GMs also get "Run on Hooks" for items (item-hooks.js) : the macro runs on those hooks while the creature is on the scene.
 */
export class MacroEditor extends MacroConfig{
  /* Form field prefix of the hook fields, kept out of the Macro's own data */
  static HOOKS = "itemHooks";

  /* The hook fields from the last form read, saved with the macro */
  #hookData = null;

  static DEFAULT_OPTIONS = {
    classes : ["macro-helper-editor"],
    actions : { execute : MacroEditor.#onExecute },
  };

  static PARTS = {
    body : MacroConfig.PARTS.body,
    mode : { template : `${module.path}/templates/macro-mode.hbs` },
    footer : MacroConfig.PARTS.footer,
  };

  static open(target){
    const existing = foundry.applications.instances.get(this.idFor(target));
    if(existing) return existing.render({ force : true });

    const data = itemMacro.data(target);
    const macro = new CONFIG.Macro.documentClass({
      name : data?.name || target.name,
      type : data?.type ?? "script",
      command : data?.command ?? "",
      img : data?.img || undefined,
      author : game.user.id,
    });

    return new this({ document : macro, target }).render({ force : true });
  }

  static idFor(target){
    return `${this.name}-${target.uuid.replaceAll(".", "-")}`;
  }

  /* Store item + activity id rather than the activity, activities are rebuilt whenever the item updates */
  _initializeApplicationOptions(options){
    const { target } = options;
    options = super._initializeApplicationOptions(options);
    options.uniqueId = MacroEditor.idFor(target);
    options.item = itemMacro.isActivity(target) ? target.item : target;
    options.activityId = itemMacro.isActivity(target) ? target.id : null;
    delete options.target;
    return options;
  }

  get target(){
    const { item, activityId } = this.options;
    return activityId ? item.system.activities?.get(activityId) : item;
  }

  get title(){
    return `${module.i18n("itemMacro.title")}: ${this.target?.name}`;
  }

  /* Temporary Macro, hide sheet/ownership controls */
  _getHeaderControls(){
    return [];
  }

  async _prepareContext(options){
    const context = await super._prepareContext(options);
    context.modes = MODES;
    context.mode = itemMacro.data(this.target)?.mode ?? "macro";
    return context;
  }

  /* Items only (not activities) and GMs only : only GM-saved macros run from hooks */
  get showHooks(){
    return game.user.isGM && !itemMacro.isActivity(this.target) && game.settings.get(module.id, "itemMacro");
  }

  async _onRender(context, options){
    await super._onRender(context, options);
    if(!this.showHooks || this.element.querySelector(`.${module.id}-hooks`)) return;

    const mode = this.element.querySelector("[name=mode]")?.closest(".form-group");
    if(!mode) return;
    const data = itemMacro.data(this.target) ?? {};
    const html = await hookMacros.renderHookFields(MacroEditor.HOOKS, data, {
      runAs : data.runAs ?? "owner",
      runAsChoices : { owner : "itemMacro.hooks.runAs.owner", gm : "itemMacro.hooks.runAs.gm" },
      runAsHint : "itemMacro.hooks.runAsHint",
      showSelf : true,
      self : data.self ?? true,
      count : [...(data.hooks ?? []), ...(data.customHooks ?? [])].length,
    });
    mode.insertAdjacentHTML("afterend", html);

    const section = mode.nextElementSibling;
    hookMacros.fitWindow(this, section);
    section.addEventListener("toggle", ()=> hookMacros.fitWindow(this, section));
  }

  /* mode and the hook fields are not Macro fields, keep them out of Macro validation */
  _processFormData(event, form, formData){
    const data = super._processFormData(event, form, formData);
    delete data.mode;
    if(MacroEditor.HOOKS in data){
      this.#hookData = data[MacroEditor.HOOKS];
      delete data[MacroEditor.HOOKS];
    }
    return data;
  }

  /* { hooks, customHooks, runAs, self } from the form, or what the item already had */
  hookFields(){
    const current = itemMacro.data(this.target) ?? {};
    const form = this.#hookData;
    if(!form) return { hooks : current.hooks ?? [], customHooks : current.customHooks ?? [], runAs : current.runAs ?? "owner", self : current.self ?? true };
    const list = value => (Array.isArray(value) ? value : String(value ?? "").split(",")).map(h => String(h).trim()).filter(Boolean);
    return { hooks : list(form.hooks), customHooks : list(form.customHooks), runAs : form.runAs || "owner", self : !!form.self };
  }

  async _processSubmitData(event, form, submitData, options){
    if((submitData.type === "script" && !game.user.can("MACRO_SCRIPT")) || !itemMacro.playersMayEdit())
      return ui.notifications.error("itemMacro.error.permission", { localize : true });

    this.document.updateSource(submitData);
    const { name, type, command, img } = this.document._source;
    const mode = form.elements.mode?.value ?? "macro";

    /* author : only macros saved by a GM run from hooks */
    const hooks = itemMacro.isActivity(this.target) ? {} : { ...this.hookFields(), author : game.user.id };
    await itemMacro.set(this.target, { name, type, command, img, mode, ...hooks });
    return {};
  }

  static async #onExecute(){
    const target = this.target;
    await this.submit();
    return itemMacro.execute(target);
  }
}
