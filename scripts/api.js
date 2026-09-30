import { module } from './module.js';
import { rollItem } from './roll-item/roll-item.js';
import * as tokens from './helpers/tokens.js';
import * as targets from './helpers/targets.js';
import * as actors from './helpers/actors.js';
import * as items from './helpers/items.js';
import * as utils from './helpers/utils.js';

/* Public functions for macros : MacroHelper.x(...) or game.modules.get("macro-helper").api.x(...) */
export class api{
  static register(){
    const functions = {
      rollItem : (...args)=> rollItem.roll(...args),

      /* Helpers, see scripts/helpers */
      ...tokens,    // tokenOf, actorOf, cells, distanceBetween, getRange, getTokensWithin, highlightRange
      ...targets,   // isEnemy, isAlly, getEnemiesWithinRange, isValidGroup, selectTargets (async), setTargets
      ...actors,    // getSize, stepSize, setStatus, setDefeated, splitToken
      ...items,     // updateItem, setBaseDamage
      ...utils,     // wait, waitFor
    };

    module.data.api = functions;
    globalThis.MacroHelper = functions;
  }
}
