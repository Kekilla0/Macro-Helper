import { module, logger, dcl } from '../apps/module.js';

export class token extends dcl{

}

export class actor extends dcl{
  static settings(){
    const config = false;
    const settingsData = {
      ["actor.tempHP"] : {
        scope : "world", config, group : this.name, default : true, type : Boolean,
      },
    }

    module.applySettings(settingsData);
  }

  static patch(){
    const cl = Actor;

    if(module.setting("actor.tempHP"))
      cl.prototype.addTempHP = async function(value, override = true){
        const hp = this.toObject().data.attributes.hp;

        if(!override)
          return await this.update({"data.attributes.hp.temp" : Number(hp.temp) + value });
        if(Number(hp.temp) < value)
          return await this.update({"data.attributes.hp.temp" : value});

        return actor;
      }
  }
}

export class item extends dcl{
  static patch(){
    const cl = Item;
  }
}