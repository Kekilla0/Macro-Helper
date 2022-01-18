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
      ["actor.resource"] : {
        scope : "world", config, group : this.name, default : true, type : Boolean,
      },
      ["actor.applyDamage"] : {
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

    if(module.setting("actor.resource"))
      cl.prototype.consumeResource = async function(name = "", value = 1){
        if(name === "") return this;

        let resources = this.toObject().data.resources;
        let [key, obj] = Object.entries(resources).find(([key, object]) => key === name || object.label === name);

        obj.value = Math.clamped(obj.value - value, 0, obj.max ?? 999999999999);

        resources[key] = obj;

        return await this.update({"data.resources" : resources});
      }

    
    if(module.setting("actor.applyDamage")){
      let original = cl.prototype.applyDamage;
      cl.prototype.applyDamage = async function(amount, type){
        const arrInclude = (obj, val) => [...obj.value, ...obj.custom.split(';')].includes(val);
        if(!type) return await original.call(this, amount);
        if(!amount) return;
      
        let {di, dr, dv} = this.data.data.traits;
      
        let multiplier = 
          arrInclude(di, type) ? null :
          arrInclude(dr, type) ? 0.5 :
          arrInclude(dv, type) ? 2 : 1;
      
        return multiplier !== null ? await original.call(this, amount, multiplier) : this;
      }
    }
  }
}

export class item extends dcl{
  static settings(){
    const config = false;
    const settingsData = {

    };

    module.applySettings(settingsData);
  }
  static patch(){
    const cl = Item;
  }
}