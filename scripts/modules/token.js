import { module, logger, dcl } from '../apps/module.js';
import { handler } from '../systems/handler.js';

const NAME = "token";

export class token extends dcl{
  static register(){
    logger.info("token | initializing module.");

    this.settings();
    this.hooks();
    this.patch();
    this.globals();

    /* Overwrite and Execute all Handled System Functions */
    handler.execute(NAME);
  }

  static settings(){
    const config = false;
    const settingsData = {
      /* DISTANCE = MEASURES THE LENGTH BETWEEN THE TOKEN AND A PLACEABLE */
      ["token-distance"] : {
        scope : "world", config, group : NAME, default : true, type : Boolean,
      },
    }

    module.applySettings(settingsData);
  }

  static patch(){
    const cl = Token;

    /* Distance */
    if(module.setting("token-distance"))
      cl.prototype.distance = function(placeable){
        if(!(placeable instanceof PlaceableObject)) return logger.error("Placeable Argument Error");

        let canvas = this.parent.parent.parent;
        let distance = canvas.grid.measureDistance(this, placeable);

        if(this.data?.elevation === placeable.data?.elevation || placeable.data?.elevation == undefined) return distance;

        let height_diff = parent.data.elevation > this.data.elevation ? placeable.data.elevation - this.data.elevation : this.data.elevation - placeable.data.elevation;
        return Math.sqrt(Math.pow(height_diff,2) + Math.pow(height_diff,2));
      }
  }
}