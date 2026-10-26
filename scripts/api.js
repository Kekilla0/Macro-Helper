import { module } from './module.js';
import { rollItem } from './roll-item/roll-item.js';
import * as tokens from './helpers/tokens.js';
import * as targets from './helpers/targets.js';
import * as actors from './helpers/actors.js';
import * as items from './helpers/items.js';
import * as utils from './helpers/utils.js';
import * as creatures from './helpers/creatures.js';
import { restChoices } from './automation/rest-choices.js';
import { rollModes, rollModeFrom, giveRollMode, saveModeAgainst } from './automation/roll-modes.js';
import { sustain } from './automation/spell-actions.js';
import { castingChoice, castingChoiceOf } from './automation/casting-choice.js';
import { extendDurations } from './automation/durations.js';
import { saveRowToggle, toggledOn } from './roll-item/row-toggles.js';
import { willingSave, willingOn } from './automation/willing.js';
import { changeSize } from './automation/size.js';
import { lendItem, lends } from './automation/lend-item.js';
import { ignoresDisadvantage, ignoresCover, ignoresProperty, ignoresResistance, ignoresTerrain } from './automation/ignores.js';
import { speedAs, standUpCost, dragsFreely } from './automation/movement.js';
import { hitDieBonus } from './automation/hit-dice.js';
import { acDexCap } from './automation/armor.js';
import { extraMasteries } from './automation/weapon-mastery.js';
import { concentrationModeFrom } from './automation/roll-modes.js';
import { onSaveMove } from './roll-item/card-moves.js';
import { dropsComponents } from './automation/components.js';
import { spells } from './automation/spells.js';
import { saveDamage } from './automation/save-damage.js';
import { reducesDamage } from './automation/damage-reduction.js';
import { onHitMove } from './roll-item/card-moves.js';
import { addRange } from './automation/ranges.js';
import { itemChoice, choiceOf, askChoice } from './automation/item-choices.js';
import { zone, zones } from './automation/zones.js';
import { giveAura } from './automation/auras.js';
import { addSpellPool, openSpellPool, spellPools } from './automation/spell-pools.js';
import { rerollButton, rerolled } from './roll-item/reroll-buttons.js';
import { d20Button } from './roll-item/d20-buttons.js';
import { unarmedDamage } from './automation/unarmed.js';
import { initiativeSwap } from './automation/initiative-swap.js';
import { actionTracker } from './automation/action-tracker.js';
import { bonusAttackAfter } from './automation/bonus-attacks.js';
import { reactionAttackOn, opportunityInstead } from './automation/action-ready.js';
import { actions, onDefaultAction, actionAs, actionRollMode } from './automation/actions.js';
import { gm } from './gm.js';
import { emanation } from './automation/emanation.js';
import { transform, revert } from './automation/transform.js';
import { castOnHit } from './roll-item/cast-on-hit.js';
import { onInitiative } from './automation/initiative.js';
import { addSense } from './automation/creature-traits.js';
import { onDamage } from './roll-item/damage.js';
import { onMiss } from './roll-item/miss-damage.js';
import { addRow, removeRow } from './roll-item/card-rows.js';
import { onAttacked, raiseCardAC, raisedCardAC } from './roll-item/attacked.js';
import { cardSave } from './roll-item/card-save.js';
import { damageTypeChoice } from './roll-item/damage-type-choice.js';
import { bonusOnlyWhen } from './automation/bonus-only-when.js';
import { cantUseWhile, freeUseWhile, isFreeUse } from './automation/use-rules.js';
import { castingOptions, payCasting } from './automation/casting.js';
import { summon, summonKind, controllerOf } from './automation/summons.js';
import { actFrom, actFromPlace } from './automation/act-from.js';
import { pickFromCompendium } from './automation/compendiums.js';
import { onTurnStart } from './gm.js';
import { rollRequests } from './requests/requests.js';
import { damageRoll, eachAttack } from './roll-item/extra-damage.js';
import { onHit, hitOf, useOnLatestHit, isAttackAction } from './roll-item/hit-bonus.js';
import { onFailedTest } from './roll-item/rerolls.js';
import { markSpell, markOf } from './automation/marks.js';
import { weaponUses } from './automation/weapon-uses.js';
import { conditions } from './automation/conditions.js';
import { cutDamage, cutsOf } from './roll-item/damage-cuts.js';
import { hitBecomesMiss } from './roll-item/hit-becomes-miss.js';
import { applyCondition, engulf, immunity, isType, isImmuneTo, web, affectedBy, pull, applyConditionNow, giveCondition, endCondition, grapple, escapeDC, isDifficultTerrain, applyDisease, suppressOA, passThrough, applyEffect, attach, attachedTo, trample, followUp, extraDamage, shareDamage, sharesDamage, chargedAt, isSmaller, grappling, teleport, leap, moveUpTo, moveFirst, useMovement, useReaction, hasReaction, reactionMove, reactionMoveOf, reactionAttack, reactionMoveRows, reactionAttackRows, damageTypes, becameBloodied, push, cardBuilder } from './roll-item/card-builder.js';

/* Public functions for macros : MacroHelper.x(...) or game.modules.get("macro-helper").api.x(...) */
export class api{
  static register(){
    const functions = {
      rollItem : (...args)=> rollItem.roll(...args),
      /* Card builder : the normal use's card to append to, and its parts */
      roll : (item, options) => cardBuilder.roll(item, options),
      applyCondition, engulf, immunity, isType, isImmuneTo, web, affectedBy, pull, applyConditionNow, giveCondition, endCondition, grapple, escapeDC, isDifficultTerrain, applyDisease, suppressOA, passThrough, applyEffect, attach, attachedTo, trample, followUp, extraDamage, shareDamage, sharesDamage, hitBecomesMiss, chargedAt, isSmaller, grappling, teleport, leap, moveUpTo, moveFirst, useMovement, useReaction, hasReaction, reactionMove, reactionMoveOf, reactionAttack, reactionMoveRows, reactionAttackRows, damageTypes, becameBloodied, push,

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
      addRollMode : (name, fn, options) => rollModes.add(name, fn, options),
      /* Advantage / disadvantage from an effect, on attacks by its creature or against it (Reckless Attack); one given
         by an addRollMode rule for saves or checks */
      rollModeFrom, giveRollMode, saveModeAgainst, sustain,
      /* A choice made as a spell is cast, paid once it's cast (Metamagic); longer durations (Extended Spell); toggles on
         a save card's rows (Careful, Heightened); a reroll button on a card after the roll (Empowered, Seeking, Savage
         Attacker); a second d20 for a D20 Test already rolled (Lucky) */
      castingChoice, castingChoiceOf, extendDurations, saveRowToggle, toggledOn, rerollButton, rerolled, d20Button,
      /* An Unarmed Strike's own damage die (Tavern Brawler, Unarmed Fighting); a swap of initiative with an ally (Alert) */
      unarmedDamage, initiativeSwap,
      /* A save only an unwilling target makes, the GM saying who's willing (Enlarge/Reduce); a size larger or smaller */
      willingSave, willingOn, changeSize,
      /* A use lent to a creature as an item of its own, with the lender's numbers (Dragon's Breath) */
      lendItem, lends,
      /* Attacks or damage that skip a rule : disadvantage (threatened, long range), cover, a weapon property's limit,
         Resistance (Sharpshooter, Elemental Adept); a longer range or reach (Spell Sniper) */
      ignoresDisadvantage, ignoresCover, ignoresProperty, ignoresResistance, ignoresTerrain, addRange, saveDamage, reducesDamage, onHitMove, raiseCardAC, raisedCardAC, isAttackAction,
      /* An attack as the Bonus Action after something this turn (Light, Martial Arts, Pole Strike, Hew); more moments
         for a Reaction attack (Reactive Strike, Sentinel) and something to do instead of an Opportunity Attack (War
         Caster); two weapons drawn as one (Quick Draw) */
      bonusAttackAfter, reactionAttackOn, opportunityInstead, drawsTwo : (match, options) => actionTracker.drawsTwo(match, options),
      /* A choice made once for an item, kept on it (Elemental Adept's damage type) */
      itemChoice, choiceOf, askChoice,
      /* An area that acts on whoever enters it or starts / ends a turn in it (Cloud of Daggers, Moonbeam); moving one */
      zone, moveZone : (thing, region) => zones.moveArea(thing?.actor ?? thing ?? canvas.tokens?.controlled?.[0]?.actor ?? game.user.character, region),
      /* An area round a creature, going where it goes, giving those inside a condition or effects (a stench) */
      giveAura,
      /* Spells kept in something of the creature's own, with free places, swaps and paid extras (Book of Shadows, a
         Wizard's spellbook) */
      addSpellPool, openSpellPool, spellPoolRoom : (thing, id) => spellPools.room(thing?.actor ?? thing, id),
      /* More or fewer Actions, Bonus Actions, Reactions or attacks this turn (Action Surge) */
      actionTracker : { modify : (thing, kind, n, source) => actionTracker.modify(thing, kind, n, source) },
      onDamage : (fn, options) => onDamage(fn, options),
      /* Damage on a miss (Graze), a GM button on a creature's card row (Topple), a guard's button when a creature
         near it is attacked (Interception), something at the start of each turn */
      onMiss, addRow, removeRow, onAttacked, onTurnStart,
      /* A bonus only where a check holds (Rage, Dueling, Defense), what can't be used / is free while something holds */
      bonusOnlyWhen, cantUseWhile, freeUseWhile, isFreeUse,
      /* A spell cast outside dnd5e's use : how to pay; a save put on an attack card; a choice of damage types */
      castingOptions, payCasting, cardSave, damageTypeChoice,
      /* A summon activity's creature on the map; one entry chosen from the compendiums */
      summon, summonKind, controllerOf, pickFromCompendium,
      /* A use measured from another token's space (Invoke Duplicity's illusion), and the places a use can be made from */
      actFrom, actFromPlace,
      /* Every matching creature round the user, no pick (Turn Undead); another creature's form taken and left (Wild Shape) */
      emanation, transform, revert,
      /* Spells cast onto a weapon hit's card (the smites); a button on the initiative roll; a sense on a creature's tokens */
      castOnHit, onInitiative, addSense,
      /* A Default Action used as part of something else (Cunning Action's Hide); a use that waits for the GM's Allow */
      useDefaultAction : (thing, id, options) => actions.useDefault(thing, id, options),
      /* Something after a Default Action (Charger's Dash); a Default Action as a Bonus Action (Keen Mind's Study) */
      onDefaultAction, actionAs, actionRollMode,
      /* A speed equal to another (Athlete's climb); what standing up costs (Hop Up); dragging a grappled creature
         without the extra cost (Fast Wrestler) */
      speedAs, standUpCost, dragsFreely,
      /* More on a Hit Point Die spent (Chef); a higher Dexterity limit in armor (Medium Armor Master); more weapon
         masteries (Weapon Master); the damage dealer's mode on the Concentration save it causes (Mage Slayer); a push
         or pull on a failed save (Telekinetic Shove, Thunderwave); spells without some components (Improved
         Illusions); a prepared Ritual at its normal time with no slot (Quick Ritual) */
      hitDieBonus, acDexCap, extraMasteries, concentrationModeFrom, onSaveMove, dropsComponents,
      quickRitual : (match, options) => spells.quickRitual(match, options),
      askToUse : (activity, ctx, options) => gm.askToUse(activity, ctx, options),

      /* Helpers, see scripts/helpers */
      ...tokens,    // tokenOf, actorOf, cells, distanceBetween, getRange, getTokensWithin, highlightRange, forcedMove, pushDestination, pushAway, pullToward, addLight, removeLight, hasLight, registerPool, poolBar, removePoolBar, poolsOf
      ...targets,   // isEnemy, isAlly, alliesNear, excludeTargets, getFlanker, isFlanking, isThreatened, getThreats, getEnemiesWithinRange, pickTargets, isValidGroup, selectTargets, setTargets
      ...actors,    // damage, heal, tempHP, spendHitDice, dropsToZero, isKilledOutright, preventDropToZero, findItem, rollSave, addTimedEffect, recoverSpellSlots, payCoins, slotsLeft, spellSlots, addSpellSlot, usedThisTurn, markUsedThisTurn, countedUses, effectsFrom, itemEffectOn, itemEffectOff, giveEffect, getLastDamage, clearLastDamage, setStatus, setDefeated, getSize, stepSize, splitToken
      ...items,     // pickAndAttack, pickAttack, attackModeFor, isLongRange, isRangedItem, isRangedAttack, canThrow, getAmmunition,
                  // getUses, hasUses, spendUses, useActivity, useAndApply, getAppliedConditions, multiattack, untilShown, getHealing, updateItem, setBaseDamage, setDamage, isClassSpell, isUnarmored, conjureItem, linkItems, linkedItems, pickOwned, enchant, replaceItem
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
