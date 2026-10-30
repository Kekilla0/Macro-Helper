import { module } from './module.js';
import { logger } from './log.js';
import { SettingsMenu } from './settings-menu.js';
const log = logger.for(import.meta.url);

/**
 * Settings per page, in the order listed (My Settings on top). Foundry has no settings folders, so each page gets its
 * own button under Macro Helper in Configure Settings (one level : no page opens another). Features holds every part's
 * on / off; the other pages that part's options, greyed while it's off (part). A setting that stayed the same kept its key, so saved values carry over;
 * merged settings got new keys, filled once by migrate().
 * World settings are the GM's and apply to everyone, on GM-only pages. Each user's own (client) settings are on one
 * page, My Settings, which shows only those whose feature the GM has on (needs : a setting that must be on; players :
 * one more that must be on for players).
 * A setting may also have : section (a heading above it), homebrew (tagged Homebrew : not rules as written),
 * part (a Features switch : greyed while it's off; a page's own part covers all of it).
 */
export const GROUPS = {
  /* Each user's own choices, for the features the GM has on */
  player : {
    icon : "fa-solid fa-user-gear",
    settings : {
      rollItemPick : { scope : "client", default : "always", type : String, needs : "rollItem",
        choices : { off : "settings.rollItemPick.off", empty : "settings.rollItemPick.empty", always : "settings.rollItemPick.always" } },
      handsMain : { scope : "client", default : "right", type : String, needs : "handsEnabled",
        choices : { right : "settings.handsMain.right", left : "settings.handsMain.left" } },
      /* Players only see it when they may edit item macros */
      itemMacroTitleBar : { scope : "client", default : true, type : Boolean, requiresReload : true, needs : "itemMacro", players : "itemMacroPlayers" },
    },
  },
  /* Every part of the module, on or off */
  features : {
    icon : "fa-solid fa-toggle-on",
    settings : {
      rollItemEnabled : { scope : "world", default : true, type : Boolean },
      requestsEnabled : { scope : "world", default : true, type : Boolean, requiresReload : true },
      itemMacro : { scope : "world", default : true, type : Boolean, requiresReload : true },
      hookMacros : { scope : "world", default : true, type : Boolean, requiresReload : true },
      automationEnabled : { scope : "world", default : true, type : Boolean },
      actionTracker : { scope : "world", default : false, type : Boolean, part : "automationEnabled" },
      combatLog : { scope : "world", default : "tracker", type : String, part : "actionTracker",
        choices : { tracker : "settings.combatLog.tracker", journal : "settings.combatLog.journal", whispers : "settings.combatLog.whispers" } },
      debug : { scope : "world", default : false, type : Boolean },
    },
  },
  /* Every chat card the module makes : Roll Item's, the requests', initiative's */
  cards : {
    icon : "fa-solid fa-message",
    settings : {
      rollType : { scope : "world", default : "quick", type : String, part : "rollItemEnabled",
        choices : { normal : "settings.rollType.normal", quick : "settings.rollType.quick" } },
      rollItemAdvantage : { scope : "world", default : "keys", type : String, part : "rollItemEnabled",
        choices : { prompt : "settings.rollItemAdvantage.prompt", keys : "settings.rollItemAdvantage.keys", none : "settings.rollItemAdvantage.none" } },
      /* Any dnd5e card, Roll Item or not */
      cardDescriptions : { scope : "world", default : "collapsed", type : String,
        choices : { open : "settings.cardDescriptions.open", collapsed : "settings.cardDescriptions.collapsed" } },
      /* Roll Item's numbers and the requests' DC */
      dmScreen : { scope : "world", default : false, type : Boolean },
      /* Initiative's and the requests' */
      chatMessages : { scope : "world", default : "compact", type : String,
        choices : { compact : "settings.chatMessages.compact", individual : "settings.chatMessages.individual" } },
      areaTargets : { scope : "world", default : true, type : Boolean, part : "rollItemEnabled" },
      /* Any area a dnd5e activity places, Roll Item or not */
      clearAreas : { scope : "world", default : true, type : Boolean, part : "automationEnabled" },
    },
  },
  /* Item Macro, Hook Macros and the helpers as methods : for macro writers */
  macros : {
    icon : "fa-solid fa-code",
    settings : {
      itemMacroPlayers : { scope : "world", default : true, type : Boolean, part : "itemMacro" },
      hookMacrosPlayers : { scope : "world", default : false, type : Boolean, part : "hookMacros" },
      /* Which kinds of document get the helpers as methods (token.distanceTo(other)...) */
      methodsActor : { scope : "world", default : true, type : Boolean, requiresReload : true },
      methodsToken : { scope : "world", default : true, type : Boolean, requiresReload : true },
      methodsItem : { scope : "world", default : true, type : Boolean, requiresReload : true },
    },
  },
  /* System Automation : the rules the module applies, one page in sections */
  rules : {
    icon : "fa-solid fa-scale-balanced",
    part : "automationEnabled",
    settings : {
      weaponRules : { scope : "world", default : "warn", type : String, section : "enforcement",
        choices : { off : "settings.weaponRules.off", warn : "settings.weaponRules.warn", block : "settings.weaponRules.block" } },
      ruleFixes : { scope : "world", default : "off", type : String,
        choices : { off : "settings.ruleFixes.off", offer : "settings.ruleFixes.offer", auto : "settings.ruleFixes.auto" } },
      conditions : { scope : "world", default : "full", type : String, section : "core",
        choices : { off : "settings.conditions.off", attacks : "settings.conditions.attacks", full : "settings.conditions.full" } },
      vision : { scope : "world", default : "full", type : String,
        choices : { off : "settings.vision.off", conditions : "settings.vision.conditions", full : "settings.vision.full" } },
      masteryRules : { scope : "world", default : true, type : Boolean },
      defaultActions : { scope : "world", default : "on", type : String,
        choices : { off : "settings.defaultActions.off", on : "settings.defaultActions.on", favorites : "settings.defaultActions.favorites" } },
      classRules : { scope : "world", default : true, type : Boolean, section : "characters" },
      subclassRules : { scope : "world", default : true, type : Boolean },
      speciesRules : { scope : "world", default : true, type : Boolean },
      featRules : { scope : "world", default : true, type : Boolean },
      spellRules : { scope : "world", default : true, type : Boolean },
      handsEnabled : { scope : "world", default : true, type : Boolean, section : "equipment" },
      homebrewLoadHand : { scope : "world", default : false, type : Boolean, homebrew : true },
      handsLight : { scope : "world", default : "timed", type : String,
        choices : { off : "settings.handsLight.off", light : "settings.handsLight.light", timed : "settings.handsLight.timed" } },
      ammunition : { scope : "world", default : "half", type : String,
        choices : { off : "settings.ammunition.off", half : "settings.ammunition.half", oddRoll : "settings.ammunition.oddRoll", hits : "settings.ammunition.hits" } },
      homebrewAmmoSearch : { scope : "world", default : false, type : Boolean, homebrew : true },
      spellMaterials : { scope : "world", default : "off", type : String,
        choices : { off : "settings.spellMaterials.off", item : "settings.spellMaterials.item", coins : "settings.spellMaterials.coins" } },
      initiativeMethod : { scope : "world", default : "player", type : String, section : "combat",
        choices : { player : "settings.initiativeMethod.player", auto : "settings.initiativeMethod.auto" } },
      homebrewInitiative : { scope : "world", default : false, type : Boolean, homebrew : true },
      summonInitiative : { scope : "world", default : "roll", type : String,
        choices : { roll : "settings.summonInitiative.roll", shared : "settings.summonInitiative.shared" } },
      homebrewFlanking : { scope : "world", default : "off", type : String, homebrew : true,
        choices : { off : "settings.homebrewFlanking.off", advantage : "settings.homebrewFlanking.advantage", bonus : "settings.homebrewFlanking.bonus" } },
      homebrewPush : { scope : "world", default : false, type : Boolean, homebrew : true },
    },
  },
};

/* Replaced by a merged setting (settings version 7) : still registered, hidden, so migrate() can read what was saved */
const MERGED = {
  initiativeMessages : String, requestsMessages : String, requestsDmScreen : Boolean, actionRules : Boolean, actionFavorites : Boolean,
  ammoRecovery : String, homebrewAmmoRecovery : String, combatLogChat : Boolean, combatLogJournal : Boolean, rangeShape : String,
};

/* The settings that replaced these : the code still asks for the old names, answered from the new dropdowns.
   Where a new setting isn't there (an old world before its carry-over), the old one answers. */
const RAW = key => game.settings.get(module.id, key);
/* Enable Roll Item : off turns off everything on its page */
const ENABLED = () => { try { return RAW("rollItemEnabled") !== false; } catch { return true; } };
/* Enable System Automation : off turns off every rule (each setting below then reads as off) */
const AUTO = () => { try { return RAW("automationEnabled") !== false; } catch { return true; } };
const from = (key, test, old) => () => {
  if(!ENABLED()) return false;
  try { return test(RAW(key)); } catch { return RAW(old); }
};
const quick = old => from("rollType", v => v === "quick", old);
/* A System Automation dropdown read as a switch : off with it */
const auto = (key, test, old) => () => {
  if(!AUTO()) return false;
  try { return test(RAW(key)); } catch { return RAW(old); }
};
/* An automation switch : off with System Automation; on where neither it nor an old setting is saved yet */
const rule = (key, old) => () => {
  if(!AUTO()) return false;
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
  /* System Automation → Combat */
  clearTemplates : () => AUTO() && (() => { try { return RAW("clearAreas") === true; } catch { return RAW("clearTemplates"); } })(),
  conditionAttacks : auto("conditions", v => v !== "off", "conditionAttacks"),
  downedRules : auto("conditions", v => v === "full", "downedRules"),
  visionRules : auto("vision", v => v !== "off", "visionRules"),
  rollItemMasteries : rule("masteryRules", "rollItemMasteries"),
  /* Default Actions : Dash, Disengage, Dodge, Help, and the Unarmed Strike's Grapple / Shove (On + Favorites : also in Favorites) */
  rollItemManeuvers : auto("defaultActions", v => v !== "off", "rollItemManeuvers"),
  actionRules : auto("defaultActions", v => v !== "off", "actionRules"),
  actionFavorites : auto("defaultActions", v => v === "favorites", "actionFavorites"),
  /* Ammunition : the 2024 rule (half found) and the homebrew ways of finding it */
  ammoRecovery : () => (AUTO() ? ((RAW("ammunition") === "off") ? "off" : "half") : "off"),
  homebrewAmmoRecovery : () => (["oddRoll", "hits"].includes(RAW("ammunition")) ? RAW("ammunition") : "rules"),
  /* Combat Log : kept as a journal; whispers too */
  combatLogJournal : () => RAW("combatLog") !== "tracker",
  combatLogChat : () => RAW("combatLog") === "whispers",
  /* Initiative's and requests' messages */
  initiativeMessages : () => RAW("chatMessages"),
  requestsMessages : () => RAW("chatMessages"),
  /* One DM Screen : Roll Item's numbers (with Roll Item on) and the requests' DC */
  requestsDmScreen : () => RAW("dmScreen") === true,
  speciesRules : rule("speciesRules", "traitRules"),
  featRules : rule("featRules", "traitRules"),
  spellRules : rule("spellRules"),
  /* Off unless switched on */
  actionTracker : () => AUTO() && (() => { try { return RAW("actionTracker") === true; } catch { return false; } })(),
  /* System Automation's own keys : off with it */
  /* Rule Limits : "change" was Block + Fix Automatically (settings version 6) */
  weaponRules : () => (AUTO() ? ((RAW("weaponRules") === "change") ? "block" : RAW("weaponRules")) : "off"),
  ruleFixes : () => (AUTO() ? (() => { try { return (RAW("weaponRules") === "change") ? "auto" : RAW("ruleFixes"); } catch { return "off"; } })() : "off"),
  classRules : rule("classRules"),
  subclassRules : rule("subclassRules"),
  vision : () => (AUTO() ? RAW("vision") : "off"),
};

/* The rest of System Automation's settings, as they read while it's off */
const AUTOMATION_OFF = {
  conditions : "off", masteryRules : false, handsEnabled : false, handsLight : "off", ammunition : "off", spellMaterials : "off",
  initiativeMethod : "player", summonInitiative : "roll", clearAreas : false, defaultActions : "off",
  homebrewPush : false, homebrewInitiative : false, homebrewAmmoSearch : false, homebrewLoadHand : false, homebrewFlanking : "off",
};

/* The old Roll Item switches, hidden : read once by the carry-over */
const LEGACY = {
  rollItem : true, rollItemDefault : false, rollItemSaves : false, rollItemHeals : false, rollItemDamage : false,
  rollItemUtility : false, collapseCards : true, clearTemplates : true, rollItemMasteries : true, rollItemManeuvers : true,
  rollItemStaged : true, rollItemTemplateTargets : true, rollItemDmScreen : false, conditionAttacks : true,
  downedRules : true, visionRules : true,
};

/* A page has a setting players choose for themselves */
const hasClient = group => Object.values(GROUPS[group]?.settings ?? {}).some(s => s.scope === "client");

export class settings{
  /* A part's switch : () => on (dnd5e, and the setting on). `static enabled = settings.on("classRules");` */
  static on(key){
    return () => (game.system.id === "dnd5e") && !!settings.value(key);
  }

  static value(key){
    if(VIRTUAL[key]) return VIRTUAL[key]();
    if((key in AUTOMATION_OFF) && !AUTO()) return AUTOMATION_OFF[key];
    return game.settings.get(module.id, key);
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

    for(const [group, { icon, settings : groupSettings }] of Object.entries(GROUPS)){
      game.settings.registerMenu(module.id, `${group}Menu`, {
        name : `settings.${group}.menu.title`,
        label : `settings.${group}.menu.label`,
        hint : `settings.${group}.menu.hint`,
        icon,
        type : SettingsMenu.for(group),
        /* GM only, unless it (or a page it opens) has a setting players choose for themselves */
        restricted : !hasClient(group),
      });
      /* Our own page fields stay out of Foundry's setting config */
      for(const [key, { section, homebrew, part, needs, players, ...data }] of Object.entries(groupSettings)){
        settings.#register(key, { ...data, config : false });
      }
    }

    for(const [key, type] of Object.entries(MERGED)) settings.#register(key, { scope : "world", config : false, default : null, type });
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
    /* Ammunition Recovery's "odd one by 1d2" -> Homebrew's Recovering Ammunition (the 2024 rule stays on Equipment) */
    if((version < 5) && (old("ammoRecovery") === "halfRoll")) moves.push(["ammoRecovery", "half"], ["homebrewAmmoRecovery", "oddRoll"]);
    /* Rule Limits' "Change" -> Rule Limits Block + Rule Fixes Fix Automatically */
    if((version < 6) && (old("weaponRules") === "change")) moves.push(["weaponRules", "block"], ["ruleFixes", "auto"]);
    for(const [key, value] of moves) await settings.change(key, value);
    /* One page per part, merged settings (the old ones read after the moves above) :
       Initiative / Request Messages -> Chat Messages ; the requests' DM Screen -> the one DM Screen ;
       Default Actions + Favorites -> Default Actions ; Ammunition Recovery + Recovering Ammunition -> Ammunition ;
       Combat Log Journal + Whisper -> Combat Log ; Range Shape -> the scene's grid diagonals (dropped) */
    const merged = [];
    if(version < 7){
      if(stored("initiativeMessages")) merged.push(["chatMessages", old("initiativeMessages")]);
      else if(stored("requestsMessages")) merged.push(["chatMessages", old("requestsMessages")]);
      if(stored("requestsDmScreen") && !stored("dmScreen")) merged.push(["dmScreen", !!old("requestsDmScreen")]);
      if(old("actionRules") === false) merged.push(["defaultActions", "off"]);
      else if(old("actionFavorites") === true) merged.push(["defaultActions", "favorites"]);
      if(old("ammoRecovery") === "off") merged.push(["ammunition", "off"]);
      else if(["oddRoll", "hits"].includes(old("homebrewAmmoRecovery"))) merged.push(["ammunition", old("homebrewAmmoRecovery")]);
      if(old("combatLogChat") === true) merged.push(["combatLog", "whispers"]);
      else if(old("combatLogJournal") === true) merged.push(["combatLog", "journal"]);
    }
    for(const [key, value] of merged) await settings.change(key, value);
    moves.push(...merged);
    if(version < 7) await settings.change("settingsVersion", 7);
    if(moves.length) log.info("Settings carried over", moves);
  }
}
