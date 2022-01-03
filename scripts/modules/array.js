import { module, logger, dcl } from '../apps/module.js';
import { handler } from '../systems/handler.js';

const NAME = "array";

export class array extends dcl{
  static register(){
    logger.info(`${this.name} | initializing module.`);

    this.settings();
    this.hooks();
    this.patch();
    this.globals();

    /* Overwrite and Execute all Handled System Functions */
    handler.execute(this.name);
  }

  static settings(){
    const config = false;
    const settingsData = {
      ["array.random"] : {
        scope : "world", config, group : NAME, default : true, type : Boolean,
      },
    }

    module.applySettings(settingsData);
  }

  static patch(){
    const cl = Array;

    if(module.setting("array.random"))
      cl.prototype.random = function(display = false){
        const roll = new Roll(`1d${this.length} - 1`).evaluate({async : false});
        
        if(display) roll.toMessage();

        return this[roll.total];
      }
    
  }
}