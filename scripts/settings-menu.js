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

  /* GMs see every setting of the group, players only their own client settings */
  get keys(){
    const all = Object.entries(GROUPS[this.constructor.GROUP]?.settings ?? {});
    return all.filter(([, data]) => game.user.isGM || ((data.scope === "client") && (!data.players || settings.value(data.players))))
      .map(([key]) => key);
  }

  static config(key){
    return game.settings.settings.get(`${module.id}.${key}`);
  }

  async _prepareContext(options){
    const context = await super._prepareContext(options);
    const all = this.keys.map(key => {
      const config = SettingsMenu.config(key);
      const isBoolean = (config.type === Boolean) || (config.type instanceof foundry.data.fields.BooleanField);
      return {
        key,
        id : `${this.id}-${key}`,
        name : config.name,
        /* Settings with no hint text show no hint line */
        hint : (config.hint && game.i18n.has(config.hint)) ? config.hint : "",
        value : settings.stored(key),
        isBoolean,
        choices : config.choices ?? null,
        world : config.scope === "world",
        disabled : (config.scope === "world") && !game.user.isGM,
        top : !!GROUPS[this.constructor.GROUP].settings[key]?.top,
      };
    });
    /* A page's on/off (Enable Roll Item) goes above its buttons, the rest below */
    context.top = all.filter(s => s.top);
    context.settings = all.filter(s => !s.top);
    /* Buttons opening nested pages (Helpers → Methods), for those who can change them */
    context.submenus = (GROUPS[this.constructor.GROUP]?.submenus ?? [])
      .filter(sub => game.user.isGM || Object.values(GROUPS[sub]?.settings ?? {}).some(s => s.scope === "client"))
      .map(sub => ({ key : sub, icon : GROUPS[sub].icon, name : `settings.${sub}.menu.title`, label : `settings.${sub}.menu.label`, hint : `settings.${sub}.menu.hint` }));
    /* A player with nothing to set here (Allow Players to Edit off) */
    context.empty = !all.length && !context.submenus.length;
    context.buttons = [{ type : "submit", icon : "fa-solid fa-floppy-disk", label : "SETTINGS.Save" }];
    return context;
  }

  _onRender(context, options){
    super._onRender?.(context, options);
    for(const button of this.element.querySelectorAll("[data-submenu]")){
      button.addEventListener("click", event => {
        event.preventDefault();
        new (SettingsMenu.for(button.dataset.submenu))().render({ force : true });
      });
    }
  }

  /** @this {SettingsMenu} */
  static async #onSubmit(event, form, formData){
    const data = formData.object;
    let reload = false, world = false;

    for(const key of this.keys){
      const config = SettingsMenu.config(key);
      if((config.scope === "world") && !game.user.isGM) continue;
      if(!(key in data) || (data[key] === settings.stored(key))) continue;

      await settings.change(key, data[key]);
      if(config.requiresReload){
        reload = true;
        world ||= config.scope === "world";
      }
    }

    if(reload) await foundry.applications.settings.SettingsConfig.reloadConfirm({ world });
  }
}
