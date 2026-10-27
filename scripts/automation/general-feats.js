import { module } from '../module.js';
import { settings } from '../settings.js';
import { idOf } from '../helpers/utils.js';
import { onDamage } from '../roll-item/damage.js';
import { ignoresDisadvantage, ignoresCover, ignoresProperty, ignoresResistance, ignoresTerrain } from './ignores.js';
import { addRange } from './ranges.js';
import { itemChoice, choiceOf } from './item-choices.js';
import { onHit, isAttackAction } from '../roll-item/hit-bonus.js';
import { addRow } from '../roll-item/card-rows.js';
import { onHitMove } from '../roll-item/card-moves.js';
import { rerollButton } from '../roll-item/reroll-buttons.js';
import { onAttacked, raiseCardAC, raisedCardAC } from '../roll-item/attacked.js';
import { chargedAt, giveCondition } from '../roll-item/card-builder.js';
import { saveDamage } from './save-damage.js';
import { reducesDamage } from './damage-reduction.js';
import { itemFixes } from './item-fixes.js';
import { giveEffect, rollSave, usedThisTurn } from '../helpers/actors.js';
import { hasShieldEquipped, heldItems, wearsArmor } from '../helpers/items.js';
import { forcedMove } from '../helpers/tokens.js';
import { chooseOne } from '../helpers/creatures.js';
import { bonusAttackAfter } from './bonus-attacks.js';
import { actionReady, reactionAttackOn, opportunityInstead } from './action-ready.js';
import { actionTracker } from './action-tracker.js';
import { fightingStyles } from './fighting-styles.js';
import { speedAs, standUpCost, dragsFreely, jumpRule } from './movement.js';
import { onDefaultAction, actionAs } from './actions.js';
import { rollModeFrom } from './roll-modes.js';
import { rollItem } from '../roll-item/roll-item.js';
import { grappling, isSmaller } from '../roll-item/card-builder.js';
import { uses } from '../uses.js';
import { esc } from '../helpers/utils.js';
import { askChoice } from './item-choices.js';
import { restChoices } from './rest-choices.js';
import { spellPools } from './spell-pools.js';
import { spells } from './spells.js';
import { addSense } from './creature-traits.js';
import { actionRollMode } from './actions.js';
import { dropsComponents } from './components.js';
import { onSaveMove } from '../roll-item/card-moves.js';
import { acDexCap } from './armor.js';
import { extraMasteries } from './weapon-mastery.js';
import { concentrationModeFrom } from './roll-modes.js';
import { onFailedTest } from '../roll-item/rerolls.js';
import { pickTargets } from '../helpers/targets.js';
import { tokenOf } from '../helpers/tokens.js';

/**
 * General feats (level 4+, Feats setting), each built from legos the way an Item Macro would be :
 *
 *   Sharpshooter     : its ranged weapon attacks ignore Half and Three-Quarters Cover (thrown ones too); with a Ranged
 *                      weapon, no disadvantage for an enemy within 5 ft or for long range.
 *   Spell Sniper     : its spell attacks ignore Half and Three-Quarters Cover, have no disadvantage for an enemy within
 *                      5 ft, and a spell attack with a range of 10 ft or more reaches 60 ft farther.
 *   Crossbow Expert  : no Loading limit, loading with no free hand, and no disadvantage for an enemy within 5 ft with a
 *                      crossbow; a Light
 *                      crossbow's extra attack adds the ability modifier.
 *   Elemental Adept  : a damage type chosen for each copy of the feat (Acid, Cold, Fire, Lightning, Thunder); its
 *                      spells' damage of that type ignores Resistance, and a 1 on those damage dice counts as a 2.
 *   Poisoner         : its Poison damage ignores Resistance (Brew Poison : the feat's own activities).
 *   Crusher          : once a turn, a hit dealing Bludgeoning damage can push the target 5 ft (one size larger at most;
 *                      the GM's button); a critical hit dealing it : attacks against the target have advantage until the
 *                      start of the attacker's next turn (with the damage).
 *   Piercer          : once a turn, a hit dealing Piercing damage can reroll one damage die (the lowest); a critical hit
 *                      rolls one more Piercing die.
 *   Slasher          : once a turn, a hit dealing Slashing damage can cut the target's Speed by 10 ft until the start of
 *                      the attacker's next turn (the GM's button); a critical hit dealing it : the target has disadvantage
 *                      on attack rolls until then (with the damage).
 *   Great Weapon Master : a Heavy weapon's hit as part of the Attack action on its turn deals + Proficiency Bonus
 *                      (added to its damage).
 *   Shield Master    : Shield Bash : once a turn, a melee weapon hit on a creature within 5 ft (Attack action, shield
 *                      equipped) : a button, its STR save (DC 8 + STR + PB); failed : pushed 5 ft or Prone, the
 *                      attacker's choice. Interpose Shield : a successful DEX save for half (holding a shield) : the
 *                      row's button spends the Reaction, no damage.
 *   Charger          : Charge Attack : once a turn, a melee hit (Attack action) after 10 ft or more straight toward the
 *                      target : 1d8 more damage (a button) or a 10 ft push (one size larger at most; the GM's button).
 *   Defensive Duelist : Parry : hit by a melee attack while holding a Finesse weapon : the button (a Reaction) adds the
 *                      Proficiency Bonus to its AC against melee attacks until the start of its next turn, this attack
 *                      judged again.
 *   Heavy Armor Master : in Heavy armor, an attack's Bludgeoning, Piercing and Slashing damage to it is reduced by its
 *                      Proficiency Bonus (Plutonium's always-on effect is switched off).
 *   Great Weapon Master's Hew : a critical hit with a Melee weapon, or bringing a creature to 0 HP with one, on its turn :
 *                      one attack with that weapon as its Bonus Action (the bonus attack lego).
 *   Polearm Master   : Pole Strike : after attacking with a Quarterstaff, a Spear or a Heavy Reach weapon on the Attack
 *                      action, the same weapon's attack as the Bonus Action deals a d4 Bludgeoning. Reactive Strike :
 *                      a creature entering that weapon's reach (its own move) is stopped there : a Reaction attack
 *                      with it (Disengage doesn't stop it). Plutonium's two by-hand activities are hidden.
 *   Sentinel         : Guardian : a creature within 5 ft takes the Disengage action, or hits someone else with an
 *                      attack : an Opportunity Attack card. Halt : an Opportunity Attack that hits : its Speed is 0 for
 *                      the rest of the turn (with the damage; a stopped move doesn't go on).
 *   War Caster       : leaving its reach (an Opportunity Attack) : Cast a Spell instead, a Reaction : a spell of one
 *                      Action at that creature only. Concentration's advantage is Plutonium's effect; Somatic with
 *                      full hands is in components.js.
 *   Dual Wielder     : after attacking with a Light weapon on the Attack action, one attack as the Bonus Action with a
 *                      different Melee weapon without Two-Handed (no positive modifier to its damage, unless Two-Weapon
 *                      Fighting); Quick Draw : two weapons without Two-Handed go in hand for the price of one.
 *   Speedy           : Speed + 10 (Plutonium's effect); having taken the Dash action, Difficult Terrain costs no extra
 *                      movement for the rest of the turn; Opportunity Attacks against it have disadvantage.
 *   Athlete          : a Climb Speed equal to its Speed; standing up from Prone costs 5 ft of movement; a running
 *                      jump after only 5 ft of run-up (jumpRule).
 *   Grappler         : Punch and Grab : once a turn, an Unarmed Strike's hit (Damage, the Attack action) : a button
 *                      for its Grapple too, at that creature; advantage on attacks against a creature it grapples;
 *                      Fast Wrestler : dragging a creature its size or smaller costs no extra movement.
 *   Keen Mind        : the Study action may be its Bonus Action. Observant : the Search action may be.
 *   Charger          : Improved Dash : its Dash gives 10 ft more movement (the Action Tracker's count).
 *   Chef             : Replenishing Meal : up to 4 + PB creatures eat (picked; others' through the GM's button) : the
 *                      first Hit Point Die each spends before its next rest ends heals 1d8 more. Bolstering Treats :
 *                      Plutonium's activities.
 *   Inspiring Leader : Bolstering Performance : after a Short or Long Rest (Rest Choices), up to six allies within 30 ft
 *                      (itself too) gain Temporary Hit Points : its level + the modifier of the ability it chose (WIS or
 *                      CHA, asked once).
 *   Mage Slayer      : its damage to a Concentrating creature : that Concentration save has disadvantage. Guarded Mind :
 *                      a failed INT, WIS or CHA save : a button to succeed instead (once a Short Rest; Plutonium's
 *                      activity hidden).
 *   Ritual Caster    : PB level 1 Ritual spells, always prepared, cast with any slot (Rest Choices : one more as the
 *                      Proficiency Bonus grows); their ability is the one it chose. Quick Ritual : one of its prepared
 *                      Rituals at its normal time with no slot, once a Long Rest (the ritual choice; Plutonium's
 *                      activity hidden).
 *   Skulker          : Blindsight 10 ft; advantage on the Hide action's Stealth check in combat (Plutonium's always-on
 *                      Stealth advantage is switched off). Sniper : nothing to do, a Hide only ends by the GM's hand.
 *   Telekinetic      : its Mage Hand : no V or S, 30 ft more range (the hand may go that much farther). Telekinetic
 *                      Shove : a failed STR save : the GM's buttons push it 5 ft away or pull it 5 ft closer.
 *   Medium Armor Master : in Medium armor with DEX 16 or more, AC adds up to 3 of its DEX modifier (Plutonium's
 *                      effect, a wrong key, is switched off).
 *   Weapon Master    : one more weapon mastery, of a kind it's proficient with (Weapon Mastery's Rest Choices; one swap
 *                      a Long Rest).
 *   Poisoner         : Apply Poison spends a dose; the poison ends once the weapon deals damage (or after 1 minute);
 *                      its save's failure : Poisoned until the end of the poisoner's next turn.
 *   Durable          : Plutonium's data (advantage on Death Saving Throws; Speedy Recovery).
 */
export class generalFeats{
  static SHARPSHOOTER = "sharpshooter";
  static SPELL_SNIPER = "spell-sniper";
  static CROSSBOW_EXPERT = "crossbow-expert";
  static ELEMENTAL_ADEPT = "elemental-adept";
  static POISONER = "poisoner";
  static ELEMENTS = ["acid", "cold", "fire", "lightning", "thunder"];
  static CRUSHER = "crusher";
  static PIERCER = "piercer";
  static SLASHER = "slasher";
  static GWM = "great-weapon-master";
  static SHIELD_MASTER = "shield-master";
  static CHARGER = "charger";
  static DUELIST = "defensive-duelist";
  static HAM = "heavy-armor-master";
  static BPS = ["bludgeoning", "piercing", "slashing"];
  static POLEARM = "polearm-master";
  static SENTINEL = "sentinel";
  static WAR_CASTER = "war-caster";
  static DUAL_WIELDER = "dual-wielder";
  static SPEEDY = "speedy";
  static ATHLETE = "athlete";
  static GRAPPLER = "grappler";
  static KEEN_MIND = "keen-mind";
  static OBSERVANT = "observant";
  static CHEF = "chef";
  static INSPIRING = "inspiring-leader";
  static MAGE_SLAYER = "mage-slayer";
  static RITUAL = "ritual-caster";
  static SKULKER = "skulker";
  static TELEKINETIC = "telekinetic";
  static MAM = "medium-armor-master";
  static WEAPON_MASTER = "weapon-master";
  static MENTAL = ["int", "wis", "cha"];

  /* Polearm Master's weapons : a Quarterstaff, a Spear, or one with Heavy and Reach */
  static polearm(item){
    if(item?.type !== "weapon") return false;
    const base = String(item.system?.type?.baseItem || idOf(item) || "").toLowerCase();
    const props = item.system?.properties;
    return ["quarterstaff", "spear"].includes(base) || (!!props?.has?.("hvy") && !!props?.has?.("rch"));
  }

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("featRules");
  }

  /* A Ranged weapon (bow, crossbow, Dart, Sling), not a thrown melee weapon */
  static rangedWeapon(item){
    return (item?.type === "weapon") && String(item.system?.type?.value ?? "").endsWith("R");
  }

  /* A ranged attack with a weapon : a Ranged weapon, or a weapon thrown (the card's attack mode) */
  static rangedWeaponAttack(item, message = null){
    if(this.rangedWeapon(item)) return true;
    if(item?.type !== "weapon") return false;
    return !!message?.rolls?.some?.(r => String(r.options?.attackMode ?? "").startsWith("thrown"));
  }

  static crossbow(item){
    if(item?.type !== "weapon") return false;
    return /crossbow/.test(String(item.system?.type?.baseItem || idOf(item) || item.name || "").toLowerCase().replace(/[^a-z]/g, ""));
  }

  /* A spell attack : a spell whose activity (or first activity) is an attack */
  static spellAttack(item, activity = null){
    if(item?.type !== "spell") return false;
    return (activity ?? item.system?.activities?.find?.(a => a.type === "attack"))?.type === "attack";
  }

  static has(actor, id){
    return actor?.items?.find?.(i => idOf(i) === id) ?? null;
  }

  static meleeWeapon(item){
    return (item?.type === "weapon") && String(item.system?.type?.value ?? "").endsWith("M");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    const enabled = () => this.enabled();
    this.registerHitRiders(enabled);
    this.registerExtraAttacks(enabled);
    this.registerMovement(enabled);
    this.registerOthers(enabled);

    /* Sharpshooter */
    ignoresCover(this.SHARPSHOOTER, { enabled, when : ({ item, message }) => this.rangedWeaponAttack(item, message) });
    ignoresDisadvantage(this.SHARPSHOOTER, ["threatened", "longRange"], { enabled, when : ({ item }) => this.rangedWeapon(item) });

    /* Spell Sniper */
    ignoresCover(this.SPELL_SNIPER, { enabled, when : ({ item, activity }) => this.spellAttack(item, activity) });
    ignoresDisadvantage(this.SPELL_SNIPER, "threatened", { enabled, when : ({ item, activity }) => this.spellAttack(item, activity) });
    addRange(this.SPELL_SNIPER, 60, { enabled, when : ({ item }) => this.spellAttack(item)
      && ((item.system.range?.units ?? "ft") === "ft") && (Number(item.system.range?.value) >= 10) });

    /* Crossbow Expert */
    ignoresProperty(this.CROSSBOW_EXPERT, ["lod", "amm"], { enabled, when : ({ item }) => this.crossbow(item) });
    ignoresDisadvantage(this.CROSSBOW_EXPERT, "threatened", { enabled, when : ({ item }) => this.crossbow(item) });

    /* Elemental Adept : the type, then the spells' damage */
    itemChoice(this.ELEMENTAL_ADEPT, { id : "damageType", label : module.i18n("feats.elementalAdept.title"), unique : true, enabled,
      prompt : module.i18n("feats.elementalAdept.prompt"),
      options : () => this.ELEMENTS.map(t => ({ value : t, label : CONFIG.DND5E.damageTypes[t]?.label ?? t })) });
    ignoresResistance(this.ELEMENTAL_ADEPT, feat => [choiceOf(feat, "damageType")], { enabled, when : ({ item }) => item?.type === "spell" });

    /* Poisoner */
    ignoresResistance(this.POISONER, ["poison"], { enabled });

    onDamage((attack, damage) => {
      if(!this.enabled() || !attack.actor) return;
      /* Crossbow Expert : the modifier on a Light crossbow's extra attack */
      if(attack.offHand && this.crossbow(attack.item) && attack.properties.has?.("lgt") && (damage.modifier > 0) && !damage.has("@mod")
        && attack.actor.items.some(i => idOf(i) === this.CROSSBOW_EXPERT)) damage.add("@mod");
      /* Piercer : one more Piercing die on a critical hit */
      if(attack.critical && attack.isAttack && this.has(attack.actor, this.PIERCER)) damage.critDice(1, { types : ["piercing"] });
      /* Great Weapon Master : + PB on a Heavy weapon's hit, as part of the Attack action on its turn */
      if(attack.weapon && attack.properties.has?.("hvy") && this.has(attack.actor, this.GWM) && isAttackAction(attack.actor, attack.activity)
        && !damage.has("@prof")) damage.add("@prof");
      /* Elemental Adept : 1s count as 2s on its type's dice */
      if(attack.spell){
        const types = attack.actor.items.filter(i => idOf(i) === this.ELEMENTAL_ADEPT).map(i => choiceOf(i, "damageType")).filter(Boolean);
        if(types.length) damage.minDie(2, { types });
      }
    });
  }

  /* ---------- Hit riders (Crusher, Piercer, Slasher, Shield Master, Charger, Defensive Duelist, Heavy Armor Master) ---------- */

  /* Until the start of the attacker's next turn, on the creature hit (the GM's button when it isn't the user's own) */
  static async untilMyTurn(row, name, data){
    return giveEffect(row.target, { name, ...data }, { from : row.feature, until : "turnStart", of : row.actor });
  }

  static registerHitRiders(enabled){
    const deals = type => row => !!row.damageTypes?.has?.(type);
    const named = row => row.feature?.name ?? "";

    /* Crusher */
    onHitMove({ id : this.CRUSHER, feature : this.CRUSHER, feet : 5, once : "turn", larger : 1, enabled, when : deals("bludgeoning") });
    addRow({ id : "crusher-critical", feature : this.CRUSHER, enabled, withDamage : true, icon : "fa-hammer",
      when : row => row.critical && deals("bludgeoning")(row),
      label : row => module.format("feats.crusher.critical", { name : named(row) }),
      run : row => this.untilMyTurn(row, module.format("feats.crusher.exposed", { name : named(row) }),
        { flags : { [module.id] : { rule : { attackersMode : "advantage" } } } }) });

    /* Piercer : the reroll (its critical die is in the damage rule) */
    rerollButton({ id : this.PIERCER, feature : this.PIERCER, roll : "damage", once : "turn", enabled, icon : "fa-crosshairs",
      when : card => !!card.system?.isHitOn?.(null) && (card.system.damageRolls ?? []).some(r => r.options?.type === "piercing"),
      label : (actor, feature) => module.format("feats.piercer.reroll", { name : feature.name }) });

    /* Slasher */
    addRow({ id : "slasher-hamstring", feature : this.SLASHER, enabled, once : "turn", icon : "fa-person-walking",
      when : deals("slashing"),
      label : row => module.format("feats.slasher.hamstring", { name : named(row) }),
      run : row => this.untilMyTurn(row, module.format("feats.slasher.hamstrung", { name : named(row) }),
        { system : { changes : Object.keys(CONFIG.DND5E.movementTypes ?? { walk : {} })
          .filter(type => Number(row.target.actor?.system?.attributes?.movement?.[type]) > 0)
          .map(type => ({ key : `system.attributes.movement.${type}`, type : "add", value : "-10" })) } }) });
    addRow({ id : "slasher-critical", feature : this.SLASHER, enabled, withDamage : true, icon : "fa-droplet",
      when : row => row.critical && deals("slashing")(row),
      label : row => module.format("feats.slasher.critical", { name : named(row) }),
      run : row => this.untilMyTurn(row, module.format("feats.slasher.wounded", { name : named(row) }),
        { flags : { [module.id] : { rule : { attacksMode : "disadvantage" } } } }) });

    /* Shield Master */
    onHit({ id : "shield-bash", feature : this.SHIELD_MASTER, enabled, once : "turn", attackAction : true, within : 5, icon : "fa-shield",
      when : hit => this.meleeWeapon(hit.item) && hasShieldEquipped(hit.actor),
      label : hit => module.format("feats.shieldMaster.bash", { name : hit.feature?.name ?? "" }),
      after : hit => this.shieldBash(hit) });
    saveDamage(this.SHIELD_MASTER, { abilities : ["dex"], success : 0, reaction : true, enabled, icon : "fa-shield",
      label : () => module.i18n("feats.shieldMaster.interpose"),
      unmet : actor => hasShieldEquipped(actor) ? "" : module.format("feats.shieldMaster.noShield", { name : actor.name }) });

    /* Charger : the 1d8 or the push, once a turn between them */
    const charged = hit => hit.melee && !!hit.target && chargedAt(hit.token, hit.target, 10, { reach : Number(hit.item?.system?.range?.reach) || null });
    onHit({ id : this.CHARGER, feature : this.CHARGER, enabled, once : "turn", attackAction : true, formula : () => "1d8", icon : "fa-person-running",
      when : hit => charged(hit) && !usedThisTurn(hit.actor, `move-${this.CHARGER}`) });
    onHitMove({ id : this.CHARGER, feature : this.CHARGER, feet : 10, once : "turn", larger : 1, enabled,
      when : row => row.attackAction && charged(row) && !usedThisTurn(row.actor, `hit-${this.CHARGER}`) });

    /* Defensive Duelist */
    onAttacked({ id : this.DUELIST, feature : this.DUELIST, when : "hit", self : true, sees : false, icon : "fa-shield-halved", enabled,
      label : ctx => this.has(ctx.guard.actor, this.DUELIST)?.name ?? "Parry",
      tooltip : ctx => module.format("feats.duelist.tip", { name : ctx.guard.name, n : ctx.guard.actor.system.attributes?.prof ?? 2 }),
      done : ctx => !!ctx.roll?.isCritical || !this.meleeAttack(ctx.message) || raisedCardAC(ctx.message, ctx.target, this.DUELIST),
      unmet : guard => heldItems(guard).some(i => (i.type === "weapon") && i.system.properties?.has?.("fin")) ? "" : module.format("feats.duelist.noFinesse", { name : guard.name }),
      run : ctx => this.parry(ctx) });

    /* Heavy Armor Master */
    reducesDamage(this.HAM, { types : this.BPS, attacks : true, enabled, amount : (source, actor) => Number(actor.system.attributes?.prof) || 0,
      when : actor => wearsArmor(actor, "heavy") });
    itemFixes.add({ name : "Heavy Armor Master's always-on reduction", where : "owned", plan : item => this.hamFix(item) });
    itemFixes.add({ name : "Hit rider feats' activities hidden", where : "owned", plan : item => this.riderActivitiesFix(item) });
  }

  /* ---------- Extra attacks (Hew, Polearm Master, Sentinel, War Caster, Dual Wielder) ---------- */

  static registerExtraAttacks(enabled){
    /* Great Weapon Master : Hew */
    bonusAttackAfter(this.GWM, { id : "hew", after : ["critical", "drop"], enabled, label : () => module.i18n("feats.gwm.hew"),
      trigger : hit => this.meleeWeapon(hit.item) });

    /* Polearm Master */
    bonusAttackAfter(this.POLEARM, { id : "pole-strike", after : "attackAction", enabled, label : () => module.i18n("feats.polearm.poleStrike"),
      when : ({ item, attacked }) => this.polearm(item) && attacked.includes(item.id),
      damage : (attack, damage) => damage.setDie(4, { type : "bludgeoning" }) });
    reactionAttackOn(this.POLEARM, { id : "reactive-strike", on : "enters", weapon : item => this.polearm(item), opportunity : false, enabled,
      label : () => module.i18n("feats.polearm.reactiveStrike") });

    /* Sentinel : Guardian, then Halt */
    reactionAttackOn(this.SENTINEL, { id : "sentinel-disengage", on : "disengages", within : 5, enabled });
    reactionAttackOn(this.SENTINEL, { id : "sentinel-hit", on : "hitsOther", within : 5, enabled });
    addRow({ id : "sentinel-halt", feature : this.SENTINEL, enabled, withDamage : true, icon : "fa-hand",
      when : row => row.opportunity,
      label : row => module.format("feats.sentinel.halt", { name : row.feature?.name ?? "" }),
      run : row => giveEffect(row.target, { name : module.format("feats.sentinel.halted", { name : row.feature?.name ?? "" }),
        system : { changes : Object.keys(CONFIG.DND5E.movementTypes ?? { walk : {} }).filter(type => type !== "jump").map(type => ({ key : `system.attributes.movement.${type}`, type : "override", value : "0" })) } },
        { from : row.feature, until : "turnEnd", of : game.combat?.started ? (game.combat.combatant?.actor ?? row.target.actor) : row.target.actor }) });

    /* War Caster : a spell instead of the Opportunity Attack */
    opportunityInstead(this.WAR_CASTER, { id : this.WAR_CASTER, enabled, icon : "fa-wand-sparkles",
      label : () => module.i18n("feats.warCaster.cast"),
      choices : actor => this.reactiveSpells(actor),
      run : async (token, mover, value) => {
        const [itemId, activityId] = String(value).split(".");
        const activity = token.actor?.items.get(itemId)?.system.activities?.get(activityId);
        if(!activity) return null;
        canvas.tokens.setTargets([mover.id]);
        return activity.use({ [module.id] : { economy : "reaction", oa : true, opportunity : false, skipPick : true, useTargets : true } });
      } });

    /* Dual Wielder */
    bonusAttackAfter(this.DUAL_WIELDER, { id : this.DUAL_WIELDER, after : "attackAction", enabled,
      when : ({ item, light }) => this.meleeWeapon(item) && !item.system.properties?.has?.("two") && light.some(id => id !== item.id),
      damage : (attack, damage) => { if(!fightingStyles.styleOf(attack.actor, "two-weapon-fighting")) damage.noModifier(); } });
    actionTracker.drawsTwo(this.DUAL_WIELDER, { enabled, when : item => !item.system?.properties?.has?.("two") });
  }

  /* ---------- Movement and actions (Speedy, Athlete, Grappler, Keen Mind, Observant, Charger's Dash) ---------- */

  static registerMovement(enabled){
    /* Speedy */
    ignoresTerrain(this.SPEEDY, { enabled, when : ({ actor }) => !!actor.effects?.some?.(e => !e.disabled && e.getFlag(module.id, "dash")) });
    rollModeFrom(this.SPEEDY, { id : "speedy-agile", trait : true, enabled,
      against : { mode : "disadvantage", when : attack => !!(attack.tags?.opportunity || rollItem.usedTags(attack.activity).opportunity),
        reason : () => module.i18n("feats.speedy.agile") } });

    /* Athlete */
    speedAs(this.ATHLETE, { speed : "climb", as : "walk", enabled });
    standUpCost(this.ATHLETE, 5, { enabled });
    jumpRule(this.ATHLETE, { runUp : 5, enabled });

    /* Grappler */
    onHit({ id : "punch-and-grab", feature : this.GRAPPLER, enabled, once : "turn", attackAction : true, icon : "fa-hand-back-fist",
      when : hit => hit.unarmed && !!hit.target && !!this.grappleOf(hit.item) && !grappling(hit.actor).some(t => (t.document ?? t) === (hit.target.document ?? hit.target)),
      label : hit => module.format("feats.grappler.grab", { name : hit.feature?.name ?? "" }),
      after : hit => this.punchAndGrab(hit) });
    rollModeFrom(this.GRAPPLER, { id : "grappler-advantage", trait : true, enabled,
      by : { mode : "advantage", when : (attack, target) => !!target && grappling(attack.actor).some(t => (t.document ?? t) === (target.document ?? target)),
        reason : () => module.i18n("feats.grappler.advantage") } });
    dragsFreely(this.GRAPPLER, { enabled, when : (grappler, held) => isSmaller(held, grappler.system?.traits?.size ?? "med") });

    /* Keen Mind, Observant */
    actionAs(this.KEEN_MIND, { action : "study", enabled });
    actionAs(this.OBSERVANT, { action : "search", enabled });

    /* Charger : Improved Dash */
    onDefaultAction(this.CHARGER, { action : "dash", enabled, run : actor => actionTracker.useMovement(actor, 10) });
  }

  /* ---------- The others (Chef, Inspiring Leader, Mage Slayer, Ritual Caster, Skulker, Telekinetic, Medium Armor
     Master, Weapon Master, Poisoner) ---------- */

  /* The ability a feat raised, as a choice kept on it (asked once) */
  static abilityChoice(id, abilities){
    itemChoice(id, { id : "ability", label : module.i18n("feats.ability.title"), enabled : () => this.enabled(),
      prompt : module.i18n("feats.ability.prompt"),
      options : () => abilities.map(a => ({ value : a, label : CONFIG.DND5E.abilities[a]?.label ?? a })) });
  }

  static registerOthers(enabled){
    /* Chef : Replenishing Meal gives its eaters the effect */
    uses.onActivity("featUse", (activity, ctx, next) => this.featUseStep(activity, ctx, next));

    /* Inspiring Leader : Bolstering Performance after a rest */
    this.abilityChoice(this.INSPIRING, ["wis", "cha"]);
    restChoices.add({ id : "bolsteringPerformance", label : "restChoices.bolsteringPerformance", rest : "short",
      applies : actor => enabled() && !!this.has(actor, this.INSPIRING),
      summary : () => module.i18n("feats.inspiring.summary"),
      open : actor => this.perform(actor) });

    /* Mage Slayer */
    concentrationModeFrom(this.MAGE_SLAYER, { mode : "disadvantage", enabled });
    onFailedTest({ id : "guardedMind", tests : ["save"], succeed : true, icon : "fa-brain",
      when : ({ ability }) => this.MENTAL.includes(ability),
      source : actor => { const feat = enabled() && this.has(actor, this.MAGE_SLAYER); return (feat && (Number(feat.system.uses?.value) > 0)) ? feat : null; },
      cost : (actor, feat) => feat ?? this.has(actor, this.MAGE_SLAYER),
      label : feat => module.format("feats.mageSlayer.guarded", { name : feat.name }) });

    /* Ritual Caster : its Ritual spells (a spell pool), Quick Ritual */
    this.abilityChoice(this.RITUAL, this.MENTAL);
    spellPools.add(this.RITUAL, {
      title : actor => this.has(actor, this.RITUAL)?.name ?? module.i18n("feats.ritualCaster.title"),
      places : actor => [{ key : "rituals", count : Number(actor.system.attributes?.prof) || 2, prompt : "feats.ritualCaster.pick",
        filter : e => (Number(e.system?.level) === 1) && spellPools.hasProperty(e, "ritual") }],
      members : actor => actor.items.filter(i => (i.type === "spell") && (i.getFlag(module.id, "pool")?.id === this.RITUAL)),
      data : actor => ({ "system.method" : "spell", "system.prepared" : 2, "system.ability" : choiceOf(this.has(actor, this.RITUAL), "ability") ?? "" }),
      full : actor => module.format("feats.ritualCaster.full", { name : actor.name }),
    });
    restChoices.add({ id : "ritualCaster", label : "restChoices.ritualCaster", rest : "level", classes : "any",
      applies : actor => enabled() && !!this.has(actor, this.RITUAL),
      summary : actor => spellPools.countText(actor, this.RITUAL),
      open : actor => spellPools.open(actor, this.RITUAL) });
    spells.quickRitual(this.RITUAL, { enabled, label : feat => module.format("feats.ritualCaster.quick", { name : feat.name }) });

    /* Skulker */
    addSense(this.SKULKER, { feature : this.SKULKER, mode : "blindsight", range : 10, enabled });
    actionRollMode(this.SKULKER, { action : "hide", mode : "advantage", enabled,
      when : ({ actor }) => !!game.combat?.started && game.combat.combatants.some(c => c.actor === actor) });

    /* Telekinetic */
    const mageHand = ({ item }) => idOf(item) === "mage-hand";
    addRange(this.TELEKINETIC, 30, { enabled, when : mageHand });
    dropsComponents(this.TELEKINETIC, ["v", "s"], { enabled, when : mageHand });
    onSaveMove({ id : this.TELEKINETIC, item : this.TELEKINETIC, feet : 5, direction : ["away", "toward"], enabled });

    /* Medium Armor Master */
    acDexCap(this.MAM, { cap : 3, armor : "medium", enabled, when : ({ actor }) => (Number(actor.system.abilities?.dex?.value) || 0) >= 16 });

    /* Weapon Master */
    extraMasteries(this.WEAPON_MASTER, { count : 1, pool : "proficient", enabled });

    itemFixes.add({ name : "Feats' wrong always-on effects", where : "owned", plan : item => this.wrongEffectsFix(item) });
    itemFixes.add({ name : "Poisoner's doses and poison", where : "owned", plan : item => this.poisonerFix(item) });
  }

  /* A feat's activity that does something else (Chef's Replenishing Meal : its eaters get the effect, no healing roll) */
  static async featUseStep(activity, ctx, next){
    if(!this.enabled() || (idOf(activity?.item) !== this.CHEF) || (activity.type !== "heal") || !/replenish/i.test(activity.name ?? "")) return next();
    const actor = activity.actor;
    const count = 4 + (Number(actor.system.attributes?.prof) || 2);
    const token = tokenOf(actor);
    const eaters = token ? await pickTargets(token, { count, disposition : "any", includeSelf : true, confirm : "enter", sight : false,
      notice : module.format("feats.chef.pick", { n : count }) }) : [];
    if(!eaters?.length) return null;
    for(const eater of eaters){
      await giveEffect(eater, { name : activity.name, img : activity.img ?? activity.item.img, duration : { expiry : "shortRest" },
        flags : { [module.id] : { rule : { hitDieBonus : "1d8", hitDieBonusOnce : true } } } }, { from : activity.item });
    }
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p>${esc(module.format("feats.chef.cooked", { name : actor.name, meal : activity.name, eaters : eaters.map(t => t.name).join(", ") }))}</p>` });
    return null;
  }

  /* Bolstering Performance : up to six allies within 30 ft (itself too), the chosen ability's Temporary Hit Points */
  static async perform(actor){
    const feat = this.has(actor, this.INSPIRING);
    if(!feat) return;
    if(!choiceOf(feat, "ability")) await askChoice(feat, "ability");
    const ability = choiceOf(feat, "ability");
    const activities = [...feat.system.activities].filter(a => a.type === "heal");
    const activity = activities.find(a => String(a.healing?.bonus ?? "").includes(`abilities.${ability}.`)) ?? activities[0];
    const token = tokenOf(actor);
    if(!activity || !token) return;
    const picked = await pickTargets(token, { count : 6, range : 30, disposition : "ally", includeSelf : true, confirm : "enter",
      notice : module.i18n("feats.inspiring.pick") });
    if(!picked?.length) return;
    return activity.use({ [module.id] : { skipPick : true, useTargets : true } });
  }

  /* Plutonium's always-on effects that the rules here replace, or with a wrong key : off (Skulker's Stealth advantage,
     Medium Armor Master's "system.attributes.bonus") */
  static WRONG_EFFECTS = { "skulker" : "system.skills.ste.roll.mode", "medium-armor-master" : "system.attributes.bonus" };
  static wrongEffectsFix(item){
    const key = this.enabled() && this.WRONG_EFFECTS[idOf(item)];
    if(!key) return null;
    const effects = [...(item.effects ?? [])].filter(e => !e.disabled && [...(e.system?.changes ?? e.changes ?? [])].some(c => c.key === key));
    return effects.length ? { updateEffects : effects.map(e => ({ _id : e.id, disabled : true })) } : null;
  }

  /* Poisoner : Apply Poison spends a dose; the poison ends with the weapon's damage; its saves' failure : Poisoned */
  static POISONED_ID = "mhPoisonerPoison";
  static poisonerFix(item){
    if(!this.enabled() || (idOf(item) !== this.POISONER)) return null;
    const source = item._source?.system?.activities ?? {};
    const update = {};
    for(const a of Object.values(source)){
      if((a.type === "enchant") && !(a.consumption?.targets ?? []).some(t => t.type === "itemUses"))
        update[`system.activities.${a._id}.consumption.targets`] = [...(a.consumption?.targets ?? []), { type : "itemUses", value : "1" }];
      if((a.type === "save") && !(a.effects ?? []).some(e => e._id === this.POISONED_ID))
        update[`system.activities.${a._id}.effects`] = [...(a.effects ?? []), { _id : this.POISONED_ID }];
    }
    const updateEffects = [...(item.effects ?? [])].filter(e => (e.type === "enchantment") && !e.getFlag(module.id, "rule")?.endsOnDamage)
      .map(e => ({ _id : e.id, [`flags.${module.id}.rule.endsOnDamage`] : true }));
    /* Poisoned until the end of the poisoner's next turn (the card's until) */
    const made = item.effects.get(this.POISONED_ID);
    if(made && (made.getFlag(module.id, "until") !== "turnEnd")) updateEffects.push({ _id : made.id, [`flags.${module.id}.until`] : "turnEnd" });
    const poisoned = CONFIG.statusEffects.find(s => s.id === "poisoned");
    const create = made ? [] : [{ _id : this.POISONED_ID, name : game.i18n.localize(poisoned?.name ?? "Poisoned"),
      img : poisoned?.img ?? "icons/svg/poison.svg", statuses : ["poisoned"], transfer : false, flags : { [module.id] : { until : "turnEnd" } } }];
    if(!Object.keys(update).length && !updateEffects.length && !create.length) return null;
    return { update, updateEffects, create : { effects : create } };
  }

  /* The Grapple activity of an Unarmed Strike */
  static grappleOf(item){
    return [...(item?.system?.activities ?? [])].find(a => (a.type === "save") && /grapple/i.test(a.name ?? "")) ?? null;
  }

  /* Punch and Grab : the same Unarmed Strike's Grapple at the creature hit, part of this attack (nothing more spent) */
  static async punchAndGrab(hit){
    const activity = this.grappleOf(hit.item);
    const target = hit.target?.object ?? hit.target;
    if(!activity || !target?.id) return;
    canvas.tokens.setTargets([target.id]);
    return activity.use({ [module.id] : { economy : "free", skipPick : true, useTargets : true } });
  }

  /* War Caster's spells : what it could cast with an Action now (readyChoices), at one creature */
  static reactiveSpells(actor){
    return actionReady.readyChoices(actor).filter(({ value }) => {
      const [itemId, activityId] = value.split(".");
      const item = actor.items.get(itemId);
      const activity = item?.system.activities?.get(activityId);
      if((item?.type !== "spell") || !activity || activity.target?.template?.type) return false;
      const affects = activity.target?.affects ?? {};
      return !["self"].includes(affects.type) && ((Number(affects.count) || 1) === 1) && (activity.range?.units ?? item.system.range?.units) !== "self";
    });
  }

  /* Is the card's attack a melee attack (a thrown dagger isn't) */
  static meleeAttack(message){
    const activity = message?.getAssociatedActivity?.();
    let action = "";
    try { action = String(activity?.getActionType?.(message.system?.mode) ?? ""); } catch {}
    return action ? action.startsWith("m") : ((activity?.attack?.type?.value ?? "melee") === "melee");
  }

  /* Shield Bash : its STR save, then a push or Prone, the attacker's choice */
  static async shieldBash(hit){
    const target = hit.target, feat = hit.feature;
    if(!target || !feat) return;
    const dc = 8 + (Number(hit.actor.system.abilities?.str?.mod) || 0) + (Number(hit.actor.system.attributes?.prof) || 0);
    const save = await rollSave(target, "str", dc, { from : feat });
    if(!save || save.success) return;
    const prone = CONFIG.statusEffects.find(s => s.id === "prone");
    const choice = await chooseOne([
      { value : "push", label : module.i18n("feats.shieldMaster.push"), img : "icons/svg/thrust.svg" },
      { value : "prone", label : game.i18n.localize(prone?.name ?? "Prone"), img : prone?.img ?? "icons/svg/falling.svg" },
    ], { title : feat.name, icon : "fa-solid fa-shield", prompt : module.format("feats.shieldMaster.prompt", { name : target.name }) });
    if(choice === "push") await forcedMove(target, { direction : "away", feet : 5, from : hit.token, item : feat, name : feat.name });
    else if(choice === "prone") await giveCondition(target, "prone", { from : feat, by : hit.token });
  }

  /* Parry : + PB AC against melee attacks until its next turn starts, this hit judged again */
  static async parry(ctx){
    const actor = ctx.guard.actor;
    const feat = this.has(actor, this.DUELIST);
    const prof = Number(actor.system.attributes?.prof) || 0;
    if(!await raiseCardAC(ctx.message, ctx.target, prof, { id : this.DUELIST })) return false;
    await giveEffect(ctx.guard, { name : feat?.name ?? "Parry", system : { changes : [{ key : "system.attributes.ac.bonus", type : "add", value : String(prof) }] },
      flags : { [module.id] : { rule : { acOnlyAgainst : "melee" } } } }, { from : feat, until : "turnStart", of : actor });
  }

  /* Plutonium's by-hand activities for what the cards do (GWM's +PB, Charge Attack, Shield Bash, Parry, Guard Mind, Fast
     Ritual Cast) : hidden, so they aren't used twice */
  static RIDER_ACTIVITIES = ["great-weapon-master", "charger", "shield-master", "defensive-duelist", "polearm-master", "mage-slayer", "ritual-caster", "dual-wielder"];
  static riderActivitiesFix(item){
    if(!this.enabled() || !this.RIDER_ACTIVITIES.includes(idOf(item))) return null;
    const shown = [...(item.system.activities ?? [])].filter(a => a.visibility?.level?.max !== 0);
    if(!shown.length) return null;
    return { update : Object.fromEntries(shown.map(a => [`system.activities.${a.id}.visibility.level.max`, 0])) };
  }

  /* Plutonium's Heavy Armor Master effect (B / P / S damage always less) : off, the rule does it */
  static hamFix(item){
    if(!this.enabled() || (idOf(item) !== this.HAM)) return null;
    const effects = [...(item.effects ?? [])].filter(e => !e.disabled && [...(e.system?.changes ?? e.changes ?? [])].some(c => String(c.key).startsWith("system.traits.dm.amount.")));
    return effects.length ? { updateEffects : effects.map(e => ({ _id : e.id, disabled : true })) } : null;
  }
}
