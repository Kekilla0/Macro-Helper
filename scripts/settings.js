import { module } from './module.js';
import { logger } from './log.js';
const log = logger.for(import.meta.url);

export class settings{
  static value(key){
    return game.settings.get(module.id, key);
  }

  static async change(key, data){
    return await game.settings.set(module.id, key, data);
  }

  static register(){
    log.info("Registering all settings.");

    const settingData = {
      itemMacro : {
        scope : "world", config : true, default : true, type : Boolean, requiresReload : true,
      },
      rollItem : {
        scope : "world", config : true, default : true, type : Boolean,
      },
      rollItemDefault : {
        scope : "world", config : true, default : false, type : Boolean,
      },
      rollItemSaves : {
        scope : "world", config : true, default : false, type : Boolean,
      },
      rollItemHeals : {
        scope : "world", config : true, default : false, type : Boolean,
      },
      rollItemDamage : {
        scope : "world", config : true, default : false, type : Boolean,
      },
      rollItemHotkeys : {
        scope : "client", config : true, default : true, type : Boolean,
      },
      debug : {
        scope : "world", config : true, default : false, type : Boolean,
      },
    };

    /* name/hint are passed as i18n keys, Foundry localizes them when rendering */
    Object.entries(settingData).forEach(([key, data])=> {
      game.settings.register(
        module.id, key, {
          name : `settings.${key}.title`,
          hint : `settings.${key}.hint`,
          ...data
        }
      );
    });
  }
}
