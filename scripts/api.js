import { module } from './module.js';
import { rollItem } from './roll-item/roll-item.js';

/* Public functions for macros : MacroHelper.x(...) or game.modules.get("macro-helper").api.x(...) */
export class api{
  static register(){
    const functions = {
      rollItem : (...args)=> rollItem.roll(...args),
    };

    module.data.api = functions;
    globalThis.MacroHelper = functions;
  }
}
