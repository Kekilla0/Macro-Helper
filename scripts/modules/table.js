import { module, logger, dcl } from '../apps/module.js';
import { handler } from '../systems/handler.js';

const NAME = "table";

export class table extends dcl{
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
      ["table.getResult"] : {
        scope : "world", config, group : this.name, default : true, type : Boolean,
      },
    }

    module.applySettings(settingsData);
  }

  static patch(){
    const cl = RollTable;

    if(module.setting("table.getResult"))
      cl.prototype.getResult = function(){
        return this.getResultsForRoll(new Roll(this.data.formula).evaluate({ async  : false }).total);
      }
  }
}