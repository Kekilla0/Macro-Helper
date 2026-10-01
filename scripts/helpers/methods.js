import { logger } from '../log.js';
import { rollItem } from '../roll-item/roll-item.js';
import { distanceBetween, getRange, getTokensWithin, highlightRange, pushAway, pushDestination } from './tokens.js';
import { isEnemy, isAlly, getThreats, isThreatened, getEnemiesWithinRange, pickTargets, getFlanker, isFlanking } from './targets.js';
import { getSize, setStatus, setDefeated, splitToken, damage, heal, tempHP, dropsToZero, isKilledOutright, preventDropToZero, findItem,
  rollSave, addTimedEffect, getSaveAdvantages } from './actors.js';
import { setBaseDamage, updateItem, attackModeFor, isLongRange, isRangedItem, isRangedAttack, canThrow, getAmmunition, pickAndAttack,
  getUses, hasUses, spendUses, useActivity, getMultiattack, getMultiattackPlan, multiattack, getHealing, pickAttack } from './items.js';
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
  isThreatened : call(isThreatened),                                // ({ range, includeIncapacitated, includeHidden }) -> boolean
  getThreats : call(getThreats),                                    // ({ range, includeIncapacitated, includeHidden }) -> Token[]
  setStatus : call(setStatus),                                      // (status, active, { overlay })
  setDefeated : call(setDefeated),                                  // (defeated)
  damage : call(damage),                                            // (value | formula | parts, type, { properties, multiplier, ignore })
  heal : call(heal),                                                // (value | formula)
  tempHP : call(tempHP),                                            // (value | formula, source)
  dropsToZero : call(dropsToZero),                                  // (amount) -> boolean
  isKilledOutright : call(isKilledOutright),                        // (amount) -> boolean, massive damage
  preventDropToZero : call(preventDropToZero),                      // (amount, updates, { hp, massiveDamage }) -> boolean, in dnd5e.preApplyDamage
  findItem : call(findItem),                                        // (name | identifier | id | [several] | fn, { type }) -> Item | null
  getSaveAdvantages : call(getSaveAdvantages),                      // () -> Set of condition keys it has advantage on saves against
  getFlanker : call(getFlanker),                                    // (target) -> the ally flanking it with this creature | null
  isFlanking : call(isFlanking),                                    // (target) -> boolean
  rollSave : call(rollSave),                                        // (ability, dc) -> { success, total, roll } | null
  addTimedEffect : call(addTimedEffect),                            // (effectData, { of, until : "turnStart" | "turnEnd" }) -> ActiveEffect
  getMultiattackPlan : call(getMultiattackPlan),                    // ({ feature }) -> [{ items, count, choice }]
  multiattack : call(multiattack),                                  // ({ repeat, event, attack }) -> the whole Multiattack, one pick per weapon
};

const token = {
  ...creature,
  distanceTo : call(distanceBetween),                               // (other) -> feet
  split : call(splitToken),                                         // ({ copies, hp, scale, stepSize, chat })
  pushAway : call(pushAway),                                        // (from, feet = 10) -> Promise<number> feet moved, straight away, stops at walls
  pushDestination : call(pushDestination),                          // (from, feet = 10) -> { x, y } | null
};

export const METHODS = {
  Actor : creature,
  TokenDocument : token,
  Token : {
    ...token,
    highlightRange : call(highlightRange),                          // (feet, { tokens, selected }) -> { select, clear }
    pickTargets : call(pickTargets),                                // ({ count, range, disposition, numberAllowed, within, confirm }) -> Promise<Token[]>
  },
  Item : {
    getRange : call(getRange),                                      // ({ long, thrown })
    getEnemiesWithinRange : call(getEnemiesWithinRange),            // ({ numberOfEnemies, range, long, thrown })
    pickTargets : call(pickTargets),                                // ({ count, disposition, numberAllowed, within, confirm }) -> Promise<Token[]>, range = the item's
    pickAndAttack : call(pickAndAttack),                            // ({ count, repeat, disposition, within, long, confirm, clearTargets, event }) -> Promise<result | null>
    pickAttack : call(pickAttack),                                  // ({ count, repeat, ... }) -> { attack, targets, attackMode, disadvantage } | null
    getMultiattack : call(getMultiattack),                          // ({ feature, fallback }) -> attacks with this item in the owner's Multiattack
    getMultiattackPlan : call(getMultiattackPlan),                  // on the Multiattack feature : ({ }) -> [{ items, count, choice }]
    multiattack : call(multiattack),                                // on the Multiattack feature : ({ repeat, event, attack })
    getHealing : call(getHealing),                                  // ({ average }) -> "11" | "3d6" | null, from its activity or description
    attackModeFor : call(attackModeFor),                            // (target, { long }) -> "thrown" | null
    isLongRange : call(isLongRange),                                // (target) -> boolean, beyond normal but within long range
    isRangedItem : call(isRangedItem),                              // () -> boolean, ranged weapon / ranged spell attack
    isRangedAttack : call(isRangedAttack),                          // (target) -> boolean, ranged item or thrown at this target
    canThrow : call(canThrow),                                      // () -> boolean
    getAmmunition : call(getAmmunition),                            // () -> the ammunition Item dnd5e would use | null
    setBaseDamage : call(setBaseDamage),                            // ({ number, denomination, types, bonus }) -> fresh item | null
    updateFresh : call(updateItem),                                 // (changes) -> fresh item
    getUses : call(getUses),                                        // () -> { value, max, spent } | null
    hasUses : call(hasUses),                                        // (amount) -> boolean
    spendUses : call(spendUses),                                    // (amount, { warn }) -> fresh item | null
    useActivity : call(useActivity),                                // ({ activity, configure, event }) -> dnd5e usage results | null
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
