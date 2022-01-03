import { MacroHelperConfig } from './settings-config.js';

const NAME = "macro-helper";
const PATH = `/modules/${NAME}`;
const TITLE = "Macro Helper";
const GLOBAL = "fn";

export class module{
  static async build(){
    module.data = {
      name : NAME, path : PATH, title : TITLE, global : GLOBAL,
    };

    window[module.data.global] = {};
  }

  static async register(){
    logger.info("Initializing Module");
    module.settings();
    module.globalize();
  }

  static globalize(){
    window[module.data.global].wait = module.wait;
    window[module.data.global].waitFor = module.waitFor;
  }

  static settings(){
    game.settings.registerMenu(module.data.name, "helperSettings", {
      name : "Configure Settings", label : "Open Settings Menu", icon : "fas fa-user-cog", type : MacroHelperConfig, restricted : false,
    });
  }

  static setting(key){
    return game.settings.get(module.data.name, key);
  }

  static localize(...args){
    return game.i18n.localize(...args);
  }

  static applySettings(settingsData){
    Object.entries(settingsData).forEach(([key, data])=> {
      game.settings.register(
        module.data.name, key, {
          name : module.localize(`setting.${key}.name`),
          hint : module.localize(`setting.${key}.hint`),
          ...data
        }
      );
    });
  }

  static async wait(ms){
    return new Promise((resolve)=> setTimeout(resolve, ms));
  }

  static async waitFor(fn, m = 200, w = 100, i = 0){
    while(!fn(i, ((i*w)/100)) && i < m){
      i++;
      await module.wait(w);
    }
    return i === m ? false : true;
  }


}

export class logger {
  static info(...args) {
    console.log(`${module?.data?.title || "" }  | `, ...args);
  }
  static debug(...args) {
    if (module.setting('debug'))
      this.info("DEBUG | ", ...args);
  }
  static error(...args) {
    console.error(`${module?.data?.title || "" } | ERROR | `, ...args);
    ui.notifications.error(`${module?.data?.title || "" } | ERROR | ${args[0]}`);
  }

  static notify(...args) {
    ui.notifications.notify(`${args[0]}`);
  }

  static register(){
    this.settings()
  }

  static settings(){
    const config = true;
    const settingsData = {
      debug : {
        scope: "world", config, default: false, type: Boolean,
      },
    };

    module.applySettings(settingsData);
  }
}

export class dcl{
  static register(){}
  static settings(){}
  static hooks(){}
  static patch(){}
  static globals(){}
}
