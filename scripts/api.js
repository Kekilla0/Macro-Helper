import { module } from './module.js';
import { rollItem } from './roll-item/roll-item.js';
import * as tokens from './helpers/tokens.js';
import * as targets from './helpers/targets.js';
import * as actors from './helpers/actors.js';
import * as items from './helpers/items.js';
import * as utils from './helpers/utils.js';
import * as creatures from './helpers/creatures.js';
import { restChoices } from './automation/rest-choices.js';
import { rollRequests } from './requests/requests.js';
import { damageRoll, eachAttack } from './roll-item/extra-damage.js';
import { applyCondition, engulf, immunity, isType, isImmuneTo, web, affectedBy, pull, applyConditionNow, giveCondition, grapple, escapeDC, isDifficultTerrain, applyDisease, suppressOA, passThrough, applyEffect, attach, attachedTo, trample, followUp, extraDamage, shareDamage, chargedAt, isSmaller, grappling, teleport, leap, useMovement, useReaction, hasReaction, damageTypes, becameBloodied, push, cardBuilder } from './roll-item/card-builder.js';

/* Public functions for macros : MacroHelper.x(...) or game.modules.get("macro-helper").api.x(...) */
export class api{
  static register(){
    const functions = {
      rollItem : (...args)=> rollItem.roll(...args),
      /* Card builder : the normal use's card to append to, and its parts */
      roll : (item, options) => cardBuilder.roll(item, options),
      applyCondition, engulf, immunity, isType, isImmuneTo, web, affectedBy, pull, applyConditionNow, giveCondition, grapple, escapeDC, isDifficultTerrain, applyDisease, suppressOA, passThrough, applyEffect, attach, attachedTo, trample, followUp, extraDamage, shareDamage, chargedAt, isSmaller, grappling, teleport, leap, useMovement, useReaction, hasReaction, damageTypes, becameBloodied, push,

      /* Extra damage : one roll (typed, doubled on a crit), and each attack on a card with its targets */
      damageRoll, eachAttack,

      /* Helpers, see scripts/helpers */
      ...tokens,    // tokenOf, actorOf, cells, distanceBetween, getRange, getTokensWithin, highlightRange, forcedMove, pushDestination, pushAway, pullToward, addLight, removeLight, hasLight
      ...targets,   // isEnemy, isAlly, getFlanker, isFlanking, isThreatened, getThreats, getEnemiesWithinRange, pickTargets, isValidGroup, selectTargets, setTargets
      ...actors,    // damage, heal, tempHP, dropsToZero, isKilledOutright, preventDropToZero, findItem, rollSave, addTimedEffect, recoverSpellSlots, usedThisTurn, markUsedThisTurn, getLastDamage, clearLastDamage, setStatus, setDefeated, getSize, stepSize, splitToken
      ...items,     // pickAndAttack, pickAttack, attackModeFor, isLongRange, isRangedItem, isRangedAttack, canThrow, getAmmunition,
                  // getUses, hasUses, spendUses, useActivity, useAndApply, getAppliedConditions, multiattack, getHealing, updateItem, setBaseDamage, setDamage
      ...utils,     // wait, waitFor, originOf, chooseOption
      ...creatures, // crOf, fitsProfile, chooseCreature, chooseCreatures, chooseOne, chooseSet
      /* The character's Rest Choices window (Wild Shape forms...), e.g. after a rest the GM ran for everyone */
      restChoices : actor => restChoices.open(actor),
      /* Roll Requests : the window (no options), or a card straight away ({ who, what, dc, hideDC, mode, whisper }) */
      rollRequest : options => (options ? rollRequests.request(options) : rollRequests.open()),
    };

    module.data.api = functions;
    globalThis.MacroHelper = functions;
  }
}
