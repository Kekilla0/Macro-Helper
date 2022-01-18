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
      ["array.shuffle"] : {
        scope : "world", config, group : NAME, default : true, type : Boolean,
      },
      ["array.shuffleSort"] : {
        scope : "world", config, group : NAME, default : true, type : Boolean,
      },
      ["array.weight"] : {
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
    if(module.setting("array.shuffle"))
      cl.prototype.shuffle = function() {
        var t, r;
        for(let i = this.length; i > 0;){
          r = Math.floor(Math.random() * i); 
          i-=1;
          t = this[i]; 
          this[i] = this[r]; 
          this[r] = t;
        }
        return this;
      }
    if(module.setting("array.shuffleSort"))
      cl.prototype.shuffleSort = function(){
        return this.sort(()=> (0.5 - Math.random()));
      }
    if(module.setting("array.weight"))
      cl.prototype.weight = function(key){
        if(key == undefined) return this;
        return this.reduce((acc, ele)=> {
          for(let i=0; i < ele[key]; i++)
            acc.push(ele);
          return acc;
        }, []);
      }
  }
}