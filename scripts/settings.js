import { module } from './module.js';
import { logger } from './log.js';
import { SettingsMenu } from './settings-menu.js';
const log = logger.for(import.meta.url);

/**
 * Settings per feature. Foundry has no settings folders, so each group gets its own sub-menu
 * under Macro Helper (a button in Configure Settings that opens just that feature's settings).
 * Keys are unchanged from when they were flat, so saved values carry over.
 */
export const GROUPS = {
  helpers : {
    icon : "fa-solid fa-toolbox",
    settings : {
      helperMethods : { scope : "world", default : true, type : Boolean, requiresReload : true },
      rangeShape : { scope : "world", default : "circle", type : String,
        choices : { circle : "settings.rangeShape.circle", square : "settings.rangeShape.square" } },
      conditionAttacks : { scope : "world", default : true, type : Boolean },
    },
  },
  itemMacro : {
    icon : "fa-solid fa-code",
    settings : {
      itemMacro : { scope : "world", default : true, type : Boolean, requiresReload : true },
      itemMacroTitleBar : { scope : "client", default : true, type : Boolean, requiresReload : true },
    },
  },
  hookMacros : {
    icon : "fa-solid fa-link",
    settings : {
      hookMacros : { scope : "world", default : true, type : Boolean, requiresReload : true },
    },
  },
  rollItem : {
    icon : "fa-solid fa-dice-d20",
    settings : {
      rollItem : { scope : "world", default : true, type : Boolean },
      rollItemDefault : { scope : "world", default : false, type : Boolean },
      rollItemSaves : { scope : "world", default : false, type : Boolean },
      rollItemHeals : { scope : "world", default : false, type : Boolean },
      rollItemDamage : { scope : "world", default : false, type : Boolean },
      rollItemUtility : { scope : "world", default : false, type : Boolean },
      rollItemPick : { scope : "client", default : "off", type : String,
        choices : { off : "settings.rollItemPick.off", empty : "settings.rollItemPick.empty", always : "settings.rollItemPick.always" } },
      rollItemMultiattack : { scope : "world", default : false, type : Boolean },
      rollItemHotkeys : { scope : "client", default : true, type : Boolean },
    },
  },
};

/* Shown directly in Macro Helper's section of Configure Settings */
const GENERAL = {
  debug : { scope : "world", config : true, default : false, type : Boolean },
};

export class settings{
  static value(key){
    return game.settings.get(module.id, key);
  }

  static async change(key, data){
    return await game.settings.set(module.id, key, data);
  }

  /* name/hint are passed as i18n keys, Foundry localizes them when rendering */
  static #register(key, data){
    game.settings.register(module.id, key, {
      name : `settings.${key}.title`,
      hint : `settings.${key}.hint`,
      ...data
    });
  }

  static register(){
    log.info("Registering all settings.");

    for(const [group, { icon, settings : groupSettings }] of Object.entries(GROUPS)){
      game.settings.registerMenu(module.id, `${group}Menu`, {
        name : `settings.${group}.menu.title`,
        label : `settings.${group}.menu.label`,
        hint : `settings.${group}.menu.hint`,
        icon,
        type : SettingsMenu.for(group),
        restricted : false,   // players can still change their own client settings in it
      });
      for(const [key, data] of Object.entries(groupSettings)) settings.#register(key, { ...data, config : false });
    }

    for(const [key, data] of Object.entries(GENERAL)) settings.#register(key, data);
  }
}
