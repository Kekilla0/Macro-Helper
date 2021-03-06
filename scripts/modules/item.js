import { module, logger, dcl } from '../apps/module.js';
import { handler } from '../systems/handler.js';

const NAME = "item";

export class item extends dcl{
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

    }

    module.applySettings(settingsData);
  }

  static patch(){
    const cl = Item;

    
  }
}