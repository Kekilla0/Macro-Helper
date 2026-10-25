import { module } from '../module.js';
import { settings } from '../settings.js';
import { idOf } from '../helpers/utils.js';
import { onDamage } from '../roll-item/damage.js';
import { ignoresDisadvantage, ignoresCover, ignoresProperty, ignoresResistance } from './ignores.js';
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

  /* Plutonium's by-hand activities for what the cards do (GWM's +PB, Charge Attack, Shield Bash, Parry) : hidden, so
     they aren't used twice */
  static RIDER_ACTIVITIES = ["great-weapon-master", "charger", "shield-master", "defensive-duelist"];
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
