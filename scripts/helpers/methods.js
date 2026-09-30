import { logger } from '../log.js';
import { rollItem } from '../roll-item/roll-item.js';
import { distanceBetween, getRange, getTokensWithin, highlightRange } from './tokens.js';
import { isEnemy, isAlly, getEnemiesWithinRange } from './targets.js';
import { getSize, setStatus, setDefeated, splitToken } from './actors.js';
import { setBaseDamage, updateItem } from './items.js';
const log = logger.for(import.meta.url);

/**
 * Helpers as methods on the things they act on : token.getCreatureSize() instead of MacroHelper.getSize(token).
 * Each method just calls the MacroHelper function with `this` first, so both ways keep working.
 * A method is never added over one that already exists (core, the system, another module) : it is skipped and logged.
 *
 * Classes : Actor, TokenDocument, Token (the canvas placeable), Item. Resolved from CONFIG, so the system's subclasses get them.
 */
const call = fn => function(...args){ return fn(this, ...args); };

const creature = {
  getCreatureSize : call(getSize),                                  // { key, value, label }, core getSize() is the token's pixel size
  getTokensWithin : call(getTokensWithin),                          // (feet, options)
  isEnemy : call(isEnemy),                                          // (other)
  isAlly : call(isAlly),                                            // (other)
  setStatus : call(setStatus),                                      // (status, active, { overlay })
  setDefeated : call(setDefeated),                                  // (defeated)
};

const token = {
  ...creature,
  distanceTo : call(distanceBetween),                               // (other) -> feet
  split : call(splitToken),                                         // ({ copies, hp, scale, stepSize, chat })
};

export const METHODS = {
  Actor : creature,
  TokenDocument : token,
  Token : {
    ...token,
    highlightRange : call(highlightRange),                          // (feet, { tokens, selected }) -> { select, clear }
  },
  Item : {
    getRange : call(getRange),                                      // ({ long, thrown })
    getEnemiesWithinRange : call(getEnemiesWithinRange),            // ({ numberOfEnemies, range, long, thrown })
    setBaseDamage : call(setBaseDamage),                            // ({ number, denomination, types, bonus }) -> fresh item | null
    updateFresh : call(updateItem),                                 // (changes) -> fresh item
    rollItem : function(options){ return rollItem.roll(this, options); },
  },
};

export class methods{
  static register(){
    const classes = {
      Actor : CONFIG.Actor.documentClass,
      TokenDocument : CONFIG.Token.documentClass,
      Token : CONFIG.Token.objectClass,
      Item : CONFIG.Item.documentClass,
    };

    for(const [className, fns] of Object.entries(METHODS)){
      const proto = classes[className]?.prototype;
      if(!proto) continue;
      for(const [name, fn] of Object.entries(fns)){
        if(name in proto){
          log.info(`${className}.${name} already exists, not adding the Macro Helper version (use MacroHelper instead).`);
          continue;
        }
        Object.defineProperty(proto, name, { value : fn, writable : true, configurable : true, enumerable : false });
      }
    }
    log.debug("Helper methods added", Object.fromEntries(Object.entries(METHODS).map(([c, f]) => [c, Object.keys(f)])));
  }
}
