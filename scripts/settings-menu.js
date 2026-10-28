import { module } from './module.js';
import { settings, GROUPS } from './settings.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * One page of settings, opened from its button in Configure Settings → Macro Helper.
 * World settings are read-only for players, client settings are theirs to change. A setting whose Features switch
 * is off (its part, or its page's) shows greyed, with the reason.
 * Usage : SettingsMenu.for("rules") gives the class registerMenu needs for that page.
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

  /* GMs see every setting of the group, players only their own client settings; a setting whose feature is off (needs)
     isn't shown, nor to players one they aren't allowed (players) */
  get keys(){
    const all = Object.entries(GROUPS[this.constructor.GROUP]?.settings ?? {});
    return all.filter(([, data]) => (!data.needs || settings.value(data.needs))
      && (game.user.isGM || ((data.scope === "client") && (!data.players || settings.value(data.players)))))
      .map(([key]) => key);
  }

  /* The Features switch a setting needs (its own part, or its page's), while that's off (saved value : the page shows what's saved) */
  static partOff(group, key){
    const page = GROUPS[group];
    return [page.settings[key]?.part, page.part].find(p => p && (settings.stored(p) === false)) ?? null;
  }

  static config(key){
    return game.settings.settings.get(`${module.id}.${key}`);
  }

  async _prepareContext(options){
    const context = await super._prepareContext(options);
    const page = GROUPS[this.constructor.GROUP];
    const all = this.keys.map(key => {
      const config = SettingsMenu.config(key);
      const data = page.settings[key];
      const part = SettingsMenu.partOff(this.constructor.GROUP, key);
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
        disabled : ((config.scope === "world") && !game.user.isGM) || !!part,
        off : part ? game.i18n.format("settings.menu.partOff", { part : game.i18n.localize(`settings.${part}.title`) }) : "",
        homebrew : !!data.homebrew,
        section : data.section ? `settings.${this.constructor.GROUP}.section.${data.section}` : "",
      };
    });
    context.settings = all;
    /* A player with nothing to set here (Allow Players to Edit off) */
    context.empty = !all.length;
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
      /* Greyed (its part off) : left as saved */
      if(SettingsMenu.partOff(this.constructor.GROUP, key)) continue;
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
