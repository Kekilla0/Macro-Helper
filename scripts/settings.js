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
      initiativeMethod : { scope : "world", default : "player", type : String,
        choices : { player : "settings.initiativeMethod.player", auto : "settings.initiativeMethod.auto" } },
      initiativeMessages : { scope : "world", default : "individual", type : String,
        choices : { individual : "settings.initiativeMessages.individual", compact : "settings.initiativeMessages.compact" } },
      summonInitiative : { scope : "world", default : "roll", type : String,
        choices : { roll : "settings.summonInitiative.roll", shared : "settings.summonInitiative.shared" } },
      /* Any dnd5e card, Roll Item or not */
      cardDescriptions : { scope : "world", default : "collapsed", type : String,
        choices : { open : "settings.cardDescriptions.open", collapsed : "settings.cardDescriptions.collapsed" } },
      /* Any area a dnd5e activity places, Roll Item or not */
      clearAreas : { scope : "world", default : true, type : Boolean },
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
      /* Each user's own choice; players only see it when they may edit item macros (players : that world setting) */
      itemMacroTitleBar : { scope : "client", default : true, type : Boolean, requiresReload : true, players : "itemMacroPlayers" },
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
    submenus : ["rules"],
    settings : {
      /* top : shown above the page's buttons */
      rollItemEnabled : { scope : "world", default : true, type : Boolean, top : true },
      dmScreen : { scope : "world", default : false, type : Boolean },
      rollType : { scope : "world", default : "quick", type : String,
        choices : { normal : "settings.rollType.normal", quick : "settings.rollType.quick" } },
      rollItemAdvantage : { scope : "world", default : "keys", type : String,
        choices : { prompt : "settings.rollItemAdvantage.prompt", keys : "settings.rollItemAdvantage.keys", none : "settings.rollItemAdvantage.none" } },
      rollItemPick : { scope : "client", default : "always", type : String,
        choices : { off : "settings.rollItemPick.off", empty : "settings.rollItemPick.empty", always : "settings.rollItemPick.always" } },
      areaTargets : { scope : "world", default : true, type : Boolean },
    },
  },
  /* Roll Item → Rules : the rules applied to rolls */
  rules : {
    icon : "fa-solid fa-scale-balanced",
    nested : true,
    settings : {
      conditions : { scope : "world", default : "full", type : String,
        choices : { off : "settings.conditions.off", attacks : "settings.conditions.attacks", full : "settings.conditions.full" } },
      vision : { scope : "world", default : "full", type : String,
        choices : { off : "settings.vision.off", conditions : "settings.vision.conditions", full : "settings.vision.full" } },
      weaponRules : { scope : "world", default : "warn", type : String,
        choices : { off : "settings.weaponRules.off", warn : "settings.weaponRules.warn", block : "settings.weaponRules.block", change : "settings.weaponRules.change" } },
      masteryRules : { scope : "world", default : true, type : Boolean },
      actionRules : { scope : "world", default : true, type : Boolean },
      speciesRules : { scope : "world", default : true, type : Boolean },
      classRules : { scope : "world", default : true, type : Boolean },
      spellRules : { scope : "world", default : true, type : Boolean },
      featRules : { scope : "world", default : true, type : Boolean },
    },
  },
  /* Table rules that aren't RAW, all off by default */
  homebrew : {
    icon : "fa-solid fa-flask",
    settings : {
      rangeShape : { scope : "world", default : "circle", type : String,
        choices : { circle : "settings.rangeShape.circle", square : "settings.rangeShape.square" } },
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

/* The settings that replaced these : the code still asks for the old names, answered from the new dropdowns.
   Where a new setting isn't there (an old world before its carry-over), the old one answers. */
const RAW = key => game.settings.get(module.id, key);
/* Enable Roll Item : off turns off everything on its page, Rules included */
const ENABLED = () => { try { return RAW("rollItemEnabled") !== false; } catch { return true; } };
const from = (key, test, old) => () => {
  if(!ENABLED()) return false;
  try { return test(RAW(key)); } catch { return RAW(old); }
};
const quick = old => from("rollType", v => v === "quick", old);
/* A Rules switch : off with Roll Item; on where neither it nor an old setting is saved yet */
const rule = (key, old) => () => {
  if(!ENABLED()) return false;
  try { return RAW(key) !== false; } catch { try { return old ? RAW(old) !== false : true; } catch { return true; } }
};
const VIRTUAL = {
  /* Roll Item at all (any Roll Type) : picks, template help, reroll buttons, sheet rolls without dialog, macros */
  rollItem : () => ENABLED() && (() => { try { RAW("rollType"); return true; } catch { return RAW("rollItem"); } })(),
  /* Roll Item's own cards (Roll Type : Quick) */
  rollItemDefault : quick("rollItemDefault"),
  rollItemSaves : quick("rollItemSaves"),
  rollItemHeals : quick("rollItemHeals"),
  rollItemDamage : quick("rollItemDamage"),
  rollItemUtility : quick("rollItemUtility"),
  /* Damage after the attack dice land : only when there are dice to watch (Dice So Nice) */
  rollItemStaged : () => ENABLED() && !!game.modules.get("dice-so-nice")?.active,
  rollItemDmScreen : from("dmScreen", v => v === true, "rollItemDmScreen"),
  /* A Helpers setting : not tied to Enable Roll Item */
  collapseCards : () => { try { return RAW("cardDescriptions") === "collapsed"; } catch { return RAW("collapseCards"); } },
  rollItemTemplateTargets : from("areaTargets", v => v === true, "rollItemTemplateTargets"),
  /* A Helpers setting : not tied to Enable Roll Item */
  clearTemplates : () => { try { return RAW("clearAreas") === true; } catch { return RAW("clearTemplates"); } },
  conditionAttacks : from("conditions", v => v !== "off", "conditionAttacks"),
  downedRules : from("conditions", v => v === "full", "downedRules"),
  visionRules : from("vision", v => v !== "off", "visionRules"),
  rollItemMasteries : rule("masteryRules", "rollItemMasteries"),
  /* Default Actions : Dash, Disengage, Dodge, Help, and the Unarmed Strike's Grapple / Shove */
  rollItemManeuvers : rule("actionRules", "rollItemManeuvers"),
  actionRules : rule("actionRules"),
  speciesRules : rule("speciesRules", "traitRules"),
  featRules : rule("featRules", "traitRules"),
  spellRules : rule("spellRules"),
  /* The Rules page's own keys : off with Roll Item */
  weaponRules : () => (ENABLED() ? RAW("weaponRules") : "off"),
  classRules : rule("classRules"),
  vision : () => (ENABLED() ? RAW("vision") : "off"),
};

/* The old Roll Item switches, hidden : read once by the carry-over */
const LEGACY = {
  rollItem : true, rollItemDefault : false, rollItemSaves : false, rollItemHeals : false, rollItemDamage : false,
  rollItemUtility : false, collapseCards : true, clearTemplates : true, rollItemMasteries : true, rollItemManeuvers : true,
  rollItemStaged : true, rollItemTemplateTargets : true, rollItemDmScreen : false, conditionAttacks : true,
  downedRules : true, visionRules : true,
};

export class settings{
  static value(key){
    return VIRTUAL[key] ? VIRTUAL[key]() : game.settings.get(module.id, key);
  }

  /* The stored value itself (the settings pages show what's saved, not what's in effect) */
  static stored(key){
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
    /* Roll Item dropdowns that were replaced again (NPC Numbers -> DM Screen, Damage Timing -> Dice So Nice) */
    for(const key of ["npcNumbers", "damageTiming", "weaponExtras", "areas"]){
      settings.#register(key, { scope : "world", config : false, default : null, type : String });
    }
    settings.#register("traitRules", { scope : "world", config : false, default : null, type : Boolean });
    for(const [key, value] of Object.entries(LEGACY)){
      settings.#register(key, { scope : "world", config : false, default : value, type : Boolean });
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
    if(!game.users.activeGM?.isSelf) return;
    const version = Number(settings.value("settingsVersion")) || 0;
    const old = key => { try { return game.settings.get(module.id, key); } catch { return null; } };
    const stored = key => !!game.settings.storage?.get?.("world")?.some?.(s => s.key === `${module.id}.${key}`);
    const moves = [];
    if(version < 1){
      if(old("helperMethods") === false) moves.push(["methodsActor", false], ["methodsToken", false], ["methodsItem", false]);
      if(old("autoInitiative") === true) moves.push(["initiativeMethod", "auto"]);
      if(old("compactInitiative") === true) moves.push(["initiativeMessages", "compact"]);
    }
    /* Roll Item's switches -> its dropdowns (only for worlds that had changed them : others take the new defaults) */
    if((version < 2) && Object.keys(LEGACY).some(stored)){
      const types = ["rollItemDefault", "rollItemSaves", "rollItemHeals", "rollItemDamage", "rollItemUtility"];
      moves.push(["rollType", (old("rollItem") && types.some(t => old(t))) ? "quick" : "normal"]);
      moves.push(["dmScreen", !!old("rollItemDmScreen")]);
      moves.push(["cardDescriptions", old("collapseCards") ? "collapsed" : "open"]);
      moves.push(["areaTargets", !!old("rollItemTemplateTargets")], ["clearAreas", !!old("clearTemplates")]);
      moves.push(["conditions", old("downedRules") ? "full" : old("conditionAttacks") ? "attacks" : "off"]);
      moves.push(["vision", old("visionRules") ? "full" : "off"]);
      moves.push(["masteryRules", !!old("rollItemMasteries")]);
      if(old("rollItemManeuvers") === false) moves.push(["actionRules", false]);
    }
    /* NPC Numbers (dropdown) -> DM Screen (switch) */
    if((version === 2) && stored("npcNumbers")) moves.push(["dmScreen", old("npcNumbers") === "hide"]);
    /* Weapon Extras / Species & Feats / Areas (dropdowns) -> one switch each */
    if((version >= 2) && (version < 4)){
      if(stored("weaponExtras")){
        moves.push(["masteryRules", old("weaponExtras") !== "off"]);
        if(old("weaponExtras") !== "both") moves.push(["actionRules", false]);
      }
      if(stored("traitRules") && (old("traitRules") === false)) moves.push(["speciesRules", false], ["featRules", false]);
      if(stored("areas")) moves.push(["areaTargets", old("areas") !== "leave"], ["clearAreas", old("areas") === "clear"]);
    }
    for(const [key, value] of moves) await settings.change(key, value);
    if(version < 4) await settings.change("settingsVersion", 4);
    if(moves.length) log.info("Settings carried over", moves);
  }
}
