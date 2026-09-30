import { module } from './module.js';
import { settings, GROUPS } from './settings.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * One feature's settings, opened from its button in Configure Settings → Macro Helper.
 * World settings are read-only for players, client settings are theirs to change.
 * Usage : SettingsMenu.for("rollItem") gives the class registerMenu needs for that group.
 */
export class SettingsMenu extends HandlebarsApplicationMixin(ApplicationV2){
  static GROUP = null;

  static for(group){
    return class extends SettingsMenu{
      static GROUP = group;
      static DEFAULT_OPTIONS = {
        id : `${module.id}-${group}-settings`,
        window : { title : `settings.${group}.menu.title`, icon : GROUPS[group].icon },
      };
    };
  }

  static DEFAULT_OPTIONS = {
    tag : "form",
    classes : [`${module.id}-settings`],
    window : { contentClasses : ["standard-form"] },
    position : { width : 520 },
    form : { handler : SettingsMenu.#onSubmit, closeOnSubmit : true },
  };

  static PARTS = {
    body : { template : `${module.path}/templates/settings-menu.hbs`, scrollable : [""] },
    footer : { template : "templates/generic/form-footer.hbs" },
  };

  get keys(){
    return Object.keys(GROUPS[this.constructor.GROUP]?.settings ?? {});
  }

  static config(key){
    return game.settings.settings.get(`${module.id}.${key}`);
  }

  async _prepareContext(options){
    const context = await super._prepareContext(options);
    context.settings = this.keys.map(key => {
      const config = SettingsMenu.config(key);
      const isBoolean = (config.type === Boolean) || (config.type instanceof foundry.data.fields.BooleanField);
      return {
        key,
        id : `${this.id}-${key}`,
        name : config.name,
        hint : config.hint,
        value : settings.value(key),
        isBoolean,
        world : config.scope === "world",
        disabled : (config.scope === "world") && !game.user.isGM,
      };
    });
    context.buttons = [{ type : "submit", icon : "fa-solid fa-floppy-disk", label : "SETTINGS.Save" }];
    return context;
  }

  /** @this {SettingsMenu} */
  static async #onSubmit(event, form, formData){
    const data = formData.object;
    let reload = false, world = false;

    for(const key of this.keys){
      const config = SettingsMenu.config(key);
      if((config.scope === "world") && !game.user.isGM) continue;
      if(!(key in data) || (data[key] === settings.value(key))) continue;

      await settings.change(key, data[key]);
      if(config.requiresReload){
        reload = true;
        world ||= config.scope === "world";
      }
    }

    if(reload) await foundry.applications.settings.SettingsConfig.reloadConfirm({ world });
  }
}
