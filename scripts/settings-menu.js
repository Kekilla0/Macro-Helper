import { module } from './module.js';
import { settings, GROUPS } from './settings.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * One page of settings, opened from its button in Configure Settings → Macro Helper.
 * World settings are read-only for players, client settings are theirs to change. A setting whose part is off is
 * hidden (shown again as soon as the part is turned on in the form); a page whose Features switch is off shows greyed,
 * with the reason.
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

  /* The switch a setting's own part needs, while that's off (value : the page's form, else what's saved). A part may be
     another setting of the page ("foodWater"), itself off by its own part, or a value of one ("foodWaterRules=homebrew") */
  static partOff(group, key, value = name => settings.stored(name), seen = new Set()){
    const page = GROUPS[group];
    const part = page.settings[key]?.part;
    if(!part || seen.has(part)) return null;
    seen.add(part);
    const [name, wanted] = part.split("=");
    const now = value(name);
    if((wanted === undefined) ? (now === false) : (String(now) !== wanted)) return part;
    return page.settings[name] ? this.partOff(group, name, value, seen) : null;
  }

  /* The page's own Features switch, while that's off (the whole page greyed) */
  static pageOff(group){
    const part = GROUPS[group].part;
    return (part && (settings.stored(part) === false)) ? part : null;
  }

  /* Why a setting is greyed : "Off while X is off" / "Only while X is Y" */
  static partReason(part){
    const [name, wanted] = part.split("=");
    const title = game.i18n.localize(`settings.${name}.title`);
    if(wanted === undefined) return game.i18n.format(GROUPS.features.settings[name] ? "settings.menu.partOff" : "settings.menu.partOffHere", { part : title });
    const choice = SettingsMenu.config(name)?.choices?.[wanted];
    return game.i18n.format("settings.menu.partValue", { part : title, value : choice ? game.i18n.localize(choice) : wanted });
  }

  static config(key){
    return game.settings.settings.get(`${module.id}.${key}`);
  }

  async _prepareContext(options){
    const context = await super._prepareContext(options);
    const page = GROUPS[this.constructor.GROUP];
    const part = SettingsMenu.pageOff(this.constructor.GROUP);
    let section = "";
    const all = this.keys.map(key => {
      const config = SettingsMenu.config(key);
      const data = page.settings[key];
      section = data.section ?? section;
      const isBoolean = (config.type === Boolean) || (config.type instanceof foundry.data.fields.BooleanField);
      return {
        key,
        id : `${this.id}-${key}`,
        name : config.name,
        /* Settings with no hint text show no hint line */
        hint : (config.hint && game.i18n.has(config.hint)) ? config.hint : "",
        value : settings.stored(key),
        isBoolean,
        /* Number keys ("2024", "2014") come first in an object, smallest first : newest edition first */
        choices : config.choices ? Object.entries(config.choices).map(([value, label]) => ({ value, label }))
          .sort((x, y) => (/^\d+$/.test(y.value) && /^\d+$/.test(x.value)) ? (y.value - x.value) : 0) : null,
        world : config.scope === "world",
        disabled : ((config.scope === "world") && !game.user.isGM) || !!part,
        off : part ? SettingsMenu.partReason(part) : "",
        homebrew : !!data.homebrew,
        heading : data.section ? `settings.${this.constructor.GROUP}.section.${data.section}` : "",
        section,
      };
    });
    context.settings = all;
    /* A player with nothing to set here (Allow Players to Edit off) */
    context.empty = !all.length;
    context.buttons = [{ type : "submit", icon : "fa-solid fa-floppy-disk", label : "SETTINGS.Save" }];
    return context;
  }

  async _onRender(context, options){
    await super._onRender(context, options);
    this.#showParts();
    this.element.addEventListener("change", () => this.#showParts());
  }

  /* Each setting shown while its part is on, as the form has it now; a section's heading while any of its own is */
  #showParts(){
    const fields = this.element.elements;
    const value = name => {
      const field = fields.namedItem(name);
      return field ? ((field.type === "checkbox") ? field.checked : field.value) : settings.stored(name);
    };
    const rows = [...this.element.querySelectorAll(".form-group[data-key]")];
    for(const row of rows) row.hidden = !!SettingsMenu.partOff(this.constructor.GROUP, row.dataset.key, value);
    for(const heading of this.element.querySelectorAll("h3[data-section]")) heading.hidden = !rows.some(r => !r.hidden && (r.dataset.section === heading.dataset.section));
  }

  /** @this {SettingsMenu} */
  static async #onSubmit(event, form, formData){
    const data = formData.object;
    let reload = false, world = false;

    for(const key of this.keys){
      const config = SettingsMenu.config(key);
      if((config.scope === "world") && !game.user.isGM) continue;
      /* Greyed (the page's part off) or hidden (its own) : left as saved */
      if(SettingsMenu.pageOff(this.constructor.GROUP) || SettingsMenu.partOff(this.constructor.GROUP, key, name => (name in data) ? data[name] : settings.stored(name))) continue;
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
