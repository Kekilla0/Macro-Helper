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
    /* Buttons opening a page of their own (a group with nested : true) */
    submenus : ["methods"],
    settings : {
      rangeShape : { scope : "world", default : "circle", type : String,
        choices : { circle : "settings.rangeShape.circle", square : "settings.rangeShape.square" } },
      initiativeMethod : { scope : "world", default : "player", type : String,
        choices : { player : "settings.initiativeMethod.player", auto : "settings.initiativeMethod.auto" } },
      initiativeMessages : { scope : "world", default : "individual", type : String,
        choices : { individual : "settings.initiativeMessages.individual", compact : "settings.initiativeMessages.compact" } },
    },
  },
  /* Helpers → Methods : which kinds of document get the helpers as methods (token.distanceTo(other)...) */
  methods : {
    icon : "fa-solid fa-cubes",
    nested : true,
    settings : {
      methodsActor : { scope : "world", default : true, type : Boolean, requiresReload : true },
      methodsToken : { scope : "world", default : true, type : Boolean, requiresReload : true },
      methodsItem : { scope : "world", default : true, type : Boolean, requiresReload : true },
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
      hookMacrosPlayers : { scope : "world", default : false, type : Boolean },
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
      collapseCards : { scope : "world", default : true, type : Boolean },
      clearTemplates : { scope : "world", default : true, type : Boolean },
      rollItemPick : { scope : "client", default : "always", type : String,
        choices : { off : "settings.rollItemPick.off", empty : "settings.rollItemPick.empty", always : "settings.rollItemPick.always" } },
      rollItemMasteries : { scope : "world", default : true, type : Boolean },
      rollItemManeuvers : { scope : "world", default : true, type : Boolean },
      rollItemStaged : { scope : "world", default : true, type : Boolean },
      rollItemTemplateTargets : { scope : "world", default : true, type : Boolean },
      rollItemDmScreen : { scope : "world", default : false, type : Boolean },
      rollItemAdvantage : { scope : "world", default : "keys", type : String,
        choices : { keys : "settings.rollItemAdvantage.keys", prompt : "settings.rollItemAdvantage.prompt", none : "settings.rollItemAdvantage.none" } },
      /* The rules applied to rolls (moved from Helpers : same keys, saved values kept) */
      conditionAttacks : { scope : "world", default : true, type : Boolean },
      downedRules : { scope : "world", default : true, type : Boolean },
      visionRules : { scope : "world", default : true, type : Boolean },
      weaponRules : { scope : "world", default : "warn", type : String,
        choices : { warn : "settings.weaponRules.warn", block : "settings.weaponRules.block", change : "settings.weaponRules.change", off : "settings.weaponRules.off" } },
      traitRules : { scope : "world", default : true, type : Boolean },
      classRules : { scope : "world", default : true, type : Boolean },
    },
  },
  /* Table rules that aren't RAW, all off by default */
  homebrew : {
    icon : "fa-solid fa-flask",
    settings : {
      homebrewPush : { scope : "world", default : false, type : Boolean },
      homebrewInitiative : { scope : "world", default : false, type : Boolean },
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

    for(const [group, { icon, settings : groupSettings, nested }] of Object.entries(GROUPS)){
      /* A nested page opens from its parent page's button, not from Configure Settings */
      if(nested){
        for(const [key, data] of Object.entries(groupSettings)) settings.#register(key, { ...data, config : false });
        continue;
      }
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
    /* Settings that were replaced : still registered (hidden) so their saved values can be read once */
    for(const key of ["helperMethods", "autoInitiative", "compactInitiative"]){
      settings.#register(key, { scope : "world", config : false, default : null, type : Boolean });
    }
    /* Which settings migrations the world has had */
    settings.#register("settingsVersion", { scope : "world", config : false, default : 0, type : Number });
  }

  /**
   * The active GM carries old settings over to the ones that replaced them, once :
   *   Methods on Tokens, Actors & Items (one switch) -> Helpers → Methods (one per kind)
   *   Auto-Roll Initiative -> Initiative Method ; Compact Initiative -> Initiative Messages
   */
  static async migrate(){
    if(!game.users.activeGM?.isSelf || (Number(settings.value("settingsVersion")) >= 1)) return;
    const old = key => { try { return game.settings.get(module.id, key); } catch { return null; } };
    const moves = [];
    if(old("helperMethods") === false) moves.push(["methodsActor", false], ["methodsToken", false], ["methodsItem", false]);
    if(old("autoInitiative") === true) moves.push(["initiativeMethod", "auto"]);
    if(old("compactInitiative") === true) moves.push(["initiativeMessages", "compact"]);
    for(const [key, value] of moves) await settings.change(key, value);
    await settings.change("settingsVersion", 1);
    if(moves.length) log.info("Settings carried over", moves);
  }
}
