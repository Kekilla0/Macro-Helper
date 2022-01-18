import { module, logger, dcl } from '../apps/module.js';
import { handler } from '../systems/handler.js';

const NAME = "actor";

export class actor extends dcl{
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
      ["actor.toggleEffect"] : {
        scope : "world", config, group : NAME, default : true, type : Boolean,
      },      
      ["actor.hasEffect"] : {
        scope : "world", config, group : NAME, default : true, type : Boolean,
      },
      ["actor.removeEffect"] : {
        scope : "world", config, group : NAME, default : true, type : Boolean,
      },
    }

    module.applySettings(settingsData);
  }

  static patch(){
    const cl = Actor;

    if(module.setting("actor.hasEffect"))
      cl.prototype.hasEffect = function(name){
        return Boolean(this.effects.find(effect => effect.data.label.toLowerCase() === name.toLowerCase()));
      }

    if(module.setting("actor.removeEffect"))
      cl.prototype.removeEffect = async function(name){
        const effect = this.effects.find(effect => effect.data.label.toLowerCase() === name.toLowerCase());
        if(effect) return await effect.delete();
      }

    if(module.setting("actor.toggleEffect"))
      cl.prototype.toggleEffect = async function(name){
        const effect = this.effects.find(effect => effect.data.label.toLowerCase() === name.toLowerCase());
        if(effect) return await effect.update({ disabled : !effect.data.disabled });
      }
  }
}