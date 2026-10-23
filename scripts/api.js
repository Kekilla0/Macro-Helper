import { module } from './module.js';
import { rollItem } from './roll-item/roll-item.js';
import * as tokens from './helpers/tokens.js';
import * as targets from './helpers/targets.js';
import * as actors from './helpers/actors.js';
import * as items from './helpers/items.js';
import * as utils from './helpers/utils.js';
import * as creatures from './helpers/creatures.js';
import { restChoices } from './automation/rest-choices.js';
import { rollModes } from './automation/roll-modes.js';
import { onDamage } from './roll-item/damage.js';
import { onMiss } from './roll-item/miss-damage.js';
import { addRow, removeRow } from './roll-item/card-rows.js';
import { onAttacked } from './roll-item/attacked.js';
import { cardSave } from './roll-item/card-save.js';
import { damageTypeChoice } from './roll-item/damage-type-choice.js';
import { bonusOnlyWhen } from './automation/bonus-only-when.js';
import { cantUseWhile, freeUseWhile, isFreeUse } from './automation/use-rules.js';
import { castingOptions, payCasting } from './automation/casting.js';
import { summon, summonKind } from './automation/summons.js';
import { pickFromCompendium } from './automation/compendiums.js';
import { onTurnStart } from './gm.js';
import { rollRequests } from './requests/requests.js';
import { damageRoll, eachAttack } from './roll-item/extra-damage.js';
import { onHit, hitOf, useOnLatestHit } from './roll-item/hit-bonus.js';
import { onFailedTest } from './roll-item/rerolls.js';
import { markSpell, markOf } from './automation/marks.js';
import { weaponUses } from './automation/weapon-uses.js';
import { conditions } from './automation/conditions.js';
import { cutDamage, cutsOf } from './roll-item/damage-cuts.js';
import { applyCondition, engulf, immunity, isType, isImmuneTo, web, affectedBy, pull, applyConditionNow, giveCondition, endCondition, grapple, escapeDC, isDifficultTerrain, applyDisease, suppressOA, passThrough, applyEffect, attach, attachedTo, trample, followUp, extraDamage, shareDamage, chargedAt, isSmaller, grappling, teleport, leap, useMovement, useReaction, hasReaction, reactionMove, reactionMoveOf, reactionAttack, reactionMoveRows, reactionAttackRows, damageTypes, becameBloodied, push, cardBuilder } from './roll-item/card-builder.js';

/* Public functions for macros : MacroHelper.x(...) or game.modules.get("macro-helper").api.x(...) */
export class api{
  static register(){
    const functions = {
      rollItem : (...args)=> rollItem.roll(...args),
      /* Card builder : the normal use's card to append to, and its parts */
      roll : (item, options) => cardBuilder.roll(item, options),
      applyCondition, engulf, immunity, isType, isImmuneTo, web, affectedBy, pull, applyConditionNow, giveCondition, endCondition, grapple, escapeDC, isDifficultTerrain, applyDisease, suppressOA, passThrough, applyEffect, attach, attachedTo, trample, followUp, extraDamage, shareDamage, chargedAt, isSmaller, grappling, teleport, leap, useMovement, useReaction, hasReaction, reactionMove, reactionMoveOf, reactionAttack, reactionMoveRows, reactionAttackRows, damageTypes, becameBloodied, push,

      /* Extra damage : one roll (typed, doubled on a crit), and each attack on a card with its targets */
      damageRoll, eachAttack,
      /* On-hit bonus buttons (Divine Fury, a maneuver), and a card's damage made lower for a creature (Deflect Attacks) */
      onHit, hitOf, useOnLatestHit, cutDamage, cutsOf,
      /* A die added to a failed D20 Test (Bardic Inspiration), a spell that marks a creature (Hunter's Mark, Hex), the
         ability and die a weapon attacks with (Martial Arts), what an effect ends on (Rage) */
      onFailedTest, markSpell, markOf,
      weaponUses : (id, rule) => weaponUses.add(id, rule),
      endsWhen : (match, rule) => conditions.endsWhen(match, rule),
      /* A choice in the Rest Choices window, advantage / disadvantage on attacks, a change to a roll's own damage */
      addRestChoice : choice => restChoices.add(choice),
      addRollMode : (name, fn) => rollModes.add(name, fn),
      onDamage : (fn, options) => onDamage(fn, options),
      /* Damage on a miss (Graze), a GM button on a creature's card row (Topple), a guard's button when a creature
         near it is attacked (Interception), something at the start of each turn */
      onMiss, addRow, removeRow, onAttacked, onTurnStart,
      /* A bonus only where a check holds (Rage, Dueling, Defense), what can't be used / is free while something holds */
      bonusOnlyWhen, cantUseWhile, freeUseWhile, isFreeUse,
      /* A spell cast outside dnd5e's use : how to pay; a save put on an attack card; a choice of damage types */
      castingOptions, payCasting, cardSave, damageTypeChoice,
      /* A summon activity's creature on the map; one entry chosen from the compendiums */
      summon, summonKind, pickFromCompendium,

      /* Helpers, see scripts/helpers */
      ...tokens,    // tokenOf, actorOf, cells, distanceBetween, getRange, getTokensWithin, highlightRange, forcedMove, pushDestination, pushAway, pullToward, addLight, removeLight, hasLight, registerPool, poolBar, removePoolBar, poolsOf
      ...targets,   // isEnemy, isAlly, alliesNear, excludeTargets, getFlanker, isFlanking, isThreatened, getThreats, getEnemiesWithinRange, pickTargets, isValidGroup, selectTargets, setTargets
      ...actors,    // damage, heal, tempHP, dropsToZero, isKilledOutright, preventDropToZero, findItem, rollSave, addTimedEffect, recoverSpellSlots, slotsLeft, usedThisTurn, markUsedThisTurn, countedUses, effectsFrom, itemEffectOn, itemEffectOff, getLastDamage, clearLastDamage, setStatus, setDefeated, getSize, stepSize, splitToken
      ...items,     // pickAndAttack, pickAttack, attackModeFor, isLongRange, isRangedItem, isRangedAttack, canThrow, getAmmunition,
                  // getUses, hasUses, spendUses, useActivity, useAndApply, getAppliedConditions, multiattack, getHealing, updateItem, setBaseDamage, setDamage, isClassSpell, isUnarmored, conjureItem, linkItems, linkedItems
      ...utils,     // wait, waitFor, originOf, chooseOption
      ...creatures, // crOf, fitsProfile, chooseCreature, chooseCreatures, chooseOne, chooseSet, divideAmong
      /* The character's Rest Choices window (Wild Shape forms...), e.g. after a rest the GM ran for everyone */
      restChoices : actor => restChoices.open(actor),
      /* Roll Requests : the window (no options), or a card straight away ({ who, what, dc, hideDC, mode, whisper }) */
      rollRequest : options => (options ? rollRequests.request(options) : rollRequests.open()),
    };

    module.data.api = functions;
    globalThis.MacroHelper = functions;
  }
}
