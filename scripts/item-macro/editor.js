import { module } from '../module.js';
import { itemMacro, MODES } from './item-macro.js';

const { MacroConfig } = foundry.applications.sheets;

/**
 * Foundry's macro editor, backed by an unsaved Macro.
 * Saving writes to the item/activity flag instead of creating a Macro document.
 */
export class MacroEditor extends MacroConfig{
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

  /* mode is not a Macro field, keep it out of Macro validation */
  _processFormData(event, form, formData){
    const data = super._processFormData(event, form, formData);
    delete data.mode;
    return data;
  }

  async _processSubmitData(event, form, submitData, options){
    if(submitData.type === "script" && !game.user.can("MACRO_SCRIPT"))
      return ui.notifications.error("itemMacro.error.permission", { localize : true });

    this.document.updateSource(submitData);
    const { name, type, command, img } = this.document._source;
    const mode = form.elements.mode?.value ?? "macro";

    await itemMacro.set(this.target, { name, type, command, img, mode });
    return {};
  }

  static async #onExecute(){
    const target = this.target;
    await this.submit();
    return itemMacro.execute(target);
  }
}
