import { module, logger, dcl } from '../apps/module.js';
import { handler } from '../systems/handler.js';

const NAME = "compendium";

export class compendium extends dcl{
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
      ["compendium.getItem"] : {
        scope : "world", config, group : NAME, default : true, type : Boolean,
      },
    }

    module.applySettings(settingsData);
  }

  static patch(){
    const cl = CompendiumCollection;

    if(module.setting("compendium.getItem"))
      cl.prototype.getItem = async function(name){
        let _id = (await this.getIndex()).find(e => e.name.toLowerCase() === name.toLowerCase())?._id;

        if(_id)
          return await this.getDocument(_id);
      }
    
  }
}