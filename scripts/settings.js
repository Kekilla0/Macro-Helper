import { module } from './module.js';
import { logger } from './log.js';
import { SettingsMenu } from './settings-menu.js';
const log = logger.for(import.meta.url);

/**
 * Settings per feature. Foundry has no settings folders, so each group gets its own sub-menu
 * under Macro Helper (a button in Configure Settings that opens just that feature's settings).
 * Keys are unchanged from when they were flat, so saved values carry over.
 * World settings are the GM's and apply to everyone. A sub-menu with no client settings is GM only;
 * players only ever see their own (client) settings in a sub-menu.
 */
export const GROUPS = {
  helpers : {
    icon : "fa-solid fa-toolbox",
    settings : {
      helperMethods : { scope : "world", default : true, type : Boolean, requiresReload : true },
      rangeShape : { scope : "world", default : "circle", type : String,
        choices : { circle : "settings.rangeShape.circle", square : "settings.rangeShape.square" } },
      conditionAttacks : { scope : "world", default : true, type : Boolean },
      conditionSaves : { scope : "world", default : true, type : Boolean },
    },
  },
  itemMacro : {
    icon : "fa-solid fa-code",
    settings : {
      itemMacro : { scope : "world", default : true, type : Boolean, requiresReload : true },
      itemMacroTitleBar : { scope : "world", default : true, type : Boolean, requiresReload : true },
      itemMacroPlayers : { scope : "world", default : true, type : Boolean },
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
      rollItemMasteries : { scope : "world", default : true, type : Boolean },
      rollItemSavage : { scope : "world", default : true, type : Boolean },
      rollItemManeuvers : { scope : "world", default : true, type : Boolean },
      rollItemStaged : { scope : "world", default : true, type : Boolean },
      rollItemAdvantage : { scope : "world", default : "keys", type : String,
        choices : { keys : "settings.rollItemAdvantage.keys", prompt : "settings.rollItemAdvantage.prompt", none : "settings.rollItemAdvantage.none" } },
    },
  },
  /* Table rules that aren't RAW, all off by default */
  homebrew : {
    icon : "fa-solid fa-flask",
    settings : {
      homebrewPush : { scope : "world", default : false, type : Boolean },
      homebrewFlanking : { scope : "world", default : "off", type : String,
        choices : { off : "settings.homebrewFlanking.off", advantage : "settings.homebrewFlanking.advantage", bonus : "settings.homebrewFlanking.bonus" } },
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
        /* GM only, unless it has a setting players choose for themselves */
        restricted : !Object.values(groupSettings).some(s => s.scope === "client"),
      });
      for(const [key, data] of Object.entries(groupSettings)) settings.#register(key, { ...data, config : false });
    }

    for(const [key, data] of Object.entries(GENERAL)) settings.#register(key, data);
  }
}
